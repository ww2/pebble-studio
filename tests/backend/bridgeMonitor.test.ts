import { describe, it, expect, vi, afterEach } from "vitest";
import { makeBridgeMonitor, type MonitorVerdict } from "../../src/main/backend/bridgeMonitor.js";

// Valid state-file json so poll() reaches checkHealth for the "ok" cases.
const okJson = JSON.stringify({
  emery: { "4.9": { qemu: { pid: 1 }, pypkjs: { pid: 2, port: 3 } } },
});

describe("bridgeMonitor — in-flight latch liveness", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("releases the in-flight latch when a poll hangs, so the monitor keeps polling", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const monitor = makeBridgeMonitor({
      // First poll hangs forever at step 1 (models an unbounded wsl.exe probe);
      // later polls return null (transient skip). Without the deadline release the
      // first hang would strand pollInFlight=true and silently kill the monitor.
      readEmuInfo: () => { reads++; return reads === 1 ? new Promise<string | null>(() => {}) : Promise.resolve(null); },
      checkHealth: async (): Promise<MonitorVerdict> => ({ alive: true, kind: "ok" }),
      onDead: () => {},
      pollMs: 100,
    });

    monitor.start("emery");
    await vi.advanceTimersByTimeAsync(100); // tick 1 → readEmuInfo hangs, latch set
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(500); // deadline (pollMs*2) releases the latch
    expect(reads).toBeGreaterThan(1);       // later ticks actually run
    monitor.stop();
  });

  it("normal ok polls do not double-run within one tick", async () => {
    vi.useFakeTimers();
    let checks = 0;
    const monitor = makeBridgeMonitor({
      readEmuInfo: async () => okJson,
      checkHealth: async (): Promise<MonitorVerdict> => { checks++; return { alive: true, kind: "ok" }; },
      onDead: () => {},
      pollMs: 100,
    });
    monitor.start("emery");
    await vi.advanceTimersByTimeAsync(250); // ~2 ticks
    expect(checks).toBeGreaterThanOrEqual(1);
    expect(checks).toBeLessThanOrEqual(3);
    monitor.stop();
  });
});
