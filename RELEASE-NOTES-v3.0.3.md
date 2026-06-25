# Pebble Studio v3.0.3

_Released 2026-06-24 · Native-Windows track_

This release makes custom time gentler on animated watchfaces, gets your
watchface on screen faster after boot, removes a cluster of "right after boot"
first-action failures, and adds the ability to bring your own Pebble SDK.

## Time & watchface rendering

- **"Frozen" custom time no longer thrashes animated watchfaces.** Previously,
  Frozen (rate 0) made the firmware re-fire the minute tick in a tight loop, so
  faces with a per-minute animation replayed it many times a second. Frozen now
  nudges the clock forward imperceptibly slowly, so the watch looks frozen
  without the tick loop — static faces are unaffected as before.

## Faster boot & reliable install

- **Your watchface appears much faster after the emulator boots.** Health
  activation used to run first and could hold the watchface back by up to
  ~10 seconds (sometimes leaving you on the launcher to open it by hand). It now
  runs in the background *after* your watchface loads.
- **Dropping in a watchface right after a reboot no longer flakes.** Installing
  immediately after boot — especially with the "Show emulator logs" panel open —
  could fail with a spurious "install failed". Pebble Studio now lets the phone
  bridge free its connection slot and retries a momentarily-busy install.

## New: bring your own Pebble SDK

- **Settings → Pebble SDK.** See which SDK version is in use and upload your own
  (a Pebble `sdk-core` `.tar.bz2` / `.zip` archive, or its extracted folder) to
  replace the bundled one. Your SDK **persists across updates** until you upload
  another or reset to the bundled one. The full PebbleOS launcher
  (Settings · Health · full menu) is kept automatically on an uploaded SDK, and
  if the emulator is running it relaunches itself to apply the change. The active
  SDK version is also shown in **Help → What's New**.

## First-boot reliability (battery & Clay config)

- **Setting the battery level right after boot no longer errors.** Pebble Studio
  waits for the watch to finish starting up and retries, instead of giving up
  while the phone bridge is still connecting.
- **Opening a watchface's config (the gear) right after boot no longer shows a
  misleading "No config page".** It now retries while the watchface and phone
  bridge finish starting up before reporting that an app has no config page.

## Clay config robustness

- **Repeated config opens stay working.** Opening the gear several times in a row
  could fail with "No config page" from the second or third open onward and stay
  broken until you relaunched. The phone bridge could get stuck sending the large
  config page to a client that wasn't reading it, which froze the watch's
  JavaScript. The bridge now stays drained and can't be blocked, so the gear keeps
  working no matter how many times you open it.

## UI polish

- **App Library "loaded" badges now clear** when the emulator stops, is
  force-closed, or relaunches — they no longer linger as if apps were still
  running on a watch that isn't.
- **Settings is less cluttered:** longer explanations are now tucked behind a
  small "?" icon you can hover (or focus) for the full description, instead of
  always-on paragraphs of text.

---

_Full version history is in the app under **Help → What's New**._
