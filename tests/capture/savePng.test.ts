import { describe, it, expect } from "vitest";
import { encodePng } from "../../src/capture/savePng.js";
import { PNG } from "pngjs";

describe("encodePng", () => {
  it("encodes RGBA into a decodable PNG of the right size", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const buf = encodePng(rgba, 2, 2);
    const decoded = PNG.sync.read(Buffer.from(buf));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.data[0]).toBe(255); // first pixel red channel
  });
});
