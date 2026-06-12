import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseMonitorPort,
  createBacklightController,
} from "../../src/main/backend/backlight.js";
import type { Shell } from "../../src/main/backend/bootEmulator.js";

/**
 * parseMonitorPort is the pure helper behind the backlight keepalive: it extracts
 * the qemu HMP `monitor` port from the /tmp/pb-emulator.json text so the keepalive
 * can open a TCP socket and send a Back press. It must be robust to a missing or
 * malformed file (return null, never throw).
 */
describe("parseMonitorPort", () => {
  // The real emulator state-file shape (from a live /tmp/pb-emulator.json).
  const realJson = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 635689, port: 57419, serial: 55005, gdb: 43673, monitor: 54685, vnc: true },
        pypkjs: { pid: 635727, port: 54737 },
        version: "4.9.169",
        websockify: { pid: 635751 },
      },
    },
  });

  it("returns the monitor port from a valid state file", () => {
    expect(parseMonitorPort(realJson)).toBe(54685);
  });

  it("returns the first live monitor port across platforms/versions", () => {
    const json = JSON.stringify({
      basalt: { "4.9": { qemu: { pid: 1, monitor: 12000 } } },
    });
    expect(parseMonitorPort(json)).toBe(12000);
  });

  it("returns null when there is no qemu.monitor entry", () => {
    const json = JSON.stringify({ basalt: { "4.9": { qemu: { pid: 1 } } } });
    expect(parseMonitorPort(json)).toBeNull();
  });

  it("returns null for an empty / missing file", () => {
    expect(parseMonitorPort("")).toBeNull();
  });

  it("returns null for malformed (partial-write) json", () => {
    expect(parseMonitorPort('{ "emery": { "4.9.169": { "qemu": {')).toBeNull();
  });

  it("ignores a non-numeric monitor value", () => {
    const json = JSON.stringify({ basalt: { "4.9": { qemu: { monitor: "nope" } } } });
    expect(parseMonitorPort(json)).toBeNull();
  });
});

/**
 * The controller drives the keepalive. Its `method` selects WHAT a fire does:
 *   back   → read the qemu monitor port (via the shell) and send a Back key,
 *   motion → call the injected sendMotion() (accel tap), no monitor read,
 *   off    → do nothing (and the interval is never running).
 * We inject a fake Shell (so the monitor "read" is observable without touching
 * the filesystem) and a sendMotion spy. The fake shell returns no monitor port
 * (code !== 0), so the `back` path stops after the read and never opens a real
 * TCP socket — keeping these tests hermetic. `pulseOnce()` fires exactly once
 * for the current method regardless of always/captureHold.
 */
describe("createBacklightController", () => {
  let shellRun: ReturnType<typeof vi.fn>;
  let shell: Shell;
  let sendMotion: ReturnType<typeof vi.fn>;

  /** The fake shell answers the monitor-read `cat` with "no file" (code 1). */
  function makeController() {
    shellRun = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
    shell = { run: shellRun, spawnDetached: vi.fn(async () => {}) } as unknown as Shell;
    sendMotion = vi.fn(async () => {});
    return createBacklightController(
      () => "native",
      sendMotion,
      () => shell,
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("method 'back' (default): a tick reads the monitor and tries to send a key", async () => {
    const ctrl = makeController();
    ctrl.setAlways(true); // sync() fires once immediately (back is the default)
    await vi.advanceTimersByTimeAsync(0);
    expect(shellRun).toHaveBeenCalled();
    // The read returned no port, so motion was never used.
    expect(sendMotion).not.toHaveBeenCalled();
  });

  it("method 'off': with always=true, a fire does NO monitor read and NO motion", async () => {
    const ctrl = makeController();
    ctrl.setMethod("off");
    ctrl.setAlways(true);
    await vi.advanceTimersByTimeAsync(2000); // advance past several would-be ticks
    expect(shellRun).not.toHaveBeenCalled();
    expect(sendMotion).not.toHaveBeenCalled();
    // pulseOnce is also a no-op when off.
    ctrl.pulseOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(shellRun).not.toHaveBeenCalled();
    expect(sendMotion).not.toHaveBeenCalled();
  });

  it("method 'motion': a tick calls sendMotion and does NOT read the monitor", async () => {
    const ctrl = makeController();
    ctrl.setMethod("motion");
    ctrl.setAlways(true); // sync() fires once immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    expect(shellRun).not.toHaveBeenCalled();
  });

  it("pulseOnce() fires exactly one keepalive for the current method", async () => {
    const ctrl = makeController();
    ctrl.setMethod("motion");
    // No always/captureHold set → the interval is NOT running, so only the
    // explicit pulse should fire.
    ctrl.pulseOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    // Advancing further must not produce additional fires (no interval active).
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMotion).toHaveBeenCalledTimes(1);
  });

  it("setMethod('off') stops a running interval even with always set", async () => {
    const ctrl = makeController();
    ctrl.setAlways(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(shellRun).toHaveBeenCalled();
    shellRun.mockClear();
    ctrl.setMethod("off"); // must stop the interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(shellRun).not.toHaveBeenCalled();
  });
});
