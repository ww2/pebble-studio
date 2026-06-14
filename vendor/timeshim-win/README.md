# timeshim-win — native-Windows qemu fake-clock (injected DLL)

The Windows analog of `vendor/timeshim/` (the Linux LD_PRELOAD shim). Gives the
native-Windows track true custom date / freeze / time-rate by faking the qemu
process's wall clock.

## Files
- `timeshim-win.c` → `timeshim-win.dll` — inline-hooks KERNEL32
  `GetSystemTimeAsFileTime` + `GetSystemTimePreciseAsFileTime` (which MinGW's
  `clock_gettime(CLOCK_REALTIME)`/`gettimeofday` — the calls qemu-pebble makes —
  bottom out on) and serves a fake clock from the control file
  `%TEMP%\pb-faketime.ctl` (`<target_unix|-> <rate>`, same contract as the Linux
  shim). Real elapsed time comes from `QueryPerformanceCounter`, so no trampoline.
- `launcher.c` → `launcher.exe` — pointed at by `PEBBLE_QEMU_PATH`; pebble-tool
  spawns it as "qemu". It `CreateProcess(real qemu, SUSPENDED)` → injects the DLL
  via remote-thread `LoadLibraryW` → resumes. Reads `PEBBLE_FAKETIME_REAL_QEMU`
  and `PEBBLE_FAKETIME_DLL` (set by `createDriver`).
- `probe.c` → `probe.exe` — self-test target; prints `clock_gettime` once.
  `winTimeShim.ensureWinTimeShim()` runs it through the launcher with
  `PEBBLE_FAKETIME_OFFSET=86400` and checks the printed value jumped.

## Build (MSYS2 MinGW, x86_64)
```sh
export PATH="/c/msys64/mingw64/bin:$PATH"
gcc -O2 -shared -static-libgcc -o timeshim-win.dll timeshim-win.c -lkernel32
gcc -O2 -static -o launcher.exe launcher.c
gcc -O2 -static -o probe.exe probe.c -lpthread
```

The three binaries are bundled as `resources/timeshim-win` via
`electron-builder.yml`. `src/main/backend/winTimeShim.ts` is the TS integration.
