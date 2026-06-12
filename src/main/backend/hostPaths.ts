/** Host-side paths for the emulator stack. Today: POSIX (native Linux or WSL).
 * A future WindowsNativeDriver swaps these for %TEMP%-based equivalents —
 * pebble-tool itself writes the state file to tempfile.gettempdir().
 *
 * All three are embedded UNQUOTED in shell command lines (which may cross the
 * wsl.exe -- bash -lc boundary), so they must stay quote-free and space-free;
 * $HOME is expanded in-distro by bash. tests/backend/hostPaths.test.ts enforces
 * that shape. */
export const EMU_INFO_PATH = "/tmp/pb-emulator.json";
export const EMU_LOG_PATH = "/tmp/pebble-emu.log";
export const SDK_ROOT = "$HOME/.local/share/pebble-sdk/SDKs/current";
