// src/shared/simEnv.ts
// Simulated environment (location + weather) shared between main, preload and renderer.
// The category->provider-code mapping lives in the Python side (pebble_studio_sim.py);
// here we only carry the config shape, UI option lists, defaults and unit math.

export type ConditionKey =
  | "clear" | "partly" | "cloudy" | "fog" | "drizzle"
  | "rain" | "sleet" | "snow" | "thunder" | "wind";

export interface SimEnvConfig {
  enabled: boolean;
  location: { lat: number; lon: number; name: string };
  weather: { condition: ConditionKey; tempC: number; isDay: boolean };
  /** UI input/display unit only; both units are always sent to the watch. */
  units: "F" | "C";
}

export const CONDITION_OPTIONS: { key: ConditionKey; label: string }[] = [
  { key: "clear", label: "Clear" },
  { key: "partly", label: "Partly cloudy" },
  { key: "cloudy", label: "Cloudy" },
  { key: "fog", label: "Fog" },
  { key: "drizzle", label: "Drizzle" },
  { key: "rain", label: "Rain" },
  { key: "sleet", label: "Sleet" },
  { key: "snow", label: "Snow" },
  { key: "thunder", label: "Thunderstorm" },
  { key: "wind", label: "Wind" },
];

export const PRESET_CITIES: { name: string; lat: number; lon: number }[] = [
  { name: "Irvine", lat: 33.6846, lon: -117.8265 },
  { name: "New York", lat: 40.7128, lon: -74.006 },
  { name: "London", lat: 51.5074, lon: -0.1278 },
  { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
  { name: "Sydney", lat: -33.8688, lon: 151.2093 },
  { name: "Reykjavík", lat: 64.1466, lon: -21.9426 },
  { name: "São Paulo", lat: -23.5505, lon: -46.6333 },
  { name: "Cape Town", lat: -33.9249, lon: 18.4241 },
];

export const DEFAULT_SIM_ENV: SimEnvConfig = {
  enabled: true,
  location: { lat: 33.6846, lon: -117.8265, name: "Irvine" },
  weather: { condition: "clear", tempC: 20.56, isDay: true },
  units: "F",
};

export function cToF(c: number): number { return (c * 9) / 5 + 32; }
export function fToC(f: number): number { return ((f - 32) * 5) / 9; }

/** Temperature typed in the chosen unit -> canonical tempC. */
export function tempInputToC(value: number, units: "F" | "C"): number {
  return units === "F" ? fToC(value) : value;
}
/** Canonical tempC -> value shown in the chosen unit. */
export function tempCToDisplay(tempC: number, units: "F" | "C"): number {
  return units === "F" ? cToF(tempC) : tempC;
}
