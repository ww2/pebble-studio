import { spawn } from "node:child_process";
import type { RunResult } from "./BackendDriver.js";

/**
 * Spawn a child, buffer its output, and resolve on close. Assignable to `Runner`
 * (the optional `timeoutMs` is extra).
 *
 * `timeoutMs` HARD-BOUNDS a call that would otherwise hang forever: some helpers
 * (e.g. the windows-native pb-set-tz.py, which — unlike the POSIX path — has no
 * coreutils `timeout` wrapper) connect to the single-client pypkjs bridge and can
 * block indefinitely when it is dead/contended. On timeout the child is killed and
 * the promise resolves with a nonzero code (never rejects), so callers treat it as
 * a failed-but-non-fatal push rather than a hang. The timer is cleared on normal
 * exit and a `settled` latch prevents any double-settle.
 */
export function spawnRunner(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs?: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // windowsHide suppresses the console window that would otherwise flash for
    // each short-lived helper (tasklist/taskkill/pebble/where). No-op off Windows.
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => settle(() => reject(e)));
    child.on("close", (code) => settle(() => resolve({ code: code ?? 0, stdout, stderr })));
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        settle(() => resolve({ code: -1, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` }));
      }, timeoutMs);
    }
  });
}
