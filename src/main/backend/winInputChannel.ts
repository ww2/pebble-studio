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

/** Minimal child surface the channel needs (injectable for tests). */
export interface InputChild {
  /** Write a line (already newline-terminated) to the helper's stdin. */
  stdinWrite(line: string): void;
  /** Force-terminate the helper. */
  kill(): void;
  /** Whether the helper is still running. */
  alive(): boolean;
}

export interface WinInputChannelDeps {
  helper: InputHelperPaths;
  /** Current pypkjs port from the emulator state file, or null if not booted. */
  readPort: () => number | null;
  /** Spawn the helper child. Defaults to a real detached-stdin node spawn. */
  spawnChild?: (pythonExe: string, args: string[]) => InputChild;
}

function defaultSpawnChild(pythonExe: string, args: string[]): InputChild {
  // windowsHide so the helper never flashes a console; stdin piped, stdout/stderr
  // ignored (we don't read acks — a press is fire-and-forget for latency).
  const c = nodeSpawn(pythonExe, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  let dead = false;
  c.on("error", () => { dead = true; });
  c.on("exit", () => { dead = true; });
  return {
    stdinWrite: (line) => { c.stdin?.write(line); },
    kill: () => { try { c.kill(); } catch { /* already gone */ } },
    alive: () => !dead && c.exitCode === null && !c.killed,
  };
}

export class WinInputChannel {
  private child: InputChild | null = null;
  private port: number | null = null;
  private readonly spawnChild: (pythonExe: string, args: string[]) => InputChild;

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
    return true;
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
