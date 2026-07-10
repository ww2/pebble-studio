/** Pure Windows process helpers for the windows-native boot deps. argv only — no shell. */

/** `tasklist` argv to query one image name in headerless CSV. */
export function tasklistArgs(imageName: string): string[] {
  return ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"];
}

/** `tasklist` argv to query ONE pid in headerless CSV — used to resolve a
 * state-file pid's image name so we can VERIFY it is one of ours before killing
 * it (Windows recycles pids, so a stale state file can name an unrelated process). */
export function tasklistPidArgs(pid: number): string[] {
  return ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"];
}

/**
 * Image name from the FIRST data row of `tasklist /FO CSV /NH` output (a row like
 * `"image.exe","1234",...`), or "" when there is no row (e.g. the "No tasks…"
 * banner for a pid that no longer exists). Pure + unit-testable.
 */
export function parseTasklistImage(stdout: string): string {
  if (!stdout) return "";
  const m = /^"([^"]+\.exe)","\d+"/m.exec(stdout);
  return m ? m[1] : "";
}

/**
 * True iff `tasklist` output contains at least one real process row. When nothing
 * matches, tasklist prints an "INFO: No tasks…" banner (to stdout) instead of CSV
 * rows; a real row is a quoted CSV line beginning with the image name.
 *
 * Assumes `imageName` ends in `.exe` (always true for the qemu/websockify images
 * this checks); a row whose image name has no `.exe` suffix is treated as not-alive.
 */
export function parseTasklistAlive(stdout: string): boolean {
  if (!stdout) return false;
  if (/no tasks are running/i.test(stdout)) return false;
  // A CSV data row looks like: "image.exe","1234",...
  return /^"[^"]+\.exe","\d+"/m.test(stdout);
}

/**
 * Extract EVERY pid from `tasklist /FO CSV /NH` output (headerless CSV rows like
 * `"image.exe","1234",...`). Used to enumerate OUR emulator images for a DIRECT
 * TerminateProcess kill, sidestepping `taskkill /T` — whose child-tree walk times
 * out (and then silently fails) when the box is under load (e.g. a CPU-pegged
 * qemu), leaving the stack orphaned. Pure + unit-testable; tolerates the
 * "No tasks…" banner and empty output (→ []).
 */
export function parseTasklistPids(stdout: string): number[] {
  if (!stdout) return [];
  const pids: number[] = [];
  const re = /^"[^"]+\.exe","(\d+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) pids.push(Number(m[1]));
  return pids;
}

/**
 * Extract EVERY process pid from pebble-tool's emulator state file
 * (%TEMP%\pb-emulator.json). The file shape is:
 *   { "<platform>": { "<sdkVersion>": {
 *       "qemu":       { "pid": <n>, ... },
 *       "pypkjs":     { "pid": <n>, ... },
 *       "websockify": { "pid": <n> } } } }
 *
 * Returns the deduped, finite, positive pids across ALL platform/version entries.
 *
 * WHY (the process-leak fix): pypkjs AND websockify both run as `python.exe`, so a
 * `taskkill /IM` by image can only safely target `qemu-pebble.exe` — it must NOT
 * blanket-kill `python.exe` (that could hit an unrelated user Python). The state
 * file is the authoritative source of OUR pids, so killAll force-kills each listed
 * pid by PID instead of leaking the python-hosted bridge + proxy.
 *
 * Pure (no fs) so it is unit-testable; tolerates missing/partial/malformed JSON
 * and non-object shapes at any level without throwing.
 */
export function parseStatePids(json: string): number[] {
  const pids = new Set<number>();
  try {
    const root = JSON.parse(json) as unknown;
    if (!root || typeof root !== "object") return [];
    for (const versions of Object.values(root as Record<string, unknown>)) {
      if (!versions || typeof versions !== "object") continue;
      for (const entry of Object.values(versions as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        for (const proc of Object.values(entry as Record<string, unknown>)) {
          const pid = (proc as { pid?: unknown } | null)?.pid;
          if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) pids.add(pid);
        }
      }
    }
  } catch {
    /* missing / partial / malformed json → no pids */
  }
  return [...pids];
}
