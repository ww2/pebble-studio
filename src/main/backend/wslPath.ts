/**
 * toWslPath — translate a Windows absolute path to its WSL mount equivalent.
 *
 * On a Windows host, dropped/picked `.pbw` files arrive as Windows paths
 * (`C:\Users\you\app.pbw`). Those cannot be opened by `pebble` running inside
 * WSL, which sees the world through `/mnt/<drive>/...` mounts. This pure helper
 * does the translation so the caller can hand a usable path across the boundary.
 *
 * Rules:
 *   - `C:\Users\x\a.pbw` -> `/mnt/c/Users/x/a.pbw` (drive lower-cased, `\` -> `/`).
 *   - An already-POSIX path (starts with `/`) is returned unchanged.
 *   - A UNC / `\\wsl$\...` / `\\wsl.localhost\...` path already points at the WSL
 *     filesystem, so we only normalize backslashes to forward slashes.
 *   - Spaces are preserved verbatim — quoting is the caller's job.
 *   - An empty string is returned unchanged (defensive).
 */
export function toWslPath(p: string): string {
  if (!p) return p;

  // Already POSIX — nothing to translate.
  if (p.startsWith("/")) return p;

  // UNC / \\wsl$ / \\wsl.localhost — already the WSL filesystem; just normalize slashes.
  if (p.startsWith("\\\\")) return p.replace(/\\/g, "/");

  // Drive-letter path: `<letter>:\...` -> `/mnt/<letter>/...`.
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) {
    const letter = drive[1].toLowerCase();
    const rest = drive[2].replace(/\\/g, "/");
    return `/mnt/${letter}/${rest}`;
  }

  // Not a recognized Windows path shape — normalize slashes and return as-is.
  return p.replace(/\\/g, "/");
}
