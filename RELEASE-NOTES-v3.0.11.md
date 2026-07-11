# Pebble Studio v3.0.11

_Released 2026-07-11 · Native-Windows track_

This release makes "bring your own SDK" work end-to-end: a newer Pebble SDK now
actually runs its own apps, the full PebbleOS launcher is an opt-in overlay you
control (and can always undo), and the emulator's app logs are on by default.
It rolls up everything since v3.0.5. (v3.0.6 was an internal performance build
that never met the quality bar and was never released — the number is skipped.)

## Bring your own SDK — now runs newer-SDK apps

- **Uploading a newer Pebble SDK actually updates the emulator's firmware
  (#8, #11).** Previously Studio silently stamped its own bundled (older)
  firmware over every uploaded SDK to preserve the full launcher, so apps built
  with a newer SDK were rejected with *"This app requires a newer version of the
  Pebble firmware."* The bundled launcher is now only overlaid on a watch model
  when it wouldn't be a downgrade — a newer upload keeps its own firmware and
  runs its own apps.
- **"Make full-featured" gives the modern watches the full launcher _and_ runs
  latest-SDK apps.** The launcher firmware for Pebble Time 2, Pebble Round 2, and
  the new Pebble was rebuilt so it accepts apps built with newer SDKs, instead of
  rejecting them for being one app-version ahead.
- **Compatibility is now decided by real app compatibility**, not the SDK's
  release number — the "this would downgrade your firmware" warning only appears
  when apps would genuinely be rejected.

## The full launcher is now opt-in and reversible

- **Opt-in overlay.** A freshly uploaded SDK runs its own firmware as-is. A new
  **"Make full-featured"** button (Settings → Pebble SDK) overlays Studio's full
  launcher — Settings, Health, full menu — on demand, and reports, per watch
  model, whether it could. A model whose firmware is newer than our launcher is
  left alone instead of being silently downgraded.
- **Always undoable.** Applying the overlay stashes each model's original
  firmware, so **"Revert to stock firmware"** restores the SDK's own firmware in
  one click, without re-uploading.
- **Safe by default with a clear choice.** When your SDK is newer than Studio's
  bundled launcher, Studio keeps your firmware by default and explains — in a
  themed in-app dialog, not a plain Windows pop-up — that overlaying the older
  launcher would downgrade the firmware. Downgrading is still available, but only
  as a clearly-labelled, deliberate choice. Removing that Windows pop-up also
  fixes the emulator zooming in by itself after "Make full-featured."
- **No pointless reboots.** Applying the launcher no longer relaunches the
  emulator when nothing actually changed (e.g. when you decline a downgrade), and
  the emulator no longer over-zooms after a relaunch. SDK status messages now
  clear themselves — "Relaunching…" is replaced when the relaunch finishes, and
  messages auto-dismiss after a few seconds.

## Emulator app logs, on by default (#6)

- **The "Emulator logs" panel is on by default.** Watchface `APP_LOG` output and
  PebbleKit JS console messages stream live in a collapsible panel under the
  emulator, with a Copy button. The stream now rides Studio's existing emulator
  connection instead of opening a separate one, so it no longer competes with app
  installs for the bridge's limited client slots — logs keep flowing during
  installs (previously the stream was paused exactly then).
- **"Copy log" always works now** — it fell back to nothing when the clipboard
  API was unavailable.

## Reliability fixes

- **Fixed a silent crash in the connection-drain reader** (broken since v3.0.3):
  it crashed the first time the emulator connection went idle, so it effectively
  never ran — this is the protection that keeps config pages from dying with "No
  config page" after repeated opens. The app-log panel also now prints a
  confirmation line when the stream connects.
- **Swapping or resetting an SDK discards that version's instant-launch
  snapshots**, so the next launch can't restore a pre-swap firmware image.
- **"Reset to bundled" now stops an in-flight or background pre-booted
  emulator** before switching, matching Upload.
- **Pebble Health now activates on native Windows.** The activation helper was
  never wired up, so Health never turned on; it now does.

## Build

- **`npm install` auto-repairs a truncated Electron install** that newer Node
  versions can silently produce during extraction (PR #10).

---

_Full version history is in the app under **Help → What's New**._
