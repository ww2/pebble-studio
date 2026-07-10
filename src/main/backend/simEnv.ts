import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULT_SIM_ENV, type SimEnvConfig } from "../../shared/simEnv.js";

/** Control file path. Mirrors winRuntime.pebbleDataDir(): <userData>/pebble-data. */
export function simEnvPath(userDataDir: string): string {
  return path.join(userDataDir, "pebble-data", "sim-env.json");
}

export async function writeSimEnv(userDataDir: string, cfg: SimEnvConfig): Promise<void> {
  const p = simEnvPath(userDataDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Absent/unreadable/malformed -> the default preset (on by default). */
export async function readSimEnv(userDataDir: string): Promise<SimEnvConfig> {
  try {
    const raw = await fs.readFile(simEnvPath(userDataDir), "utf-8");
    const stored = JSON.parse(raw) as Partial<SimEnvConfig>;
    // Deep-merge the nested objects: a shallow spread would let an OLDER config's
    // partial `weather`/`location` (missing fields added in a newer version)
    // replace the default wholesale and drop those newer fields (e.g. isDay).
    return {
      ...DEFAULT_SIM_ENV,
      ...stored,
      location: { ...DEFAULT_SIM_ENV.location, ...stored.location },
      weather: { ...DEFAULT_SIM_ENV.weather, ...stored.weather },
    };
  } catch {
    return DEFAULT_SIM_ENV;
  }
}
