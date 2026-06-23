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
