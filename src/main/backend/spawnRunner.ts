import { spawn } from "node:child_process";
import type { RunResult } from "./BackendDriver.js";

export function spawnRunner(cmd: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // windowsHide suppresses the console window that would otherwise flash for
    // each short-lived helper (tasklist/taskkill/pebble/where). No-op off Windows.
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
