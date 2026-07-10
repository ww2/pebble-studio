import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSimEnv, simEnvPath, writeSimEnv } from "../../src/main/backend/simEnv.js";
import { DEFAULT_SIM_ENV } from "../../src/shared/simEnv.js";

describe("readSimEnv", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "simenv-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns the default preset when the file is absent", async () => {
    expect(await readSimEnv(dir)).toEqual(DEFAULT_SIM_ENV);
  });

  it("deep-merges nested weather/location so an OLD partial config keeps newer default fields", async () => {
    const p = simEnvPath(dir);
    await mkdir(join(dir, "pebble-data"), { recursive: true });
    // A pre-`isDay` config: weather lacks isDay; location lacks name.
    await writeFile(p, JSON.stringify({
      enabled: true,
      units: "C",
      weather: { condition: "rain", tempC: 5 },
      location: { lat: 51.5, lon: -0.1 },
    }));
    const cfg = await readSimEnv(dir);
    expect(cfg.weather).toEqual({ condition: "rain", tempC: 5, isDay: DEFAULT_SIM_ENV.weather.isDay });
    expect(cfg.location.name).toBe(DEFAULT_SIM_ENV.location.name); // not lost by the shallow spread
    expect(cfg.location.lat).toBe(51.5);
    expect(cfg.units).toBe("C");
  });

  it("round-trips a full config written by writeSimEnv", async () => {
    const full = { ...DEFAULT_SIM_ENV, units: "C" as const, weather: { condition: "snow" as const, tempC: -3, isDay: false } };
    await writeSimEnv(dir, full);
    expect(await readSimEnv(dir)).toEqual(full);
  });
});
