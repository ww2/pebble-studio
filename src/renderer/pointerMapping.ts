/**
 * Per-axis pointer mapping for the touch boards (emery/gabbro).
 *
 * Map a click offset along ONE axis (in rendered-canvas CSS px) to a framebuffer
 * coordinate, scaling that axis by its OWN rendered→framebuffer ratio.
 *
 * Why this exists: the touch boards' QEMU framebuffer width is padded up to a
 * 16px tile boundary (emery 200→208, gabbro 260→272), so the framebuffer aspect
 * (e.g. 208:228) differs from the on-screen container aspect (200:228). noVNC's
 * pointer path (`Display.absX/absY`) divides BOTH axes by a single
 * aspect-preserving scale (the width-limited 200/208 for emery). Meanwhile
 * Studio's `.emu-screen canvas{width/height:100%!important}` stretches the canvas
 * to fill the container, so vertically the canvas is really 1:1 with the
 * container height — the single scale then over-scales Y by 208/200 and taps land
 * ~4% low. Scaling EACH axis by its own ratio removes that: X stays correct
 * (matches the single-scale result on the limiting axis) and Y becomes exact,
 * WITHOUT resizing the on-screen watch (the display stays centered, unlike the
 * reverted "grow the container to the padded width" approach). Zoom is a uniform
 * CSS transform, so `renderedPx` (a getBoundingClientRect measurement) scales
 * with it and the ratio is unaffected.
 */
export function fbCoordFromClick(clickPx: number, renderedPx: number, fbPx: number): number {
  if (renderedPx <= 0) return 0;
  const px = Math.round((clickPx * fbPx) / renderedPx);
  // Clamp into the framebuffer [0, fbPx-1]. Rounding the last on-screen pixel at
  // high zoom can land exactly on fbPx (one past the edge); truncating parity
  // with noVNC's original `| 0` keeps it in range.
  return Math.min(Math.max(fbPx - 1, 0), Math.max(0, px));
}
