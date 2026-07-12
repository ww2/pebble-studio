// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  shouldRunLiveSunlight,
  LIVE_SUNLIGHT_KEY,
  hideCanvasForSunlightOverlay,
  restoreCanvasFromSunlightOverlay,
} from "../../src/renderer/liveSunlight.js";

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

describe("hideCanvasForSunlightOverlay / restore", () => {
  // The overlay canvas has `pointer-events: none`, so pointer events must fall
  // THROUGH to the noVNC source canvas beneath (noVNC binds its mouse/touch
  // handlers to that canvas). Hiding the source with `visibility: hidden` drops
  // it out of hit-testing → touch input dies whenever sunlight is on. The source
  // must be hidden in a way that keeps it hit-testable (opacity), not one that
  // removes it from hit-testing (visibility/display).
  it("hides the source canvas WITHOUT removing it from hit-testing", () => {
    const canvas = document.createElement("canvas");
    hideCanvasForSunlightOverlay(canvas);

    // Invisible…
    expect(canvas.style.opacity).toBe("0");
    // …but still hit-testable (these would kill noVNC pointer input).
    expect(canvas.style.visibility).not.toBe("hidden");
    expect(canvas.style.display).not.toBe("none");
    expect(canvas.style.pointerEvents).not.toBe("none");
  });

  it("restore returns the canvas to fully visible", () => {
    const canvas = document.createElement("canvas");
    hideCanvasForSunlightOverlay(canvas);
    restoreCanvasFromSunlightOverlay(canvas);
    expect(canvas.style.opacity).toBe("");
  });
});
