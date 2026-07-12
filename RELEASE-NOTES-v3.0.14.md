# Pebble Studio v3.0.14

_Released 2026-07-12 · Native-Windows track_

This release fixes an off-center display regression from v3.0.13 and reworks the
touch-alignment fix so it corrects taps **without moving the picture**. It applies
to the two touch models — **Pebble Time 2** and **Pebble Round 2**.

## Fixes

- **Watchfaces are centered again on Pebble Time 2.** v3.0.13's touch-alignment
  change had widened the watch's on-screen area to include a hidden padding strip,
  which pushed the watchface off to one side of the bezel. The screen is back to
  its correct size, so watchfaces are centered as before.
- **Touch alignment no longer moves the display.** The vertical touch correction
  is now applied purely in how a click is translated into a watch coordinate,
  instead of by resizing the on-screen watch. Taps on Pebble Time 2 and Pebble
  Round 2 land where you tap, and the watchface stays put.

## Under the hood

- The touch coordinate mapping now scales each axis by its own on-screen→watch
  ratio, instead of relying on the viewer's single aspect-preserving scale (which
  over-scaled the vertical axis once the watch canvas was stretched to fill its
  container). The horizontal correction from v3.0.13 — which lives in the bundled
  emulator — is unchanged.

---

_Full version history is in the app under **Help → What's New**._
