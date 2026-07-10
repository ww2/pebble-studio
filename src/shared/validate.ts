// src/shared/validate.ts
// Runtime validators for the small cross-boundary enums that flow from the
// (untrusted) renderer into main. The TypeScript PlatformId/ButtonId/
// ButtonAction/ConditionKey/units types are ERASED at runtime, so an IPC handler
// that trusts them can be fed anything — these narrow the value at the boundary
// before it reaches a driver, a shell command line, or a persisted control file.

import type { PlatformId, ButtonId, ButtonAction } from "./types.js";
import { type ConditionKey, type SimEnvConfig, CONDITION_OPTIONS, DEFAULT_SIM_ENV } from "./simEnv.js";

/** The seven emulator platforms. Mirrors the PlatformId union in ./types.ts and
 * PLATFORMS in main/backend/emulatorRegistry.ts (kept self-contained so this
 * shared module has no dependency on a main-process file). */
export const PLATFORM_IDS = ["aplite", "basalt", "chalk", "diorite", "emery", "flint", "gabbro"] as const;
export function isPlatformId(x: unknown): x is PlatformId {
  return typeof x === "string" && (PLATFORM_IDS as readonly string[]).includes(x);
}

export const BUTTON_IDS = ["back", "up", "select", "down"] as const;
export function isButtonId(x: unknown): x is ButtonId {
  return typeof x === "string" && (BUTTON_IDS as readonly string[]).includes(x);
}

export const BUTTON_ACTIONS = ["press", "hold", "release"] as const;
export function isButtonAction(x: unknown): x is ButtonAction {
  return typeof x === "string" && (BUTTON_ACTIONS as readonly string[]).includes(x);
}

const CONDITION_KEYS: readonly string[] = CONDITION_OPTIONS.map((o) => o.key);
export function isConditionKey(x: unknown): x is ConditionKey {
  return typeof x === "string" && CONDITION_KEYS.includes(x);
}

export function isUnits(x: unknown): x is "F" | "C" {
  return x === "F" || x === "C";
}

/** Clamp to [min,max]; substitute `fallback` when not a finite number. */
function clampFinite(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

/** Plausible outdoor temperature envelope (°C) for the simulated weather; well
 * outside any real value but bounded so a hostile/buggy renderer can't stash a
 * NaN/Infinity/absurd number the bundled python then formats. */
const TEMP_C_MIN = -100;
const TEMP_C_MAX = 100;
/** Cap the free-text location name so an unbounded string can't be persisted. */
const NAME_MAX_LEN = 120;

/**
 * Coerce an untrusted renderer sim-env object into a valid SimEnvConfig before it
 * is persisted to sim-env.json (which the bundled python reads and trusts). Never
 * throws: out-of-range / wrong-typed fields fall back to the default preset or are
 * clamped, so `sim:set` can normalize rather than surface raw errors to the
 * renderer. Latitude ∈ [-90,90], longitude ∈ [-180,180], condition ∈ the allowed
 * set, temperature clamped, units ∈ {F,C}.
 */
export function normalizeSimEnv(cfg: unknown): SimEnvConfig {
  const c = (typeof cfg === "object" && cfg !== null ? cfg : {}) as Partial<SimEnvConfig>;
  const loc = (typeof c.location === "object" && c.location !== null ? c.location : {}) as Partial<SimEnvConfig["location"]>;
  const w = (typeof c.weather === "object" && c.weather !== null ? c.weather : {}) as Partial<SimEnvConfig["weather"]>;
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : DEFAULT_SIM_ENV.enabled,
    location: {
      lat: clampFinite(loc.lat, -90, 90, DEFAULT_SIM_ENV.location.lat),
      lon: clampFinite(loc.lon, -180, 180, DEFAULT_SIM_ENV.location.lon),
      name: typeof loc.name === "string" ? loc.name.slice(0, NAME_MAX_LEN) : DEFAULT_SIM_ENV.location.name,
    },
    weather: {
      condition: isConditionKey(w.condition) ? w.condition : DEFAULT_SIM_ENV.weather.condition,
      tempC: clampFinite(w.tempC, TEMP_C_MIN, TEMP_C_MAX, DEFAULT_SIM_ENV.weather.tempC),
      isDay: typeof w.isDay === "boolean" ? w.isDay : DEFAULT_SIM_ENV.weather.isDay,
    },
    units: isUnits(c.units) ? c.units : DEFAULT_SIM_ENV.units,
  };
}
