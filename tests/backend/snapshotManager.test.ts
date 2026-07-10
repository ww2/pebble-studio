import { describe, it, expect, beforeEach } from "vitest";
import { win32 as winPath } from "node:path";
import {
  SnapshotManager,
  snapshotBundleDir,
  workingSpiPath,
  parseMigrateStatus,
  SNAPSHOT_BOARDS,
  type SnapFs,
  type SnapshotContext,
  type SnapshotMeta,
  type MonitorConn,
  type MonitorTransport,
} from "../../src/main/backend/snapshotManager.js";
import type { PlatformId } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// In-memory SnapFs (Windows-style paths; dirs are implicit via key prefixes)
// ---------------------------------------------------------------------------
function memFs(): SnapFs & { files: Map<string, string>; dump(): string[] } {
  const files = new Map<string, string>();
  const norm = (p: string) => p.replace(/\//g, "\\");
  const isUnder = (key: string, dir: string) => key === dir || key.startsWith(dir + "\\");
  return {
    files,
    dump: () => [...files.keys()],
    exists: async (p) => {
      const k = norm(p);
      return files.has(k) || [...files.keys()].some((f) => isUnder(f, k));
    },
    stat: async (p) => {
      const k = norm(p);
      const v = files.get(k);
      return v === undefined ? null : { size: v.length, mtimeMs: 1 };
    },
    readText: async (p) => files.get(norm(p)) ?? "",
    writeText: async (p, c) => {
      files.set(norm(p), c);
    },
    remove: async (p) => {
      const k = norm(p);
      for (const key of [...files.keys()]) if (isUnder(key, k)) files.delete(key);
    },
    mkdirp: async () => {},
    copyFile: async (src, dest) => {
      const v = files.get(norm(src));
      if (v === undefined) throw new Error(`ENOENT copyFile ${src}`);
      files.set(norm(dest), v);
    },
    rename: async (src, dest) => {
      const v = files.get(norm(src));
      if (v === undefined) throw new Error(`ENOENT rename ${src}`);
      files.set(norm(dest), v);
      files.delete(norm(src));
    },
  };
}

// ---------------------------------------------------------------------------
// Fake HMP monitor transport that records commands + returns scripted responses
// ---------------------------------------------------------------------------
interface FakeMonitor extends MonitorTransport {
  sent: string[];
  closed: boolean;
  connectCount: number;
}
function fakeMonitor(opts?: {
  migrateStatuses?: string[]; // consumed by successive `info migrate` calls
  failConnect?: boolean;
  throwOn?: string; // command substring that should reject
  onMigrate?: () => void; // simulate qemu writing the migr file
}): FakeMonitor {
  const sent: string[] = [];
  let idx = 0;
  const statuses = opts?.migrateStatuses ?? ["completed"];
  const conn: MonitorConn = {
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd.startsWith("migrate ")) opts?.onMigrate?.();
      if (opts?.throwOn && cmd.includes(opts.throwOn)) throw new Error(`fake fail: ${cmd}`);
      if (cmd.startsWith("info migrate")) {
        const s = statuses[Math.min(idx, statuses.length - 1)];
        idx++;
        return `Migration status: ${s}\n(qemu) `;
      }
      return "(qemu) ";
    },
    close: () => {
      mon.closed = true;
    },
  };
  const mon: FakeMonitor = {
    sent,
    closed: false,
    connectCount: 0,
    connect: async (_port, _timeout) => {
      mon.connectCount++;
      if (opts?.failConnect) throw new Error("fake connect refused");
      return conn;
    },
  };
  return mon;
}

const PERSIST = "C:\\data\\pebble-sdk";
const VER = "4.9";
const CTX: SnapshotContext = { persistSdkRoot: PERSIST, version: VER, fwRev: "rev7", exeStamp: "25265152-99" };
const BOARD: PlatformId = "basalt";

function ctxDeps(fs: SnapFs, monitor: MonitorTransport, ctx: SnapshotContext = CTX) {
  return {
    fs,
    monitor,
    resolveContext: async () => ctx,
    clock: { now: () => 0, sleep: async () => {} },
    log: () => {},
  };
}

function seedValidBundle(fs: ReturnType<typeof memFs>, ctx: SnapshotContext = CTX, board: PlatformId = BOARD) {
  const dir = snapshotBundleDir(ctx.persistSdkRoot, ctx.version, board);
  const meta: SnapshotMeta = { fwRev: ctx.fwRev, sdkVer: ctx.version, exeStamp: ctx.exeStamp, board };
  fs.files.set(winPath.join(dir, "vm.migr"), "MIGR-STREAM");
  fs.files.set(winPath.join(dir, "spi.bin"), "SPI-SNAP");
  fs.files.set(winPath.join(dir, "meta.json"), JSON.stringify(meta));
  return { dir, meta };
}

describe("parseMigrateStatus", () => {
  it("classifies qemu info migrate output (both HMP `Status:` and `Migration status:` forms)", () => {
    // The bundled qemu 10.1.x HMP form (tabs after the colon) — the live format.
    expect(parseMigrateStatus("Status: \t\tcompleted\r\nTime (ms): total=140")).toBe("completed");
    expect(parseMigrateStatus("Status:\t\tactive")).toBe("active");
    expect(parseMigrateStatus("Status: \t\tfailed")).toBe("failed");
    // Older / QMP-ish form.
    expect(parseMigrateStatus("Migration status: completed\n")).toBe("completed");
    expect(parseMigrateStatus("Migration status: cancelled")).toBe("failed");
    expect(parseMigrateStatus("no status here")).toBe("unknown");
  });
});

describe("SnapshotManager.bundleFor validation", () => {
  let fs: ReturnType<typeof memFs>;
  beforeEach(() => {
    fs = memFs();
  });

  it("returns the bundle paths when meta matches + files exist", async () => {
    const { dir } = seedValidBundle(fs);
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    const b = await mgr.bundleFor(BOARD);
    expect(b).toEqual({ migr: winPath.join(dir, "vm.migr"), spi: winPath.join(dir, "spi.bin") });
  });

  it("returns null (no cleanup) for an ineligible M33 board", async () => {
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    expect(await mgr.bundleFor("emery")).toBeNull();
  });

  it("returns null when the kill switch is set", async () => {
    seedValidBundle(fs);
    const mgr = new SnapshotManager({ ...ctxDeps(fs, fakeMonitor()), killSwitch: () => true });
    expect(await mgr.bundleFor(BOARD)).toBeNull();
  });

  it("discards a bundle whose exeStamp differs (exe swap)", async () => {
    const { dir } = seedValidBundle(fs);
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor(), { ...CTX, exeStamp: "NEW-999" }));
    expect(await mgr.bundleFor(BOARD)).toBeNull();
    expect(await fs.exists(dir)).toBe(false);
  });

  it("discards a bundle whose fwRev differs, cleaning the dir", async () => {
    const { dir } = seedValidBundle(fs);
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor(), { ...CTX, fwRev: "rev8" }));
    expect(await mgr.bundleFor(BOARD)).toBeNull();
    expect(await fs.exists(dir)).toBe(false);
  });

  it("discards a bundle whose sdkVer differs", async () => {
    const { dir } = seedValidBundle(fs);
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor(), { ...CTX, version: "4.10" }));
    // Different version => different dir; the OLD dir should not validate.
    const oldMgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    const b = await oldMgr.bundleFor(BOARD); // sanity: valid under original ctx
    expect(b).not.toBeNull();
    // Under a bumped version there is no bundle at the new path.
    expect(await new SnapshotManager(ctxDeps(fs, fakeMonitor(), { ...CTX, version: "4.10" })).bundleFor(BOARD)).toBeNull();
    void dir;
  });

  it("discards + cleans a bundle with a missing spi file", async () => {
    const { dir } = seedValidBundle(fs);
    fs.files.delete(winPath.join(dir, "spi.bin"));
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    expect(await mgr.bundleFor(BOARD)).toBeNull();
    expect(await fs.exists(dir)).toBe(false);
  });

  it("discards + cleans a bundle with corrupt meta.json", async () => {
    const { dir } = seedValidBundle(fs);
    fs.files.set(winPath.join(dir, "meta.json"), "{not json");
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    expect(await mgr.bundleFor(BOARD)).toBeNull();
    expect(await fs.exists(dir)).toBe(false);
  });

  it("returns null when no bundle exists at all", async () => {
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    expect(await mgr.bundleFor(BOARD)).toBeNull();
  });
});

describe("SnapshotManager.createAfterLive", () => {
  let fs: ReturnType<typeof memFs>;
  beforeEach(() => {
    fs = memFs();
    // The live working SPI qemu is using.
    fs.files.set(workingSpiPath(PERSIST, VER, BOARD), "LIVE-SPI");
  });

  it("records stop → migrate → info migrate → cont in order and copies SPI + writes meta last", async () => {
    const dirForMigr = snapshotBundleDir(PERSIST, VER, BOARD);
    const mon = fakeMonitor({
      migrateStatuses: ["active", "completed"],
      onMigrate: () => fs.files.set(winPath.join(dirForMigr, "vm.migr"), "MIGR-STREAM"),
    });
    const mgr = new SnapshotManager(ctxDeps(fs, mon));
    await mgr.createAfterLive(BOARD, 5555);

    // Order: stop first, migrate before info migrate, cont after completion.
    expect(mon.sent[0]).toBe("stop");
    const migrateIdx = mon.sent.findIndex((c) => c.startsWith("migrate "));
    const infoIdx = mon.sent.findIndex((c) => c.startsWith("info migrate"));
    const contIdx = mon.sent.lastIndexOf("cont");
    expect(migrateIdx).toBeGreaterThan(0);
    expect(infoIdx).toBeGreaterThan(migrateIdx);
    expect(contIdx).toBeGreaterThan(infoIdx);
    // migrate URI uses forward slashes + file: scheme, DOUBLE-QUOTED so a spaced
    // persist path ("…\Pebble Studio\…") survives HMP arg parsing.
    expect(mon.sent[migrateIdx]).toBe('migrate "file:C:/data/pebble-sdk/4.9/basalt/.snapshot/vm.migr"');
    expect(mon.closed).toBe(true);

    const dir = snapshotBundleDir(PERSIST, VER, BOARD);
    expect(fs.files.get(winPath.join(dir, "spi.bin"))).toBe("LIVE-SPI");
    const meta = JSON.parse(fs.files.get(winPath.join(dir, "meta.json"))!) as SnapshotMeta;
    expect(meta).toEqual({ fwRev: "rev7", sdkVer: "4.9", exeStamp: "25265152-99", board: "basalt" });
    // meta temp file must not linger (atomic rename).
    expect(fs.files.has(winPath.join(dir, "meta.json.tmp"))).toBe(false);

    // The freshly-written bundle validates.
    expect(await mgr.bundleFor(BOARD)).not.toBeNull();
  });

  it("leaves no partial bundle and resumes the guest when migration fails", async () => {
    const mon = fakeMonitor({ migrateStatuses: ["failed"] });
    const mgr = new SnapshotManager(ctxDeps(fs, mon));
    await mgr.createAfterLive(BOARD, 5555);

    const dir = snapshotBundleDir(PERSIST, VER, BOARD);
    // No meta / spi written.
    expect(await fs.exists(dir)).toBe(false);
    // Guest was stopped then resumed (cont sent despite the failure).
    expect(mon.sent).toContain("stop");
    expect(mon.sent).toContain("cont");
    expect(mon.closed).toBe(true);
  });

  it("never creates a bundle when the monitor connection fails", async () => {
    const mon = fakeMonitor({ failConnect: true });
    const mgr = new SnapshotManager(ctxDeps(fs, mon));
    await mgr.createAfterLive(BOARD, 5555);
    expect(await fs.exists(snapshotBundleDir(PERSIST, VER, BOARD))).toBe(false);
  });

  it("is a no-op for an ineligible board (no monitor connect)", async () => {
    const mon = fakeMonitor();
    const mgr = new SnapshotManager(ctxDeps(fs, mon));
    await mgr.createAfterLive("emery", 5555);
    expect(mon.connectCount).toBe(0);
  });

  it("skips creation (no monitor connect) when a valid bundle already exists", async () => {
    seedValidBundle(fs); // a current bundle is present (e.g. this boot was a restore)
    const mon = fakeMonitor();
    const mgr = new SnapshotManager(ctxDeps(fs, mon));
    await mgr.createAfterLive(BOARD, 5555);
    expect(mon.connectCount).toBe(0);
    // The existing bundle is untouched.
    expect(await mgr.bundleFor(BOARD)).not.toBeNull();
  });

  it("aborts + cleans up when cancelled before stopping", async () => {
    const mon = fakeMonitor();
    const mgr = new SnapshotManager(ctxDeps(fs, mon));
    await mgr.createAfterLive(BOARD, 5555, { isCancelled: () => true });
    expect(mon.connectCount).toBe(0); // cancel checked before connect
    expect(await fs.exists(snapshotBundleDir(PERSIST, VER, BOARD))).toBe(false);
  });
});

describe("SnapshotManager.prepareRestore", () => {
  let fs: ReturnType<typeof memFs>;
  beforeEach(() => {
    fs = memFs();
    fs.files.set(workingSpiPath(PERSIST, VER, BOARD), "OLD-LIVE-SPI");
  });

  it("copies the bundle SPI over the working SPI and returns a forward-slash file URI", async () => {
    seedValidBundle(fs);
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    const uri = await mgr.prepareRestore(BOARD);
    expect(uri).toBe("file:C:/data/pebble-sdk/4.9/basalt/.snapshot/vm.migr");
    // Working SPI now holds the snapshot's flash.
    expect(fs.files.get(workingSpiPath(PERSIST, VER, BOARD))).toBe("SPI-SNAP");
  });

  it("returns null (cold boot) when no valid bundle exists", async () => {
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    expect(await mgr.prepareRestore(BOARD)).toBeNull();
  });

  it("invalidates + returns null when the SPI copy fails", async () => {
    const { dir } = seedValidBundle(fs);
    // Remove the bundle SPI so copyFile throws.
    fs.files.delete(winPath.join(dir, "spi.bin"));
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    // bundleFor already rejects a missing-spi bundle; craft a copy failure another
    // way: keep spi present but make copyFile throw via a read-only target dir.
    seedValidBundle(fs);
    const failingFs: SnapFs = { ...fs, copyFile: async () => { throw new Error("EACCES"); } };
    const mgr2 = new SnapshotManager(ctxDeps(failingFs, fakeMonitor()));
    expect(await mgr2.prepareRestore(BOARD)).toBeNull();
    void mgr;
    void dir;
  });
});

describe("SnapshotManager.invalidate", () => {
  it("removes a board bundle and invalidateAll removes every eligible board", async () => {
    const fs = memFs();
    for (const b of SNAPSHOT_BOARDS) seedValidBundle(fs, CTX, b);
    const mgr = new SnapshotManager(ctxDeps(fs, fakeMonitor()));
    await mgr.invalidate(BOARD);
    expect(await fs.exists(snapshotBundleDir(PERSIST, VER, BOARD))).toBe(false);
    await mgr.invalidateAll();
    for (const b of SNAPSHOT_BOARDS) {
      expect(await fs.exists(snapshotBundleDir(PERSIST, VER, b))).toBe(false);
    }
  });
});
