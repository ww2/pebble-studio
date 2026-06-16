/**
 * winInputChannel.ts — a PERSISTENT input channel for the windows-native driver.
 *
 * WHY THIS EXISTS (input-latency fix): the old path ran a full
 * `pebble emu-button …` process for EVERY button press — each press paid a fresh
 * bundled-python interpreter startup + pebble-tool init + websocket connect to
 * pypkjs (300–700ms on Windows), so the emulator felt sluggish and laggy.
 *
 * Instead we keep ONE long-lived python helper (pb-input-helper.py) connected to
 * the running emulator's pypkjs websocket and feed it one-line commands over
 * stdin (`click select`, `hold up`, `release`, `tap x+`). Sending a press is then
 * a pipe write (~0ms) rather than a process spawn. The helper sends the SAME
 * `QemuButton`/`QemuTap` relay packet `pebble emu-button` would, so behavior is
 * identical — only the latency changes.
 *
 * The channel is keyed on the pypkjs port (read from the emulator state file): a
 * reboot/auto-relaunch assigns a new port, which `ensure()` detects and respawns
 * the helper against. If anything fails, callers fall back to the per-press CLI.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** Paths needed to launch the helper: the bundled python and the deployed script. */
export interface InputHelperPaths {
  pythonExe: string;
  helperPath: string;
}

/** Default timeout (ms) for a framebuffer screenshot before the channel gives up
 * and the caller falls back to the canvas grab. Sized comfortably above the
 * helper's own 8s grab watchdog so the helper's `ERR timed out` wins the race
 * (a clean failure) rather than this outer cutoff firing first. */
const SCREENSHOT_TIMEOUT_MS = 10_000;

/** Minimal child surface the channel needs (injectable for tests). */
export interface InputChild {
  /** Write a line (already newline-terminated) to the helper's stdin. */
  stdinWrite(line: string): void;
  /** Force-terminate the helper. */
  kill(): void;
  /** Whether the helper is still running. */
  alive(): boolean;
  /** Subscribe to the helper's stdout, delivered as whole newline-terminated
   * lines. Used ONLY by the framebuffer screenshot path to resolve `OK`/`ERR`
   * acks; the input path never reads stdout (it stays fire-and-forget). Optional
   * so existing test fakes that only drive input need not implement it. */
  onLine?(cb: (line: string) => void): void;
}

export interface WinInputChannelDeps {
  helper: InputHelperPaths;
  /** Current pypkjs port from the emulator state file, or null if not booted. */
  readPort: () => number | null;
  /** Spawn the helper child. Defaults to a real detached-stdin node spawn. */
  spawnChild?: (pythonExe: string, args: string[]) => InputChild;
}

function defaultSpawnChild(pythonExe: string, args: string[]): InputChild {
  // windowsHide so the helper never flashes a console; stdin piped. stdout is
  // piped (not ignored) so the framebuffer screenshot path can read `OK`/`ERR`
  // acks — input remains fire-and-forget regardless. stderr stays ignored.
  const c = nodeSpawn(pythonExe, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let dead = false;
  c.on("error", () => { dead = true; });
  c.on("exit", () => { dead = true; });
  return {
    stdinWrite: (line) => { c.stdin?.write(line); },
    kill: () => { try { c.kill(); } catch { /* already gone */ } },
    alive: () => !dead && c.exitCode === null && !c.killed,
    onLine: (cb) => {
      let buf = "";
      c.stdout?.setEncoding("utf8");
      c.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          cb(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      });
    },
  };
}

export class WinInputChannel {
  private child: InputChild | null = null;
  private port: number | null = null;
  private readonly spawnChild: (pythonExe: string, args: string[]) => InputChild;
  /** Resolver for an in-flight screenshot request, set while one is pending. The
   * helper emits exactly one `OK`/`ERR` line per `screenshot` command, so a
   * single pending slot suffices (the screenshot button can't fire concurrently). */
  private pendingShot: ((ok: boolean) => void) | null = null;

  constructor(private readonly deps: WinInputChannelDeps) {
    this.spawnChild = deps.spawnChild ?? defaultSpawnChild;
  }

  /** Ensure a live helper exists for the CURRENT pypkjs port; (re)spawn if needed. */
  private ensure(): boolean {
    const port = this.deps.readPort();
    if (port == null) return false; // not booted yet → caller falls back to CLI
    if (this.child && this.child.alive() && this.port === port) return true;
    // Port changed (reboot) or the helper died — replace it.
    this.stop();
    this.child = this.spawnChild(this.deps.helper.pythonExe, [this.deps.helper.helperPath, String(port)]);
    this.port = port;
    // Wire stdout acks for the framebuffer screenshot path. The input path never
    // reads stdout, so this never affects button/tap latency. The `ready` line
    // and any stray output are ignored; only `OK`/`ERR` resolve a pending shot.
    this.child.onLine?.((line) => {
      const tok = line.trim().split(/\s+/, 1)[0];
      if (tok === "OK" || tok === "ERR") this.resolveShot(tok === "OK");
    });
    return true;
  }

  /** Resolve the in-flight screenshot request (if any) and clear the slot. */
  private resolveShot(ok: boolean): void {
    const r = this.pendingShot;
    this.pendingShot = null;
    if (r) r(ok);
  }

  /**
   * Take a BACKLIGHT-FREE framebuffer screenshot via the persistent helper,
   * writing a PNG to `outPath`. Resolves true when the helper acks `OK`, false on
   * `ERR`, timeout, or an unavailable channel (caller falls back to the VNC-canvas
   * grab). Robust by design: any failure resolves false rather than throwing.
   *
   * NOTE: the underlying framebuffer grab is UNVERIFIED LIVE — see winHelpers.ts.
   */
  screenshot(outPath: string, timeoutMs = SCREENSHOT_TIMEOUT_MS): Promise<boolean> {
    if (!this.ensure() || !this.child || !this.child.onLine) return Promise.resolve(false);
    // Only one screenshot in flight at a time; if somehow one is pending, fail
    // the new request fast rather than racing two acks onto one slot.
    if (this.pendingShot) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        // Helper didn't ack in time — clear the slot and fall back.
        if (this.pendingShot === settle) this.pendingShot = null;
        finish(false);
      }, timeoutMs);
      const settle = (ok: boolean): void => finish(ok);
      this.pendingShot = settle;
      try {
        this.child!.stdinWrite(`screenshot ${outPath}\n`);
      } catch {
        // Broken pipe — drop the child so the next op respawns it, and fall back.
        this.child = null;
        this.port = null;
        if (this.pendingShot === settle) this.pendingShot = null;
        finish(false);
      }
    });
  }

  /**
   * Send one helper command (without a trailing newline). Returns true if it was
   * written to a live helper; false if the channel is unavailable (caller should
   * fall back to the per-press CLI path).
   */
  send(line: string): boolean {
    if (!this.ensure() || !this.child) return false;
    try {
      this.child.stdinWrite(line + "\n");
      return true;
    } catch {
      // Broken pipe — drop the child so the next send respawns it.
      this.child = null;
      this.port = null;
      return false;
    }
  }

  /** Terminate the helper (called on emulator stop). Idempotent. */
  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.port = null;
    // Fail any in-flight screenshot so its promise can't hang past teardown.
    this.resolveShot(false);
  }
}

/**
 * Read the pypkjs websocket port out of pebble-tool's emulator state file
 * (%TEMP%\pb-emulator.json). Returns the first live pypkjs.port across all
 * platform/version entries, or null when the file is missing/partial. Pure
 * (readFile injectable) so it is unit-testable.
 */
export function readPypkjsPort(
  emuInfoPath: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number | null {
  try {
    const raw = readFile(emuInfoPath);
    const o = JSON.parse(raw) as Record<string, Record<string, { pypkjs?: { port?: number } }>>;
    for (const vers of Object.values(o)) {
      if (!vers || typeof vers !== "object") continue;
      for (const v of Object.values(vers)) {
        const p = v?.pypkjs?.port;
        if (typeof p === "number" && Number.isFinite(p) && p > 0) return p;
      }
    }
  } catch {
    /* missing / partial / malformed → no port */
  }
  return null;
}
