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
});
