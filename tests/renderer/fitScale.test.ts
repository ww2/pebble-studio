import { describe, it, expect, vi } from "vitest";

// EmulatorView transitively imports vncClient -> @novnc/novnc, which touches
// `window` at module load (fine in the browser/Vite bundle, not under node).
// Stub the package so we can import the pure, DOM-free `fitScale` helper here.
vi.mock("@novnc/novnc", () => ({ default: class {} }));

import { fitScale } from "../../src/renderer/components/EmulatorView.js";

describe("fitScale", () => {
  it("picks the limiting dimension (width-bound)", () => {
    // avail 600x600, natural 300x200 -> width ratio 2, height ratio 3 -> min 2
    expect(fitScale(600, 600, 300, 200)).toBe(2);
  });

  it("picks the limiting dimension (height-bound)", () => {
    // avail 600x400, natural 300x300 -> width 2, height 1.333 -> min 1.333
    expect(fitScale(600, 400, 300, 300)).toBeCloseTo(4 / 3, 10);
  });

  it("clamps to the ceiling of 6", () => {
    // huge avail, tiny natural -> would be 100, clamped to 6
    expect(fitScale(6000, 6000, 60, 60)).toBe(6);
  });

  it("clamps to the floor of 0.25", () => {
    // tiny avail, huge natural -> would be 0.05, clamped to 0.25
    expect(fitScale(50, 50, 1000, 1000)).toBe(0.25);
  });

  it("returns 0 for non-positive inputs (caller bails)", () => {
    expect(fitScale(0, 600, 300, 300)).toBe(0);
    expect(fitScale(600, 0, 300, 300)).toBe(0);
    expect(fitScale(600, 600, 0, 300)).toBe(0);
    expect(fitScale(600, 600, 300, 0)).toBe(0);
    expect(fitScale(-1, 600, 300, 300)).toBe(0);
  });

  it("does NOT over-scale when fed the settled (target) natural size", () => {
    // Regression for the model-switch bug: with Fit, switching aplite->gabbro must
    // measure the SETTLED gabbro frame (288 body + 2*18 round pad + 2*1 border =
    // 326), not the transient aplite frame (167 body + 2*16 + 2*1 = 201). Using the
    // larger, correct natural size yields a SMALLER scale (no oversize).
    const avail = 700; // square available box for the comparison
    const gabbroNatural = 288 + 2 * 18 + 2 * 1; // 326 (settled target)
    const apliteNatural = 167 + 2 * 16 + 2 * 1; // 201 (stale, mid-morph)
    const correct = fitScale(avail, avail, gabbroNatural, gabbroNatural);
    const buggy = fitScale(avail, avail, apliteNatural, apliteNatural);
    expect(correct).toBeLessThan(buggy); // the fix shrinks the over-scale
    expect(correct).toBeCloseTo(avail / gabbroNatural, 10);
  });
});
