/**
 * Bridge-health polling monitor (Task H2).
 *
 * Polls a live qemu-pebble + pypkjs emulator bridge every ~pollMs milliseconds
 * and fires `onDead` exactly once when the bridge has confirmably died.
 *
 * Pure (no Electron imports). All I/O is injected via `deps` so the module is
 * fully unit-testable in vitest's node environment — the test suite drives the
 * state machine by calling `monitor.poll()` directly rather than relying on
 * real timers or fake-timer interplay.
 *
 * Testability approach (scheduler/testability design):
 *   `poll()` is exposed as a public async method on the returned monitor. Tests
 *   call it directly in sequence — no fake timers, no real waits, no flakiness.
 *   `start()` wires `poll()` into `setInterval` for production use; tests
 *   typically call `start()` only to set `isRunning = true` and establish the
 *   `platform` for `poll()`, then drive steps manually. `stop()` clears the
 *   interval and marks the monitor as not running.
 *
 * Debounce rules:
 *   - kind === "ok"   → reset consecutive-port-failure counter. (alive)
 *   - kind === "pid"  → definitive death; fire onDead("pid") + stop immediately.
 *   - kind === "port" → increment counter; fire onDead("port") + stop at count 2.
 *
 * Null returns from readEmuInfo or parseBridgePids (e.g. the bridge is still
 * booting) are transient skips — they neither advance the failure counter nor
 * trigger death. A missing file on a fresh boot should not immediately signal
 * death.
 */

import {
  parseBridgePids,
  buildHealthCommand,
  interpretHealth,
} from "./bridgeHealth.js";

/** Dependencies injected into the monitor — all pure callbacks for testability. */
export interface BridgeMonitorDeps {
  /** Returns the raw /tmp/pb-emulator.json text, or null if unreadable. */
  readEmuInfo: () => Promise<string | null>;
  /** Runs the health one-liner (via Shell) and returns its exit code + stdout. */
  runHealth: (cmd: string) => Promise<{ code: number; stdout: string }>;
  /** Called at most once per start() invocation when the bridge has died. */
  onDead: (reason: "pid" | "port") => void;
  /** Polling interval in ms. Defaults to 4000. */
  pollMs?: number;
}

/** Public interface returned by makeBridgeMonitor. */
export interface BridgeMonitor {
  /**
   * Begin polling on `platform`. If already running, restarts cleanly (clears
   * the old interval, resets the debounce counter and fired flag).
   */
  start(platform: string): void;
  /** Stop polling. Safe to call when already stopped (idempotent). */
  stop(): void;
  /** Whether a polling interval is currently active. */
  isRunning(): boolean;
  /**
   * Execute one poll step against the current platform. Public so that tests
   * can drive the state machine deterministically without timers. In production
   * this is called automatically by the setInterval established in start().
   *
   * No-op if the monitor is not running (i.e. after stop() or before start()).
   */
  poll(): Promise<void>;
}

/**
 * Create a bridge-health polling monitor. Call `start(platform)` to begin, and
 * `stop()` when the emulator session ends. The monitor is designed to be created
 * once per app lifetime and reused across emulator sessions.
 */
export function makeBridgeMonitor(deps: BridgeMonitorDeps): BridgeMonitor {
  const { readEmuInfo, runHealth, onDead } = deps;
  const pollMs = deps.pollMs ?? 4000;

  // --- mutable state ---
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let consecutivePortFailures = 0;
  let firedDead = false;
  let currentPlatform = "";

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start(platform: string): void {
    // Restart cleanly if already running (idempotent restart).
    stop();
    currentPlatform = platform;
    consecutivePortFailures = 0;
    firedDead = false;
    running = true;
    timer = setInterval(() => {
      // Fire-and-forget inside the interval; errors are swallowed because a
      // poll step is best-effort — a transient shell error should not crash the
      // app. The next interval tick will retry.
      poll().catch(() => {});
    }, pollMs);
  }

  async function poll(): Promise<void> {
    // No-op when not running (after stop() or before start()).
    if (!running) return;

    // Step 1: read the emulator state file. Null → transient skip.
    const json = await readEmuInfo();
    if (json === null) return;

    // Step 2: parse the PIDs for the current platform. Null → transient skip.
    const pids = parseBridgePids(json, currentPlatform);
    if (pids === null) return;

    // Step 3+4: run the health command and interpret the verdict.
    const { code, stdout } = await runHealth(buildHealthCommand(pids));
    const verdict = interpretHealth(stdout, code);

    // Step 5: debounce + fire.
    if (verdict.kind === "ok") {
      consecutivePortFailures = 0;
      return;
    }

    if (verdict.kind === "pid") {
      // PID death is definitive — fire immediately (no debounce).
      if (!firedDead) {
        firedDead = true;
        stop();
        onDead("pid");
      }
      return;
    }

    // verdict.kind === "port": require 2 consecutive failures.
    consecutivePortFailures++;
    if (consecutivePortFailures >= 2 && !firedDead) {
      firedDead = true;
      stop();
      onDead("port");
    }
  }

  return {
    start,
    stop,
    isRunning: () => running,
    poll,
  };
}
