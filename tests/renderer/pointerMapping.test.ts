import { describe, it, expect } from "vitest";
import { fbCoordFromClick } from "../../src/renderer/pointerMapping.js";

describe("fbCoordFromClick (per-axis pointer mapping)", () => {
  // emery: rendered canvas 200×228, framebuffer 208×228 (width tile-padded).
  it("scales X by the rendered→framebuffer width ratio (matches noVNC's single scale on the limiting axis)", () => {
    // click at canvas x=100 → fb col 100*208/200 = 104. noVNC default: 100/(200/208)=104. Same.
    expect(fbCoordFromClick(100, 200, 208)).toBe(104);
    expect(fbCoordFromClick(0, 200, 208)).toBe(0);
    expect(fbCoordFromClick(199, 200, 208)).toBe(207);
  });

  it("scales Y by its OWN ratio, so a full-height canvas maps 1:1 (fixes the ~4% down drift)", () => {
    // canvas height == fb height (228) → identity. noVNC's single scale would give y*1.04 (too low).
    expect(fbCoordFromClick(114, 228, 228)).toBe(114);
    expect(fbCoordFromClick(228, 228, 228)).toBe(228);
    expect(fbCoordFromClick(50, 228, 228)).toBe(50);
  });

  it("is zoom-invariant: doubling both rendered click and rendered size gives the same fb coord", () => {
    // At 2× zoom, getBoundingClientRect and the click offset both double.
    expect(fbCoordFromClick(200, 400, 208)).toBe(fbCoordFromClick(100, 200, 208));
  });

  it("guards against a zero-sized (unmeasured) canvas", () => {
    expect(fbCoordFromClick(100, 0, 208)).toBe(0);
  });

  it("gabbro width: click maps to the padded 272 framebuffer", () => {
    // rendered 260 wide, fb 272 → x=130 → 130*272/260 = 136.
    expect(fbCoordFromClick(130, 260, 272)).toBe(136);
    // gabbro height unpadded (260) → 1:1.
    expect(fbCoordFromClick(130, 260, 260)).toBe(130);
  });
});
