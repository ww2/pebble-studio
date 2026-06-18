// tests/renderer/simEnvControl.test.ts
import { describe, it, expect } from "vitest";
import { buildSimConfigFromUi } from "../../src/renderer/components/SettingsPane.js";

describe("buildSimConfigFromUi", () => {
  it("converts a °F temperature input to canonical tempC and keeps units", () => {
    const cfg = buildSimConfigFromUi({
      enabled: true, lat: 33.6846, lon: -117.8265, name: "Irvine",
      condition: "clear", tempInput: 69, units: "F", isDay: true,
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.location).toEqual({ lat: 33.6846, lon: -117.8265, name: "Irvine" });
    expect(cfg.weather.condition).toBe("clear");
    expect(Math.round(cfg.weather.tempC)).toBe(21); // 69F ~= 20.56C
    expect(cfg.weather.isDay).toBe(true);
    expect(cfg.units).toBe("F");
  });
  it("keeps a °C input unchanged", () => {
    const cfg = buildSimConfigFromUi({
      enabled: false, lat: 0, lon: 0, name: "X",
      condition: "rain", tempInput: 5, units: "C", isDay: false,
    });
    expect(cfg.weather.tempC).toBe(5);
    expect(cfg.enabled).toBe(false);
  });
});
