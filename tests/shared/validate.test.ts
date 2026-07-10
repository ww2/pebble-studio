// tests/shared/validate.test.ts
import { describe, it, expect } from "vitest";
import {
  isPlatformId, isButtonId, isButtonAction, isConditionKey, isUnits,
  PLATFORM_IDS, BUTTON_IDS, BUTTON_ACTIONS, normalizeSimEnv,
} from "../../src/shared/validate.js";
import { DEFAULT_SIM_ENV } from "../../src/shared/simEnv.js";
import { listPlatformIds } from "../../src/main/backend/emulatorRegistry.js";

describe("enum validators", () => {
  it("isPlatformId accepts every real platform and rejects others", () => {
    for (const id of PLATFORM_IDS) expect(isPlatformId(id)).toBe(true);
    expect(isPlatformId("basalt")).toBe(true);
    expect(isPlatformId("evil")).toBe(false);
    expect(isPlatformId("")).toBe(false);
    expect(isPlatformId(undefined)).toBe(false);
    expect(isPlatformId(42)).toBe(false);
  });

  it("PLATFORM_IDS stays in sync with the emulator registry", () => {
    expect([...PLATFORM_IDS].sort()).toEqual([...listPlatformIds()].sort());
  });

  it("isButtonId / isButtonAction narrow to the allowed sets", () => {
    for (const b of BUTTON_IDS) expect(isButtonId(b)).toBe(true);
    for (const a of BUTTON_ACTIONS) expect(isButtonAction(a)).toBe(true);
    // The injection payload from the finding must be rejected.
    expect(isButtonId("select\nscreenshot C:\\evil.png")).toBe(false);
    expect(isButtonId("SELECT")).toBe(false);
    expect(isButtonAction("mash")).toBe(false);
    expect(isButtonAction(null)).toBe(false);
  });

  it("isConditionKey / isUnits", () => {
    expect(isConditionKey("thunder")).toBe(true);
    expect(isConditionKey("nope")).toBe(false);
    expect(isUnits("F")).toBe(true);
    expect(isUnits("C")).toBe(true);
    expect(isUnits("K")).toBe(false);
  });
});

describe("normalizeSimEnv", () => {
  it("passes a valid config through unchanged", () => {
    const cfg = {
      enabled: false,
      location: { lat: 40.7128, lon: -74.006, name: "New York" },
      weather: { condition: "rain" as const, tempC: 5, isDay: false },
      units: "C" as const,
    };
    expect(normalizeSimEnv(cfg)).toEqual(cfg);
  });

  it("clamps out-of-range lat/lon and tempC", () => {
    const out = normalizeSimEnv({
      enabled: true,
      location: { lat: 999, lon: -999, name: "x" },
      weather: { condition: "clear", tempC: 5000, isDay: true },
      units: "F",
    });
    expect(out.location.lat).toBe(90);
    expect(out.location.lon).toBe(-180);
    expect(out.weather.tempC).toBe(100);
  });

  it("replaces non-finite / wrong-typed numbers with the default preset value", () => {
    const out = normalizeSimEnv({
      location: { lat: Number.NaN, lon: Infinity, name: 123 },
      weather: { condition: "bogus", tempC: "hot" },
    });
    expect(out.location.lat).toBe(DEFAULT_SIM_ENV.location.lat);
    expect(out.location.lon).toBe(DEFAULT_SIM_ENV.location.lon);
    expect(out.location.name).toBe(DEFAULT_SIM_ENV.location.name);
    expect(out.weather.condition).toBe(DEFAULT_SIM_ENV.weather.condition);
    expect(out.weather.tempC).toBe(DEFAULT_SIM_ENV.weather.tempC);
  });

  it("rejects a bogus units value back to the default", () => {
    expect(normalizeSimEnv({ units: "K" }).units).toBe(DEFAULT_SIM_ENV.units);
  });

  it("caps an unbounded location name and survives null/garbage input", () => {
    const long = "a".repeat(500);
    expect(normalizeSimEnv({ location: { name: long } }).location.name.length).toBe(120);
    expect(normalizeSimEnv(null)).toEqual(DEFAULT_SIM_ENV);
    expect(normalizeSimEnv("garbage")).toEqual(DEFAULT_SIM_ENV);
  });
});
