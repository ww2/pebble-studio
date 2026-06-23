import { describe, it, expect } from "vitest";
import { shouldRunLiveSunlight, LIVE_SUNLIGHT_KEY } from "../../src/renderer/liveSunlight.js";

describe("shouldRunLiveSunlight", () => {
  it("runs only when enabled AND the emulator is live", () => {
    expect(shouldRunLiveSunlight("live", true)).toBe(true);
    expect(shouldRunLiveSunlight("live", false)).toBe(false);
    expect(shouldRunLiveSunlight("booting", true)).toBe(false);
    expect(shouldRunLiveSunlight("stopped", true)).toBe(false);
    expect(shouldRunLiveSunlight("unresponsive", true)).toBe(false);
  });
  it("exposes the localStorage key", () => {
    expect(LIVE_SUNLIGHT_KEY).toBe("pebble-studio:live-sunlight");
  });
});
