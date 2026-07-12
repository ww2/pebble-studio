/** localStorage key for the live sunlight-correction overlay (default OFF). */
export const LIVE_SUNLIGHT_KEY = "pebble-studio:live-sunlight";

/** Window event dispatched by Settings when the toggle flips, so EmulatorView
 * can start/stop the overlay live without a wired callback. */
export const LIVE_SUNLIGHT_EVENT = "pebble-studio:live-sunlight-changed";

/** Gate for the per-frame overlay loop: run only when the setting is on AND the
 * emulator is live (mirrors syncFpsSampler so there's zero cost otherwise). */
export function shouldRunLiveSunlight(state: string, enabled: boolean): boolean {
  return enabled && state === "live";
}

/**
 * Hide the noVNC source canvas so only the corrected overlay is visible, WITHOUT
 * removing it from hit-testing.
 *
 * The overlay canvas (#emu-sunlight) has `pointer-events: none`, so pointer events
 * are meant to fall THROUGH it to the noVNC source canvas beneath — noVNC binds all
 * its mouse/touch handlers to that canvas (and even asserts `ev.target === canvas`).
 * `visibility: hidden` / `display: none` would drop the source out of hit-testing,
 * so those pointer events land on nothing and touch input dies while sunlight is on.
 * `opacity: 0` makes the canvas fully transparent (the overlay shows the corrected
 * frame on top) while keeping it hit-testable, so clicks reach noVNC as normal.
 * It also leaves the canvas backing store untouched, so drawSunlightFrame can still
 * read its pixels via drawImage.
 */
export function hideCanvasForSunlightOverlay(canvas: HTMLElement): void {
  canvas.style.opacity = "0";
}

/** Undo hideCanvasForSunlightOverlay: restore the source canvas to fully visible. */
export function restoreCanvasFromSunlightOverlay(canvas: HTMLElement): void {
  canvas.style.opacity = "";
}
