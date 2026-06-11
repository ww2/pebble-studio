import { describe, it, expect } from "vitest";
import { upscaleNearest } from "../../src/capture/upscale.js";

describe("upscaleNearest", () => {
  // 2x2 RGBA image: red, green / blue, white
  const src = new Uint8Array([
    255,0,0,255,   0,255,0,255,
    0,0,255,255,   255,255,255,255,
  ]);

  it("returns the source unchanged at factor 1", () => {
    const out = upscaleNearest(src, 2, 2, 1);
    expect(out.data).toEqual(src);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });

  it("doubles dimensions at factor 2 and replicates pixels", () => {
    const out = upscaleNearest(src, 2, 2, 2);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    const px = (x: number, y: number) => out.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
    expect(Array.from(px(0, 0))).toEqual([255, 0, 0, 255]);
    expect(Array.from(px(1, 1))).toEqual([255, 0, 0, 255]);
    expect(Array.from(px(2, 0))).toEqual([0, 255, 0, 255]);
  });
});
