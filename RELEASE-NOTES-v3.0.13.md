# Pebble Studio v3.0.13

_Released 2026-07-12 · Native-Windows track_

This release fixes touch input on **Pebble Time 2** (emery) and restores touch
while the live **Sunlight** correction overlay is on. Both fixes ship on Intel/AMD
and Windows-on-ARM PCs.

## Touch fixes

- **Pebble Time 2 taps now land where you tap.** Previously touches registered low
  and slightly to the left of where you clicked — for example, tapping the top row
  of an on-screen keypad registered as the row below. The emulator's screen and its
  touch panel disagreed about the screen's exact pixel width; they now agree, so
  taps map 1:1 on both axes.
- **Touch no longer dies while Sunlight correction is on.** With the correction
  overlay active in the live view, taps stopped registering on the watch. The
  overlay was hiding the interactive layer beneath it in a way that also blocked
  clicks; it now stays interactive, so taps pass through to the emulator as normal.

## Under the hood

- The touch-alignment fix lives in the bundled `qemu-pebble` emulator (the abs
  touch X is de-normalized against the true, tile-aligned framebuffer width and
  clamped in range). Both the Intel/AMD and the native-ARM emulator builds were
  rebuilt with it, so the fix works on every supported PC.
- The Sunlight overlay now hides the raw frame with `opacity` instead of
  `visibility`, keeping the emulator's canvas hit-testable so pointer events reach
  it through the (non-interactive) overlay.

---

_Full version history is in the app under **Help → What's New**._
