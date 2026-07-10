import { describe, it, expect } from "vitest";

// EmulatorView transitively imports vncClient -> @novnc/novnc, which touches
// `window` at module load. Stub it so we can import the pure, DOM-free helper.
import { vi } from "vitest";
vi.mock("@novnc/novnc", () => ({ default: class {} }));

import { shouldSkipReselect } from "../../src/renderer/components/EmulatorView.js";

describe("shouldSkipReselect", () => {
  it("skips (no-op) when re-selecting the board that is already live", () => {
    expect(shouldSkipReselect("basalt", "basalt", "live")).toBe(true);
  });

  it("skips when re-selecting the board whose boot is already in flight (no duplicate boot)", () => {
    expect(shouldSkipReselect("basalt", "basalt", "booting")).toBe(true);
  });

  it("does NOT skip when selecting a different board (teardown + boot must run)", () => {
    expect(shouldSkipReselect("emery", "basalt", "live")).toBe(false);
    expect(shouldSkipReselect("emery", "basalt", "booting")).toBe(false);
  });

  it("does NOT skip when the same board is stopped/stopping/unresponsive (relaunch/recovery must run)", () => {
    expect(shouldSkipReselect("basalt", "basalt", "stopped")).toBe(false);
    expect(shouldSkipReselect("basalt", "basalt", "stopping")).toBe(false);
    expect(shouldSkipReselect("basalt", "basalt", "unresponsive")).toBe(false);
  });

  it("does NOT skip when nothing has been selected yet (currentPlatform null)", () => {
    expect(shouldSkipReselect(null, "basalt", "stopped")).toBe(false);
    expect(shouldSkipReselect(null, "basalt", "live")).toBe(false);
  });
});
