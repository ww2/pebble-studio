import { PNG } from "pngjs";

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png);
}
