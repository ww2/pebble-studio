# Pebble Studio v3.0.12

_Released 2026-07-12 · Native-Windows track_

This release brings Pebble Studio to **Windows-on-ARM** PCs. It's the same single
download you already use — no separate ARM build to pick.

## Runs on Windows-on-ARM

- **Pebble Studio now runs on Windows-on-ARM PCs.** The one download works on both
  regular (Intel/AMD) and ARM machines. On an ARM PC, Studio automatically switches
  the watch emulator to a native-ARM engine, so it boots normally instead of failing
  with *"failed to load."* Nothing changes on Intel/AMD PCs — they keep using the
  same engine as before.
- **No new choice to make.** Studio detects the real CPU at launch (even when Windows
  reports the app as x86 under emulation) and selects the right emulator engine for
  you. If the native-ARM engine isn't present for some reason, it safely falls back
  to the standard one rather than failing.

## Under the hood

- The universal download now also bundles a native-ARM build of the `qemu-pebble`
  emulator, selected at runtime by the host CPU.
- Added a CI pipeline that builds and boot-tests the native-ARM emulator on ARM
  hardware, covering both watch CPU families, so the ARM engine is verified before
  it ships.

---

_Full version history is in the app under **Help → What's New**._
