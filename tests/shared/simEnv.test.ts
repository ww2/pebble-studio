// tests/shared/simEnv.test.ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SIM_ENV, CONDITION_OPTIONS, PRESET_CITIES,
  cToF, fToC, tempInputToC, tempCToDisplay,
} from "../../src/shared/simEnv.js";

describe("simEnv helpers", () => {
  it("default preset is Irvine / clear / 69F / day / units F", () => {
    expect(DEFAULT_SIM_ENV.enabled).toBe(true);
    expect(DEFAULT_SIM_ENV.location.name).toBe("Irvine");
    expect(DEFAULT_SIM_ENV.weather.condition).toBe("clear");
    expect(DEFAULT_SIM_ENV.weather.isDay).toBe(true);
    expect(DEFAULT_SIM_ENV.units).toBe("F");
    expect(Math.round(cToF(DEFAULT_SIM_ENV.weather.tempC))).toBe(69);
  });
  it("cToF/fToC round-trip", () => {
    expect(fToC(cToF(20.56))).toBeCloseTo(20.56, 6);
    expect(Math.round(cToF(0))).toBe(32);
  });
  it("tempInputToC converts from the chosen unit", () => {
    expect(tempInputToC(69, "F")).toBeCloseTo(20.56, 1);
    expect(tempInputToC(21, "C")).toBe(21);
  });
  it("tempCToDisplay is the inverse", () => {
    expect(Math.round(tempCToDisplay(20.56, "F"))).toBe(69);
    expect(tempCToDisplay(21, "C")).toBe(21);
  });
  it("has 10 conditions and Irvine preset", () => {
    expect(CONDITION_OPTIONS.map((o) => o.key)).toContain("thunder");
    expect(CONDITION_OPTIONS).toHaveLength(10);
    expect(PRESET_CITIES.some((c) => c.name === "Irvine")).toBe(true);
  });
});
