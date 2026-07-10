/**
 * Shared circular-alpha-mask kernel for the round-board screenshot scripts.
 *
 * Zeroes the alpha of every pixel OUTSIDE the inscribed circle (centered,
 * radius = min(w,h)/2), sampling at pixel centers (`+0.5`) with a strict `>`
 * boundary. Mutates `data` in place and returns it.
 *
 * This is ONE of several in-sync copies of the same algorithm — keep them
 * identical:
 *   - src/renderer/captureCanvas.ts         (renderer canvas path)
 *   - src/main/backend/circularMaskPng.ts   (main framebuffer PNG path)
 *   - scripts/circular-mask.mjs             (this file — both round-board scripts)
 */
export function maskRgbaCircle(data, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2;
  const r2 = r * r;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) data[(y * width + x) * 4 + 3] = 0;
    }
  }
  return data;
}
