import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { simEnvPath, writeSimEnv, readSimEnv } from "../../src/main/backend/simEnv.js";
import { DEFAULT_SIM_ENV } from "../../src/shared/simEnv.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "simenv-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("sim-env control file IO", () => {
  it("path is <userData>/pebble-data/sim-env.json", () => {
    expect(simEnvPath(dir)).toBe(path.join(dir, "pebble-data", "sim-env.json"));
  });
  it("absent file returns the default preset", async () => {
    expect(await readSimEnv(dir)).toEqual(DEFAULT_SIM_ENV);
  });
  it("write then read round-trips and creates the dir", async () => {
    const cfg = { ...DEFAULT_SIM_ENV, weather: { condition: "rain" as const, tempC: 5, isDay: false } };
    await writeSimEnv(dir, cfg);
    expect(await readSimEnv(dir)).toEqual(cfg);
  });
  it("malformed JSON falls back to defaults", async () => {
    const p = simEnvPath(dir);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "{not json", "utf-8");
    expect(await readSimEnv(dir)).toEqual(DEFAULT_SIM_ENV);
  });
});
