// tests/renderer/sunlightLut.test.ts
import { describe, it, expect } from "vitest";
import { applySunlightLut } from "../../src/renderer/sunlightLut.js";

describe("applySunlightLut", () => {
  it("maps pure blue (0,0,255) -> (0,104,202), alpha preserved", () => {
    const d = new Uint8Array([0, 0, 255, 200]);
    applySunlightLut(d);
    expect([d[0], d[1], d[2]]).toEqual([0, 104, 202]);
    expect(d[3]).toBe(200);
  });
  it("maps pure red (255,0,0) -> (227,84,98) and green (0,255,0) -> (142,227,145)", () => {
    const d = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    applySunlightLut(d);
    expect([d[0], d[1], d[2]]).toEqual([227, 84, 98]);
    expect([d[4], d[5], d[6]]).toEqual([142, 227, 145]);
  });
  it("black and white are unchanged (identity)", () => {
    const d = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    applySunlightLut(d);
    expect(Array.from(d)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
  it("snaps near-grid colours before mapping (250 -> 255 bucket)", () => {
    const d = new Uint8Array([2, 3, 250, 255]); // ~ (0,0,255)
    applySunlightLut(d);
    expect([d[0], d[1], d[2]]).toEqual([0, 104, 202]);
  });

  // A dimming backlight scales the framebuffer to OFF-grid values. With nearest-
  // grid snapping those values cross the snap thresholds in discrete jumps, so a
  // smooth fade recolours in steps (the "three colour changes" bug). Interpolation
  // makes an intermediate brightness map to a colour strictly between its two
  // neighbouring nominal corrected colours.
  it("interpolates an intermediate blue between its two grid-node colours", () => {
    const d = new Uint8Array([0, 0, 128, 255]); // half-bright blue, off-grid
    applySunlightLut(d);
    // node 1 (0,0,85)->(0,30,65), node 2 (0,0,170)->(0,67,135); 128 sits between.
    expect(d[1]).toBeGreaterThan(30);
    expect(d[1]).toBeLessThan(67);
    expect(d[2]).toBeGreaterThan(65);
    expect(d[2]).toBeLessThan(135);
  });

  // The core regression: dimming a nominal colour to black must recolour SMOOTHLY,
  // never in big stepwise jumps. Sweep pure blue 255->0 one level at a time and
  // assert no single 1-level brightness step shifts an output channel by a lot.
  // Under nearest-grid snapping the green channel jumps ~67 at a threshold; under
  // interpolation each step is a handful of units.
  it("a one-level dim sweep never jumps an output channel abruptly", () => {
    let prevG = -1;
    let maxStep = 0;
    for (let b = 255; b >= 0; b--) {
      const d = new Uint8Array([0, 0, b, 255]);
      applySunlightLut(d);
      if (prevG >= 0) maxStep = Math.max(maxStep, Math.abs(d[1] - prevG));
      prevG = d[1];
    }
    expect(maxStep).toBeLessThanOrEqual(8);
  });
});
