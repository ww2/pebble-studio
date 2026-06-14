/**
 * winPath — normalize a path for native use by pebble.exe on Windows.
 *
 * On native Windows the dropped/picked `.pbw` is ALREADY a Windows path
 * (`C:\Users\you\app.pbw`), so unlike the WSL driver there is no `/mnt/c`
 * translation to do. We only normalize slashes to backslashes (Win32 accepts
 * both, but a canonical form keeps diagnostics/logging consistent). The leading
 * `\\` of a UNC path is preserved.
 *
 * - Empty string is returned unchanged (defensive).
 */
export function winPath(p: string): string {
  if (!p) return p;
  const isUnc = p.startsWith("\\\\") || p.startsWith("//");
  const body = p.replace(/[\\/]+/g, "\\");
  // Re-assert the UNC double-backslash prefix (the collapse above reduced it to one).
  return isUnc ? "\\" + body : body;
}
