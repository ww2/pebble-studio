/**
 * Apply a circular alpha mask to a PNG screenshot IN PLACE (or to a new file).
 *
 * Round Pebble boards (chalk, gabbro) render a circular watchface on a black
 * rectangle, so a raw `pebble screenshot` lands with solid-black corners. This
 * zeroes the alpha outside the inscribed circle so the saved PNG is a clean
 * transparent-cornered circle — the same masking the app applies.
 *
 * Usage:
 *   node scripts/mask-round-screenshot.mjs <in.png> [out.png]
 * If out.png is omitted, the input file is overwritten.
 */
import { PNG } from "pngjs";
import fs from "node:fs";
import { maskRgbaCircle } from "./circular-mask.mjs";

const inPath = process.argv[2];
const outPath = process.argv[3] ?? inPath;
if (!inPath) {
  console.error("usage: node scripts/mask-round-screenshot.mjs <in.png> [out.png]");
  process.exit(2);
}

const png = PNG.sync.read(fs.readFileSync(inPath));
const { width, height, data } = png;
maskRgbaCircle(data, width, height);
fs.writeFileSync(outPath, PNG.sync.write(png, { colorType: 6 }));
console.log(`masked ${width}x${height} circle -> ${outPath}`);
