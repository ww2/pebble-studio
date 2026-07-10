/**
 * winTimeShim.ts — native-Windows control-file helpers for the fake clock.
 *
 * Custom time / freeze / rate is built INTO the bundled qemu-pebble.exe: the Pebble
 * RTC reads PEBBLE_FAKETIME_FILE directly (qemu hw/timer/stm32_pebble_rtc.c →
 * pebble_faketime_us()), driven by the SAME control-file contract as the Linux
 * LD_PRELOAD shim (`<target_unix|-> <rate>`). This module just resolves the control-
 * and log-file paths and writes the control file. Shell-free (Node fs), matching the
 * rest of the windows-native driver, and pure/injectable so it unit-tests on Linux.
 *
 * (An earlier increment shipped an INJECTED-DLL shim + launcher/probe self-test here;
 * it could not reach the host-clock path mingw's gettimeofday() actually uses, so it
 * was replaced by the in-qemu RTC read above and its dead code removed.)
 */
import { writeFile as fsWriteFile } from "node:fs/promises";
import { win32 as winPath } from "node:path";

/** Control file path: `%TEMP%\pb-faketime.ctl` (re-read by qemu on mtime change).
 * `%TEMP%` matches where pebble-tool writes its own state file, so the file is
 * writable and co-located. Pure (env injectable). */
export function winFakeTimeCtlPath(env: Record<string, string | undefined> = process.env): string {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  return winPath.join(temp, "pb-faketime.ctl");
}

/** Where the patched qemu writes its fake-time diagnostic log (`%TEMP%\pb-qemu-ft.log`),
 * passed to qemu as PEBBLE_FAKETIME_LOG. Confirms the control file is reaching qemu
 * and what time it serves. Pure (env injectable). */
export function winQemuFakeTimeLogPath(env: Record<string, string | undefined> = process.env): string {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  return winPath.join(temp, "pb-qemu-ft.log");
}

/**
 * Write the faketime control file: `<target_unix|-> <rate>` (same format as the
 * Linux setFakeTimeCmd). `targetUnix` null → `-` (keep current fake, rate-only);
 * rate 0 → freeze, 1 → real-time, N → N×. Integer target (quote-free, numeric); the
 * rate is written raw (this path is fs, not shell, so no quote-safety constraint).
 */
export async function writeWinFakeTime(
  ctlPath: string,
  targetUnix: number | null,
  rate: number,
  write: (p: string, data: string) => Promise<void> = (p, data) => fsWriteFile(p, data, "utf8"),
): Promise<void> {
  const t = targetUnix === null ? "-" : String(Math.trunc(targetUnix));
  await write(ctlPath, `${t} ${rate}`);
}
