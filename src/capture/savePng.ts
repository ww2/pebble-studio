import { PNG } from "pngjs";

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // pngjs reads exactly width*height*4 bytes; a mismatched view yields a corrupt
  // PNG or an out-of-bounds read, so reject it loudly.
  if (rgba.byteLength !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} RGBA bytes, got ${rgba.byteLength}`);
  }
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png);
}
