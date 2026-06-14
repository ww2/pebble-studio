/** Pure Windows process helpers for the windows-native boot deps. argv only — no shell. */

/** `tasklist` argv to query one image name in headerless CSV. */
export function tasklistArgs(imageName: string): string[] {
  return ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"];
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

/** `taskkill` argv: force-kill an image and its child tree. */
export function taskkillByImageArgs(imageName: string): string[] {
  return ["/IM", imageName, "/T", "/F"];
}

/** `taskkill` argv: force-kill a pid and its child tree. */
export function taskkillByPidArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}
