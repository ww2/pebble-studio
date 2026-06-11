import { describe, it, expect } from "vitest";
import { applyCircularMask } from "../../src/renderer/captureCanvas.js";

describe("applyCircularMask", () => {
  /**
   * Build a solid-white RGBA image of given dimensions.
   * All pixels start with alpha = 255.
   */
  function solidWhite(width: number, height: number) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
    }
    return { data, width, height };
  }

  function alpha(image: { data: Uint8Array; width: number; height: number }, x: number, y: number): number {
    return image.data[(y * image.width + x) * 4 + 3];
  }

  it("does not mutate the source image", () => {
    const src = solidWhite(10, 10);
    const srcCopy = new Uint8Array(src.data);
    applyCircularMask(src);
    expect(src.data).toEqual(srcCopy);
  });

  it("center pixel of a round-masked image has alpha 255", () => {
    const size = 100;
    const src = solidWhite(size, size);
    const out = applyCircularMask(src);
    // Center pixel should be inside the circle
    expect(alpha(out, size / 2, size / 2)).toBe(255);
  });

  it("corner pixels of a round-masked image have alpha 0", () => {
    const size = 100;
    const src = solidWhite(size, size);
    const out = applyCircularMask(src);
    // All four corners are outside the inscribed circle
    expect(alpha(out, 0, 0)).toBe(0);
    expect(alpha(out, size - 1, 0)).toBe(0);
    expect(alpha(out, 0, size - 1)).toBe(0);
    expect(alpha(out, size - 1, size - 1)).toBe(0);
  });

  it("works for non-square images (rectangle) — inscribed circle uses min dimension", () => {
    const width = 180;
    const height = 180;
    const src = solidWhite(width, height);
    const out = applyCircularMask(src);
    // Corners should be transparent
    expect(alpha(out, 0, 0)).toBe(0);
    // Center should be opaque
    expect(alpha(out, width / 2, height / 2)).toBe(255);
  });

  it("preserves RGB values of unmasked pixels and only zeros alpha for masked ones", () => {
    const size = 10;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 100; data[i + 1] = 150; data[i + 2] = 200; data[i + 3] = 255;
    }
    const src = { data, width: size, height: size };
    const out = applyCircularMask(src);
    // Center pixel: RGB unchanged, alpha 255
    const ci = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
    expect(out.data[ci]).toBe(100);
    expect(out.data[ci + 1]).toBe(150);
    expect(out.data[ci + 2]).toBe(200);
    expect(out.data[ci + 3]).toBe(255);
    // Corner pixel (0,0): alpha 0
    expect(out.data[3]).toBe(0);
  });
});
