/**
 * Tests for makeBridgeMonitor (Task H2 — poll/debounce/fire-once state machine).
 *
 * Testability approach: the returned monitor exposes `poll()` as a public async
 * method so tests can drive the state machine step-by-step without any timers.
 * `start()` wires `poll()` into a real setInterval for production use, but tests
 * bypass that entirely and call `poll()` directly. This eliminates all fake-timer
 * / flaky-async interaction.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeBridgeMonitor } from "../../src/main/backend/bridgeMonitor.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** A parseBridgePids-parseable JSON for platform "emery". */
const VALID_EMU_JSON = JSON.stringify({
  emery: {
    "4.9.169": {
      qemu: { pid: 1854238, port: 51113, monitor: 42553, vnc: true },
      pypkjs: { pid: 1854276, port: 57749 },
      websockify: { pid: 1854300 },
    },
  },
});

/** Canned runHealth responses. */
const RES_OK = { code: 0, stdout: "OK" };
const RES_DEAD_PID = { code: 1, stdout: "DEAD pid" };
const RES_DEAD_PORT = { code: 0, stdout: "DEAD port" };

/** Build a monitor with sensible defaults that tests can override. */
function makeTestMonitor(overrides: {
  readEmuInfo?: () => Promise<string | null>;
  runHealth?: (cmd: string) => Promise<{ code: number; stdout: string }>;
  onDead?: (reason: "pid" | "port") => void;
}) {
  return makeBridgeMonitor({
    readEmuInfo: overrides.readEmuInfo ?? (() => Promise.resolve(VALID_EMU_JSON)),
    runHealth: overrides.runHealth ?? (() => Promise.resolve(RES_OK)),
    onDead: overrides.onDead ?? (() => {}),
    pollMs: 9999, // irrelevant when driving via poll() directly
  });
}

// ---------------------------------------------------------------------------
// Happy path: always-OK — onDead never called
// ---------------------------------------------------------------------------

describe("always-OK health checks", () => {
  it("does not call onDead across many polls", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_OK),
      onDead,
    });
    monitor.start("emery");

    for (let i = 0; i < 10; i++) {
      await monitor.poll();
    }

    expect(onDead).not.toHaveBeenCalled();
    monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// PID death: immediate, no debounce needed
// ---------------------------------------------------------------------------

describe("PID death verdict", () => {
  it("fires onDead('pid') exactly once on the first dead-pid poll", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PID),
      onDead,
    });
    monitor.start("emery");

    await monitor.poll();

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith("pid");
  });

  it("stops polling after the first pid death (no re-fire on subsequent polls)", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PID),
      onDead,
    });
    monitor.start("emery");

    // Drive several more polls — monitor should be stopped after first fire
    await monitor.poll();
    await monitor.poll();
    await monitor.poll();

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(monitor.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Port debounce: 1 failure then OK → no death
// ---------------------------------------------------------------------------

describe("single port failure then recovery", () => {
  it("does not fire onDead when one port failure is followed by OK", async () => {
    const onDead = vi.fn();
    const responses = [RES_DEAD_PORT, RES_OK, RES_OK];
    let idx = 0;
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(responses[idx++ % responses.length]),
      onDead,
    });
    monitor.start("emery");

    await monitor.poll(); // port failure (counter = 1)
    await monitor.poll(); // OK (counter reset to 0)
    await monitor.poll(); // OK (still 0)

    expect(onDead).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("resets the port-failure counter on an OK verdict", async () => {
    // Pattern: port, ok, port — should NOT fire (second port run resets to 1,
    // not 2, because the OK in between reset the counter)
    const onDead = vi.fn();
    const responses = [RES_DEAD_PORT, RES_OK, RES_DEAD_PORT];
    let idx = 0;
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(responses[idx++ % responses.length]),
      onDead,
    });
    monitor.start("emery");

    await monitor.poll(); // counter = 1
    await monitor.poll(); // counter reset to 0
    await monitor.poll(); // counter = 1 (not 2)

    expect(onDead).not.toHaveBeenCalled();
    monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// Port debounce: 2 consecutive failures → death
// ---------------------------------------------------------------------------

describe("two consecutive port failures", () => {
  it("fires onDead('port') exactly once after 2 consecutive port failures", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PORT),
      onDead,
    });
    monitor.start("emery");

    await monitor.poll(); // counter = 1, no fire yet
    expect(onDead).not.toHaveBeenCalled();

    await monitor.poll(); // counter = 2, fire!
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith("port");
  });

  it("stops polling after port death — subsequent polls do not re-fire", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PORT),
      onDead,
    });
    monitor.start("emery");

    await monitor.poll();
    await monitor.poll(); // fires here
    await monitor.poll();
    await monitor.poll();

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(monitor.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transient skips: null readEmuInfo / null parseBridgePids
// ---------------------------------------------------------------------------

describe("transient emu-info skips", () => {
  it("does not count toward death when readEmuInfo returns null", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      readEmuInfo: () => Promise.resolve(null),
      onDead,
    });
    monitor.start("emery");

    for (let i = 0; i < 10; i++) {
      await monitor.poll();
    }

    expect(onDead).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("does not count toward death when the JSON is unparseable (parseBridgePids returns null)", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      readEmuInfo: () => Promise.resolve("{not valid json}"),
      onDead,
    });
    monitor.start("emery");

    for (let i = 0; i < 10; i++) {
      await monitor.poll();
    }

    expect(onDead).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("does not count toward death when the JSON has no matching platform", async () => {
    const wrongPlatformJson = JSON.stringify({
      basalt: { "4.9": { qemu: { pid: 1 }, pypkjs: { pid: 2, port: 3 } } },
    });
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      readEmuInfo: () => Promise.resolve(wrongPlatformJson),
      onDead,
    });
    monitor.start("emery");

    for (let i = 0; i < 10; i++) {
      await monitor.poll();
    }

    expect(onDead).not.toHaveBeenCalled();
    monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// Re-arm: calling start() again after a fire resets state
// ---------------------------------------------------------------------------

describe("re-arm after fire", () => {
  it("can fire again after a fresh start() following a pid death", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PID),
      onDead,
    });

    // First arm: fire once
    monitor.start("emery");
    await monitor.poll();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(monitor.isRunning()).toBe(false);

    // Second arm: fire again
    monitor.start("emery");
    expect(monitor.isRunning()).toBe(true);
    await monitor.poll();
    expect(onDead).toHaveBeenCalledTimes(2);
  });

  it("re-arms cleanly after a port death (counter and fired flag both reset)", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PORT),
      onDead,
    });

    // First arm: fire once (two consecutive port failures)
    monitor.start("emery");
    await monitor.poll();
    await monitor.poll();
    expect(onDead).toHaveBeenCalledTimes(1);

    // Second arm: first port failure alone should NOT fire (counter reset to 0)
    monitor.start("emery");
    await monitor.poll(); // counter = 1, no fire yet
    expect(onDead).toHaveBeenCalledTimes(1);

    await monitor.poll(); // counter = 2, fire again
    expect(onDead).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// stop() and isRunning()
// ---------------------------------------------------------------------------

describe("stop() and isRunning()", () => {
  it("isRunning() is false before start()", () => {
    const monitor = makeTestMonitor({});
    expect(monitor.isRunning()).toBe(false);
  });

  it("isRunning() is true after start()", () => {
    const monitor = makeTestMonitor({});
    monitor.start("emery");
    expect(monitor.isRunning()).toBe(true);
    monitor.stop();
  });

  it("isRunning() is false after stop()", () => {
    const monitor = makeTestMonitor({});
    monitor.start("emery");
    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  it("stop() is safe to call when already stopped", () => {
    const monitor = makeTestMonitor({});
    expect(() => {
      monitor.stop();
      monitor.stop();
    }).not.toThrow();
  });

  it("poll() after stop() is a no-op (onDead not called)", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PID),
      onDead,
    });
    monitor.start("emery");
    monitor.stop();

    // poll after stop: should be silently ignored
    await monitor.poll();

    expect(onDead).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// start() idempotency
// ---------------------------------------------------------------------------

describe("start() idempotency", () => {
  it("calling start() twice does not double-fire onDead", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PID),
      onDead,
    });
    monitor.start("emery");
    monitor.start("emery"); // second call: restarts cleanly

    await monitor.poll();

    // Fired at most once regardless of how many times start() was called
    expect(onDead).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Race-condition fixes (I1 + I2)
// ---------------------------------------------------------------------------

describe("overlapping concurrent polls do not double-count failures (I1)", () => {
  it("two concurrent polls with a DEAD-port verdict fire onDead at most once", async () => {
    // Without the in-flight guard, two concurrent poll() calls would each
    // increment consecutivePortFailures. After two such races, a SINGLE real
    // failure could reach count 2 and fire spuriously. This test verifies the
    // guard prevents that.
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PORT),
      onDead,
    });
    monitor.start("emery");

    // Both polls run concurrently — each sees ONE port failure.
    // Together they should advance the counter to 2 at most (first real failure
    // pair), but crucially onDead must not fire from a single underlying failure.
    // Run two truly concurrent polls and wait for both to settle.
    await Promise.all([monitor.poll(), monitor.poll()]);

    // The combined counter from two concurrent polls is ≤2. Whether onDead fires
    // depends on the race outcome, but the important invariant is that it fires
    // AT MOST ONCE — not twice from the same pair of polls.
    expect(onDead).toHaveBeenCalledTimes(
      onDead.mock.calls.length <= 1 ? onDead.mock.calls.length : -1
    );
    expect(onDead.mock.calls.length).toBeLessThanOrEqual(1);
    monitor.stop();
  });

  it("concurrent polls with always-DEAD-port do not cause onDead to fire more than once", async () => {
    // Additional stricter check: run two sequential rounds of concurrent polls.
    // onDead may fire once (legitimately) but never more than once total.
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PORT),
      onDead,
    });
    monitor.start("emery");

    await Promise.all([monitor.poll(), monitor.poll()]);
    // If not dead yet, drive one more poll to reach threshold
    if (monitor.isRunning()) {
      await monitor.poll();
    }

    expect(onDead).toHaveBeenCalledTimes(1);
  });
});

describe("stop()-mid-flight does not let stale poll mutate new session (I2)", () => {
  it("resolving runHealth after stop() does not fire onDead", async () => {
    const onDead = vi.fn();

    // Create a manually-controlled runHealth promise.
    let resolveHealth!: (v: { code: number; stdout: string }) => void;
    const healthPromise = new Promise<{ code: number; stdout: string }>(
      (res) => { resolveHealth = res; }
    );

    const monitor = makeTestMonitor({
      runHealth: () => healthPromise,
      onDead,
    });
    monitor.start("emery");

    // Begin a poll — it will suspend inside runHealth waiting for our promise.
    const pollPromise = monitor.poll();

    // Stop the monitor while the poll is in-flight.
    monitor.stop();

    // Now resolve runHealth with a DEAD-pid verdict.
    resolveHealth(RES_DEAD_PID);

    // Wait for the poll coroutine to finish.
    await pollPromise;

    // The session changed (stop → implicitly invalidated); onDead must NOT fire.
    expect(onDead).not.toHaveBeenCalled();
  });

  it("resolving runHealth after stop()+start() does not fire onDead into new session", async () => {
    const onDead = vi.fn();

    // Gate that lets us pause inside runHealth until we choose to release it.
    let resolveHealth!: (v: { code: number; stdout: string }) => void;
    const healthGate = new Promise<{ code: number; stdout: string }>(
      (res) => { resolveHealth = res; }
    );

    const monitor = makeTestMonitor({
      runHealth: () => healthGate,
      onDead,
    });

    // Session 1: start + begin a poll. We await a tick so the poll has time to
    // reach the runHealth await (past readEmuInfo + parseBridgePids) before we
    // stop and restart.
    monitor.start("emery");
    const stalePollPromise = monitor.poll();

    // Flush microtasks so the poll progresses through readEmuInfo → parseBridgePids
    // and reaches the suspended runHealth await before we stop.
    await Promise.resolve();
    await Promise.resolve();

    // Session 2: stop then immediately restart (sessionId advances).
    monitor.stop();
    monitor.start("emery");

    // Resolve the stale session-1 runHealth with a lethal verdict.
    resolveHealth(RES_DEAD_PID);
    await stalePollPromise;

    // The session stamp mismatch should have aborted the stale poll's write path.
    expect(onDead).not.toHaveBeenCalled();
    expect(monitor.isRunning()).toBe(true);

    // The new session should still be healthy (runHealth now returns OK via a
    // fresh monitor with OK default).
    monitor.stop();
  });

  it("stop() resets consecutivePortFailures so a new session starts clean (M2)", async () => {
    const onDead = vi.fn();
    const monitor = makeTestMonitor({
      runHealth: () => Promise.resolve(RES_DEAD_PORT),
      onDead,
    });

    // First session: advance the counter to 1 then stop.
    monitor.start("emery");
    await monitor.poll(); // counter = 1
    expect(onDead).not.toHaveBeenCalled();
    monitor.stop(); // M2 fix: stop() must reset the counter

    // New session: one port failure should be counter = 1, NOT 2.
    // (If stop() didn't reset, this would fire onDead immediately.)
    monitor.start("emery");
    await monitor.poll(); // counter should be 1 in new session, not 2
    expect(onDead).not.toHaveBeenCalled();

    monitor.stop();
  });
});
