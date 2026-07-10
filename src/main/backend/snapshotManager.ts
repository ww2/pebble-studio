/**
 * snapshotManager.ts — per-board QEMU snapshot bundles for instant cold launches
 * (native-Windows track, Tasks 6+7).
 *
 * The patched bundled qemu-pebble.exe can save its whole VM state (RAM + device
 * vmstate) to a migration stream in ~0.15s and restore it with `-incoming` so a
 * board comes up already-booted and painted (~0.5s) instead of running the full
 * firmware cold boot (many seconds). This manager owns the lifecycle of those
 * snapshot bundles:
 *
 *   bundle = <persist>\pebble-sdk\<ver>\<board>\.snapshot\
 *              vm.migr    — the qemu migration stream (RAM + device vmstate)
 *              spi.bin    — a copy of the decompressed SPI flash AS AT SNAPSHOT TIME
 *              meta.json  — { fwRev, sdkVer, exeStamp, board } (written LAST, atomically)
 *
 * A bundle is only usable when its meta matches the CURRENT firmware revision, SDK
 * version, and emulator exe stamp — snapshot streams carry qemu-version-specific
 * vmstate sections, so an exe swap (new build) or a firmware/SDK change must
 * discard the stream (an old stream fails the `-incoming` load cleanly, but we
 * never even try it if the stamp differs). All I/O goes through an injected
 * {@link SnapFs} / {@link MonitorTransport} so the logic is unit-tested with no
 * disk, no sockets, and no real qemu.
 *
 * Safety contract:
 *  - Gated by board: only {@link SNAPSHOT_BOARDS} (the STM32 family, whose device
 *    vmstate is proven to restore) ever get a bundle. Adding an M33 board later is
 *    a one-line change to that set.
 *  - Kill switch: PEBBLE_STUDIO_NO_SNAPSHOT=1 makes every entry point a no-op.
 *  - Creation NEVER throws to its caller and always cleans up a partial bundle.
 *  - Restore is transparent: a missing/stale/corrupt bundle => cold boot, and a
 *    failed restore boot invalidates the bundle and cold-retries within the
 *    existing boot retry budget. The cold path pays only one `stat` (bundleFor).
 */

import { win32 as winPath } from "node:path";
import {
  stat as fsStat,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  copyFile as fsCopyFile,
  rename as fsRename,
  rm as fsRm,
} from "node:fs/promises";
import { connect as netConnect } from "node:net";
import type { PlatformId } from "../../shared/types.js";

/**
 * Boards eligible for snapshot restore. Initially the STM32 (Cortex-M4/M3) family
 * — aplite/basalt/chalk/diorite — whose peripheral + TIM vmstate the patched exe
 * saves/restores correctly (proven live on basalt; the others share the same
 * device models). The Cortex-M33 boards (emery/gabbro/flint) are excluded until
 * their restore paints reliably; adding one here is the only change needed.
 */
export const SNAPSHOT_BOARDS: ReadonlySet<PlatformId> = new Set<PlatformId>([
  "aplite",
  "basalt",
  "chalk",
  "diorite",
]);

/** The env kill-switch checked at every creation/restore entry point. */
export const SNAPSHOT_KILL_SWITCH_ENV = "PEBBLE_STUDIO_NO_SNAPSHOT";

/** Directory + file layout inside a per-board bundle. */
const SNAPSHOT_DIRNAME = ".snapshot";
const MIGR_NAME = "vm.migr";
const SPI_NAME = "spi.bin";
const META_NAME = "meta.json";
/** The decompressed SPI flash file pebble-tool hands qemu (per board/version). */
const WORKING_SPI_NAME = "qemu_spi_flash.bin";

/** Bounds (ms). Every monitor/socket op is bounded so a wedged qemu can't hang. */
const CONNECT_TIMEOUT_MS = 4000;
const MIGRATE_TIMEOUT_MS = 30_000;
const MIGRATE_POLL_TIMEOUT_MS = 30_000;
const MIGRATE_POLL_INTERVAL_MS = 100;

/** meta.json contents — the identity a bundle is validated against. */
export interface SnapshotMeta {
  fwRev: string;
  sdkVer: string;
  exeStamp: string;
  board: PlatformId;
}

/** A validated bundle's on-disk file paths. */
export interface SnapshotBundle {
  migr: string;
  spi: string;
}

/** The current runtime identity a bundle must match to be usable. */
export interface SnapshotContext {
  /** `<userData>\pebble-data\pebble-sdk` — pebble-tool's get_persist_dir(). */
  persistSdkRoot: string;
  /** Current SDK version dir under persistSdkRoot (e.g. "4.9"). */
  version: string;
  /** Current firmware revision (sdk-core `.fw-rev` content; "" when unversioned). */
  fwRev: string;
  /** Stamp identifying the current emulator exe (size+mtime); keys the stream. */
  exeStamp: string;
}

/**
 * Minimal fs surface (injected so the manager is unit-testable with no disk).
 * All methods must be safe to call on absent paths where noted.
 */
export interface SnapFs {
  /** True if the path exists. */
  exists(p: string): Promise<boolean>;
  /** stat → {size, mtimeMs}, or null when missing/unreadable. */
  stat(p: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** Read a text file; resolve "" if missing. */
  readText(p: string): Promise<string>;
  /** Write a text file (parent dir must exist). */
  writeText(p: string, content: string): Promise<void>;
  /** Recursively remove a file/dir; a no-op when absent. */
  remove(p: string): Promise<void>;
  /** mkdir -p. */
  mkdirp(p: string): Promise<void>;
  /** Copy a single file (src → dest); parent of dest must exist. */
  copyFile(src: string, dest: string): Promise<void>;
  /** Rename (atomic on the same volume) — used for the meta temp→final swap. */
  rename(src: string, dest: string): Promise<void>;
}

/** A live HMP monitor connection (text protocol over the qemu -monitor TCP port). */
export interface MonitorConn {
  /** Send one HMP command line; resolve the response text (up to the next prompt). */
  send(cmd: string, timeoutMs?: number): Promise<string>;
  /** Close the socket. */
  close(): void;
}

/** Opens a {@link MonitorConn} to a qemu HMP monitor port. */
export interface MonitorTransport {
  connect(port: number, timeoutMs: number): Promise<MonitorConn>;
}

export interface SnapshotDeps {
  fs: SnapFs;
  monitor: MonitorTransport;
  /** Resolve the current runtime identity (provision-aware; may be async/cached). */
  resolveContext: () => Promise<SnapshotContext>;
  /** Diagnostic log sink (never surfaced to the user). */
  log?: (msg: string) => void;
  /** Kill-switch predicate; defaults to reading PEBBLE_STUDIO_NO_SNAPSHOT. */
  killSwitch?: () => boolean;
  /** Injected clock for the migrate poll (tests pass a no-wait sleep). */
  clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
}

/** Options for a single snapshot creation. */
export interface CreateOpts {
  /** Abort creation promptly if this returns true (a stop/switch happened). */
  isCancelled?: () => boolean;
}

/** The bundle directory for a board under a given persist root + version. PURE. */
export function snapshotBundleDir(persistSdkRoot: string, version: string, board: string): string {
  return winPath.join(persistSdkRoot, version, board, SNAPSHOT_DIRNAME);
}

/** The decompressed working SPI flash path qemu opens for a board. PURE. */
export function workingSpiPath(persistSdkRoot: string, version: string, board: string): string {
  return winPath.join(persistSdkRoot, version, board, WORKING_SPI_NAME);
}

/**
 * Parse HMP `info migrate` output → a coarse status. The bundled qemu (10.1.x)
 * prints `Status:\t\tcompleted`; older/QMP forms print `Migration status: completed`.
 * Accept BOTH (anchored to a line start so it can't match unrelated text).
 */
export function parseMigrateStatus(text: string): "completed" | "failed" | "active" | "unknown" {
  const m = /(?:^|\n)\s*(?:Migration status|Status):\s*(\S+)/i.exec(text);
  const s = m?.[1]?.toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed" || s === "cancelled" || s === "canceled") return "failed";
  if (s === "active" || s === "setup" || s === "device" || s === "pending") return "active";
  return "unknown";
}

/** Thrown internally to unwind a cancelled creation (caught + cleaned up). */
class SnapshotCancelled extends Error {
  constructor() {
    super("snapshot creation cancelled");
    this.name = "SnapshotCancelled";
  }
}

export class SnapshotManager {
  constructor(private readonly deps: SnapshotDeps) {}

  private log(msg: string): void {
    try {
      this.deps.log?.(msg);
    } catch {
      /* logging must never throw */
    }
  }

  private killed(): boolean {
    const ks = this.deps.killSwitch ?? (() => process.env[SNAPSHOT_KILL_SWITCH_ENV] === "1");
    try {
      return ks();
    } catch {
      return false;
    }
  }

  private eligible(board: PlatformId): boolean {
    return SNAPSHOT_BOARDS.has(board) && !this.killed();
  }

  private paths(ctx: SnapshotContext, board: PlatformId) {
    const dir = snapshotBundleDir(ctx.persistSdkRoot, ctx.version, board);
    return {
      dir,
      migr: winPath.join(dir, MIGR_NAME),
      spi: winPath.join(dir, SPI_NAME),
      meta: winPath.join(dir, META_NAME),
      metaTmp: winPath.join(dir, META_NAME + ".tmp"),
      workingSpi: workingSpiPath(ctx.persistSdkRoot, ctx.version, board),
    };
  }

  /**
   * Validate + return the usable bundle for a board, or null. A present-but-stale
   * or corrupt bundle (meta mismatch, unparseable meta, or a missing migr/spi) is
   * DELETED as a side effect so it can't be tried again. The cold path pays only
   * this validation (a few stats) when no bundle exists.
   */
  async bundleFor(board: PlatformId): Promise<SnapshotBundle | null> {
    if (!this.eligible(board)) return null;
    let ctx: SnapshotContext;
    try {
      ctx = await this.deps.resolveContext();
    } catch (e) {
      this.log(`[snapshot] context resolve failed: ${String(e)}`);
      return null;
    }
    const p = this.paths(ctx, board);

    const rawMeta = await this.deps.fs.readText(p.meta);
    if (!rawMeta) {
      // No meta = no (complete) bundle. Clean up any stray partial dir.
      if (await this.deps.fs.exists(p.dir)) await this.remove(p.dir);
      return null;
    }
    let meta: SnapshotMeta;
    try {
      meta = JSON.parse(rawMeta) as SnapshotMeta;
    } catch {
      this.log(`[snapshot] ${board}: corrupt meta.json — discarding bundle`);
      await this.remove(p.dir);
      return null;
    }
    const mismatch =
      meta.board !== board ||
      meta.fwRev !== ctx.fwRev ||
      meta.sdkVer !== ctx.version ||
      meta.exeStamp !== ctx.exeStamp;
    if (mismatch) {
      this.log(
        `[snapshot] ${board}: stale bundle (meta fw=${meta.fwRev}/sdk=${meta.sdkVer}/exe=${meta.exeStamp} ` +
          `vs fw=${ctx.fwRev}/sdk=${ctx.version}/exe=${ctx.exeStamp}) — discarding`,
      );
      await this.remove(p.dir);
      return null;
    }
    const [haveMigr, haveSpi] = await Promise.all([
      this.deps.fs.exists(p.migr),
      this.deps.fs.exists(p.spi),
    ]);
    if (!haveMigr || !haveSpi) {
      this.log(`[snapshot] ${board}: bundle missing ${!haveMigr ? "migr" : "spi"} — discarding`);
      await this.remove(p.dir);
      return null;
    }
    return { migr: p.migr, spi: p.spi };
  }

  /**
   * Prepare a restore for a board: copy the bundle's SPI over the working SPI (so
   * qemu's restored RAM matches its flash), and return the `-incoming` migration
   * URI (`file:` + forward-slash migr path) to hand the boot spawn. Returns null
   * when no valid bundle exists or the SPI copy fails (bundle invalidated) — the
   * caller then cold-boots.
   */
  async prepareRestore(board: PlatformId): Promise<string | null> {
    const bundle = await this.bundleFor(board);
    if (!bundle) return null;
    let ctx: SnapshotContext;
    try {
      ctx = await this.deps.resolveContext();
    } catch (e) {
      this.log(`[snapshot] ${board}: context resolve failed on restore: ${String(e)}`);
      return null;
    }
    const p = this.paths(ctx, board);
    try {
      await this.deps.fs.copyFile(bundle.spi, p.workingSpi);
    } catch (e) {
      this.log(`[snapshot] ${board}: SPI restore-copy failed (${String(e)}) — cold boot`);
      await this.invalidate(board);
      return null;
    }
    return `file:${bundle.migr.replace(/\\/g, "/")}`;
  }

  /**
   * Create a bundle AFTER the emulator has reached Live (cold boot only). Drives
   * the qemu HMP monitor: stop → migrate to file → poll info migrate → cont, then
   * copies the working SPI and writes meta.json LAST (atomic temp+rename). NEVER
   * throws; any failure or cancellation deletes the partial bundle. If the guest
   * was paused (`stop` succeeded) it is ALWAYS resumed, even on failure.
   */
  async createAfterLive(board: PlatformId, monitorPort: number, opts: CreateOpts = {}): Promise<void> {
    if (!this.eligible(board)) return;
    const isCancelled = opts.isCancelled ?? (() => false);
    if (isCancelled()) return;

    // One capture per identity: if a valid current bundle already exists (e.g. this
    // boot WAS a restore, or a snapshot was already made this session), skip — no
    // need to pause the guest to re-save the same state. bundleFor also self-cleans
    // a stale bundle, so after an invalidation the next cold boot recaptures.
    if (await this.bundleFor(board)) {
      this.log(`[snapshot] ${board}: current bundle already exists — skipping creation`);
      return;
    }

    let ctx: SnapshotContext;
    try {
      ctx = await this.deps.resolveContext();
    } catch (e) {
      this.log(`[snapshot] ${board}: context resolve failed on create: ${String(e)}`);
      return;
    }
    const p = this.paths(ctx, board);
    const checkCancel = (): void => {
      if (isCancelled()) throw new SnapshotCancelled();
    };

    let conn: MonitorConn | null = null;
    try {
      checkCancel();
      // Start clean: a prior partial/stale bundle must not shadow this one.
      await this.remove(p.dir);
      await this.deps.fs.mkdirp(p.dir);

      conn = await this.deps.monitor.connect(monitorPort, CONNECT_TIMEOUT_MS);

      let paused = false;
      try {
        checkCancel();
        await conn.send("stop");
        paused = true;
        checkCancel();
        // Forward-slash file: URI — the O_BINARY-patched exe opens it on Windows.
        // DOUBLE-QUOTE it: the persist path lives under userData ("…\Pebble Studio\
        // …"), and HMP's unquoted string arg stops at the first space; qemu's
        // get_str() unquotes, so the spaced path survives (verified live).
        const uri = `file:${p.migr.replace(/\\/g, "/")}`;
        await conn.send(`migrate "${uri}"`, MIGRATE_TIMEOUT_MS);
        await this.pollMigrate(conn, isCancelled);
        checkCancel();
        await conn.send("cont");
        paused = false;
      } finally {
        // If we stopped the guest but didn't reach `cont`, resume it now so a
        // failed snapshot never leaves the watch frozen.
        if (paused) {
          try {
            await conn.send("cont");
          } catch {
            /* best-effort resume */
          }
        }
      }

      // Copy the decompressed SPI flash as it is now (proven-consistent ordering).
      await this.deps.fs.copyFile(p.workingSpi, p.spi);

      // meta.json LAST, atomically: a crash before the rename leaves NO meta, so
      // bundleFor rejects (and cleans) the partial bundle rather than trusting it.
      const meta: SnapshotMeta = {
        fwRev: ctx.fwRev,
        sdkVer: ctx.version,
        exeStamp: ctx.exeStamp,
        board,
      };
      await this.deps.fs.writeText(p.metaTmp, JSON.stringify(meta, null, 2));
      await this.deps.fs.rename(p.metaTmp, p.meta);
      this.log(`[snapshot] ${board}: bundle created`);
    } catch (e) {
      if (!(e instanceof SnapshotCancelled)) {
        this.log(`[snapshot] ${board}: creation failed (${String(e)}) — cleaning up`);
      }
      await this.remove(p.dir);
    } finally {
      conn?.close();
    }
  }

  /** Poll HMP `info migrate` until the migration completes; throw on fail/timeout. */
  private async pollMigrate(conn: MonitorConn, isCancelled: () => boolean): Promise<void> {
    const now = this.deps.clock?.now ?? (() => Date.now());
    const sleep = this.deps.clock?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + MIGRATE_POLL_TIMEOUT_MS;
    for (;;) {
      if (isCancelled()) throw new SnapshotCancelled();
      const out = await conn.send("info migrate");
      const status = parseMigrateStatus(out);
      if (status === "completed") return;
      if (status === "failed") throw new Error("qemu reported migration failed");
      if (now() >= deadline) throw new Error("migration did not complete within bound");
      await sleep(MIGRATE_POLL_INTERVAL_MS);
    }
  }

  /** Delete a board's bundle (fw-rev change, SDK swap, wipe, failed restore). */
  async invalidate(board: PlatformId): Promise<void> {
    let ctx: SnapshotContext;
    try {
      ctx = await this.deps.resolveContext();
    } catch {
      return; // can't resolve paths → nothing we can safely delete
    }
    await this.remove(snapshotBundleDir(ctx.persistSdkRoot, ctx.version, board));
  }

  /** Delete every eligible board's bundle for the current context. */
  async invalidateAll(): Promise<void> {
    let ctx: SnapshotContext;
    try {
      ctx = await this.deps.resolveContext();
    } catch {
      return;
    }
    for (const board of SNAPSHOT_BOARDS) {
      await this.remove(snapshotBundleDir(ctx.persistSdkRoot, ctx.version, board));
    }
  }

  private async remove(p: string): Promise<void> {
    try {
      await this.deps.fs.remove(p);
    } catch (e) {
      this.log(`[snapshot] remove(${p}) failed: ${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Production implementations (node fs + a raw HMP TCP transport)
// ---------------------------------------------------------------------------

/** Real node-fs implementation of {@link SnapFs}. */
export function realSnapFs(): SnapFs {
  return {
    exists: async (p) => {
      try {
        await fsStat(p);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (p) => {
      try {
        const s = await fsStat(p);
        return { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
    readText: async (p) => fsReadFile(p, "utf8").catch(() => ""),
    writeText: async (p, content) => {
      await fsWriteFile(p, content);
    },
    remove: async (p) => {
      await fsRm(p, { recursive: true, force: true }).catch(() => {});
    },
    mkdirp: async (p) => {
      await fsMkdir(p, { recursive: true });
    },
    copyFile: async (src, dest) => {
      await fsCopyFile(src, dest);
    },
    rename: async (src, dest) => {
      await fsRename(src, dest);
    },
  };
}

/**
 * Real HMP monitor transport: a raw TCP client for qemu's `-monitor tcp:...` port
 * (text/HMP, the same port backlight.ts sends `sendkey left` to). On connect qemu
 * emits a greeting ending in the `(qemu) ` prompt; each command's response ends
 * with a fresh prompt. `send` writes one line and resolves the text collected
 * until the next prompt (or the timeout).
 */
export function realMonitorTransport(): MonitorTransport {
  return {
    connect: (port, timeoutMs) =>
      new Promise<MonitorConn>((resolve, reject) => {
        const sock = netConnect({ host: "127.0.0.1", port });
        let buf = "";
        let waiter: { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
        let greeted = false;

        const prompt = /\(qemu\)\s*$/;

        const failWaiter = (e: Error): void => {
          if (waiter) {
            clearTimeout(waiter.timer);
            const w = waiter;
            waiter = null;
            w.reject(e);
          }
        };

        sock.setTimeout(timeoutMs);
        sock.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          if (!greeted) {
            // Drain the connect greeting up to and including the first prompt.
            if (prompt.test(buf)) {
              greeted = true;
              buf = "";
              resolve(makeConn());
            }
            return;
          }
          if (waiter && prompt.test(buf)) {
            const out = buf;
            buf = "";
            clearTimeout(waiter.timer);
            const w = waiter;
            waiter = null;
            w.resolve(out);
          }
        });
        sock.once("error", (e) => {
          failWaiter(e as Error);
          if (!greeted) reject(e as Error);
        });
        sock.once("timeout", () => {
          const e = new Error("monitor socket timeout");
          failWaiter(e);
          if (!greeted) {
            sock.destroy();
            reject(e);
          }
        });

        function makeConn(): MonitorConn {
          return {
            send: (cmd, cmdTimeoutMs = CONNECT_TIMEOUT_MS) =>
              new Promise<string>((res, rej) => {
                if (waiter) {
                  rej(new Error("monitor busy (overlapping send)"));
                  return;
                }
                buf = "";
                const timer = setTimeout(() => {
                  if (waiter) {
                    waiter = null;
                    rej(new Error(`monitor command timed out: ${cmd}`));
                  }
                }, cmdTimeoutMs);
                waiter = { resolve: res, reject: rej, timer };
                sock.write(cmd.endsWith("\n") ? cmd : cmd + "\n");
              }),
            close: () => {
              try {
                sock.destroy();
              } catch {
                /* ignore */
              }
            },
          };
        }
      }),
  };
}
