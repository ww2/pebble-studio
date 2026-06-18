import { describe, it, expect, vi } from "vitest";

// EmulatorView transitively imports vncClient -> @novnc/novnc, which touches
// `window` at module load. Stub it so we can import the pure, DOM-free helper.
vi.mock("@novnc/novnc", () => ({ default: class {} }));

import { shouldReconnectAfterReboot } from "../../src/renderer/components/EmulatorView.js";

describe("shouldReconnectAfterReboot", () => {
  it("never reconnects without a current platform", () => {
    expect(shouldReconnectAfterReboot(true, "live", false)).toBe(false);
    expect(shouldReconnectAfterReboot(false, "live", false)).toBe(false);
  });

  it("reconnects after an external (weather-refresh) reboot regardless of state", () => {
    // bridge-dead is suppressed during the external reboot, so `state` should
    // stay "live" — but even if a stray transition moved it, we still reconnect
    // rather than leave the canvas black (this is the H1 fix).
    for (const s of ["live", "booting", "stopping", "unresponsive", "stopped"] as const) {
      expect(shouldReconnectAfterReboot(true, s, true)).toBe(true);
    }
  });

  it("on the Clear path (no external reboot) reconnects only a live/unresponsive emulator", () => {
    expect(shouldReconnectAfterReboot(false, "live", true)).toBe(true);
    expect(shouldReconnectAfterReboot(false, "unresponsive", true)).toBe(true);
    expect(shouldReconnectAfterReboot(false, "booting", true)).toBe(false);
    expect(shouldReconnectAfterReboot(false, "stopping", true)).toBe(false);
    expect(shouldReconnectAfterReboot(false, "stopped", true)).toBe(false);
  });
});
