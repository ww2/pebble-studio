import fs from "node:fs/promises";
import { PNG } from "pngjs";

/**
 * Apply a circular alpha mask to an on-disk PNG, IN PLACE.
 *
 * The framebuffer screenshot path (`pebble screenshot`) writes a plain
 * rectangular PNG straight to disk, so a round watch (chalk, gabbro) lands with
 * solid-black corners outside the watchface. The renderer's canvas path already
 * masks those corners to transparent via `applyCircularMask`; this is the
 * matching post-process for the framebuffer path so BOTH screenshot routes emit
 * a transparent-cornered circle on round boards.
 *
 * Pixels OUTSIDE the inscribed circle (centered, radius = min(w,h)/2) get
 * alpha 0; pixels inside are untouched. Re-encoded as RGBA (colorType 6).
 *
 * This is ONE of the in-sync copies of the mask algorithm — keep them identical:
 *   - src/renderer/captureCanvas.ts   (renderer canvas path)
 *   - src/main/backend/circularMaskPng.ts  (this file — framebuffer PNG path)
 *   - scripts/circular-mask.mjs       (both round-board screenshot scripts)
 */
export async function applyCircularMaskToPngFile(filePath: string): Promise<void> {
  const buf = await fs.readFile(filePath);
  const png = PNG.sync.read(buf); // pngjs normalizes .data to RGBA
  const { width, height, data } = png;
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2;
  const r2 = r * r;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) {
        data[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  const out = PNG.sync.write(png, { colorType: 6 });
  await fs.writeFile(filePath, out);
}
