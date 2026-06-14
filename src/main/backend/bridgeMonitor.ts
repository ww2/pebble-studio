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
 *   - kind === "ok"   → mark the bridge seen-alive; reset the port-failure counter.
 *   - kind === "pid"  → definitive death; fire onDead("pid") + stop immediately.
 *   - kind === "port" → increment counter; fire onDead("port") + stop at count 2,
 *                       BUT only once the bridge has been seen alive this session.
 *
 * Startup grace (the boot-time false-death fix): a "port" verdict before the
 * bridge has EVER answered is treated as still-starting, not a death — it is
 * ignored entirely (no counter advance, no fire). On native Windows pypkjs's
 * websocket server can take many seconds to bind after qemu/websockify are up
 * (V8 cold start), so the first health polls legitimately see the pypkjs port
 * down even though "Ready" was already reported (boot waits on VNC/ws :5901/:6080,
 * not on the pypkjs port). Without this grace the monitor fired onDead("port")
 * ~8s after boot and triggered an endless relaunch loop on a bridge that was
 * simply still coming up. "stopped responding" can only mean a bridge that WAS
 * responding; a pid death (a recorded process actually gone) is still definitive
 * and fires immediately regardless of the grace.
 *
 * Null returns from readEmuInfo or parseBridgePids (e.g. the bridge is still
 * booting) are transient skips — they neither advance the failure counter nor
 * trigger death. A missing file on a fresh boot should not immediately signal
 * death.
 */

import { parseBridgePids, type BridgePids } from "./bridgeHealth.js";

/** A bridge-health verdict (same shape interpretHealth / nativeHealthVerdict produce). */
export interface MonitorVerdict {
  alive: boolean;
  kind: "ok" | "pid" | "port";
}

/** Dependencies injected into the monitor — all pure callbacks for testability. */
export interface BridgeMonitorDeps {
  /** Returns the raw emulator state-file text, or null if unreadable. */
  readEmuInfo: () => Promise<string | null>;
  /**
   * Assess bridge health for the given pids and return a verdict. The driver
   * supplies the mechanism: WSL/native-Linux runs the POSIX bash probe
   * (buildHealthCommand → interpretHealth); windows-native uses the shell-free
   * native probe (winBridgeHealth.makeNativeHealthCheck). Decoupling this from
   * any specific command is what keeps a native emulator from being assessed
   * through WSL — the root cause of the v2.0.1 false-death loop.
   */
  checkHealth: (pids: BridgePids) => Promise<MonitorVerdict>;
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
  const { readEmuInfo, checkHealth, onDead } = deps;
  const pollMs = deps.pollMs ?? 4000;

  // --- mutable state ---
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let consecutivePortFailures = 0;
  let firedDead = false;
  // Startup grace: a "port" failure can only count toward death once the bridge
  // has answered at least once this session (see the module-level rationale).
  let seenAlive = false;
  let currentPlatform = "";
  // I1: in-flight guard — prevents overlapping interval ticks from running
  // two concurrent poll() calls and double-counting a single failure.
  let pollInFlight = false;
  // I2: monotonic session counter — incremented on every start(); each poll()
  // captures the session at entry and bails after each await if the session has
  // changed, preventing a stale poll from a previous session from mutating the
  // new session's state or firing onDead.
  let sessionId = 0;

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // M2: reset in-flight guard and failure counter so a standalone stop()
    // fully quiesces state before the next start().
    pollInFlight = false;
    consecutivePortFailures = 0;
  }

  function start(platform: string): void {
    // Restart cleanly if already running (idempotent restart).
    stop();
    currentPlatform = platform;
    firedDead = false;
    seenAlive = false;
    running = true;
    // I2: advance the session so any in-flight poll from the previous session
    // will detect the mismatch and abort after its next await.
    sessionId++;
    timer = setInterval(() => {
      // I1: drop the tick entirely if a poll is still in progress. This prevents
      // two concurrent poll() calls from both incrementing consecutivePortFailures
      // on a single real failure.
      if (pollInFlight) return;
      pollInFlight = true;
      // Fire-and-forget inside the interval; errors are swallowed because a
      // poll step is best-effort — a transient shell error should not crash the
      // app. The next interval tick will retry.
      poll().catch(() => {}).finally(() => { pollInFlight = false; });
    }, pollMs);
  }

  async function poll(): Promise<void> {
    // No-op when not running (after stop() or before start()).
    if (!running) return;

    // I2: capture the session at poll entry; bail after each await if it changed.
    const s = sessionId;

    // Step 1: read the emulator state file. Null → transient skip.
    const json = await readEmuInfo();
    if (s !== sessionId || !running) return;
    if (json === null) return;

    // Step 2: parse the PIDs for the current platform. Null → transient skip.
    const pids = parseBridgePids(json, currentPlatform);
    if (s !== sessionId || !running) return;
    if (pids === null) return;

    // Step 3+4: assess bridge health (driver-supplied: POSIX bash probe for WSL,
    // shell-free native probe for windows-native).
    const verdict = await checkHealth(pids);
    if (s !== sessionId || !running) return;

    // Step 5: debounce + fire.
    if (verdict.kind === "ok") {
      seenAlive = true;
      consecutivePortFailures = 0;
      return;
    }

    if (verdict.kind === "pid") {
      // PID death is definitive — fire immediately (no debounce, no grace).
      if (!firedDead) {
        firedDead = true;
        stop();
        onDead("pid");
      }
      return;
    }

    // verdict.kind === "port": startup grace — a bridge that has never answered
    // is still coming up, not "stopped responding"; ignore until first OK.
    if (!seenAlive) return;
    // require 2 consecutive failures.
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
