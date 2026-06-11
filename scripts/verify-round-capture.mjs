/**
 * Headless proof: verify that a round-masked PNG has alpha=0 at corners
 * and alpha=255 at center.
 *
 * We replicate the applyCircularMask algorithm and use pngjs to encode
 * and then re-decode the PNG, confirming the alpha channel is preserved.
 */
import { PNG } from "pngjs";

// ---- replicate applyCircularMask from src/renderer/captureCanvas.ts ----
function applyCircularMask(image) {
  const { width, height } = image;
  const out = new Uint8Array(image.data);
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2;
  const r2 = r * r;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) {
        const i = (y * width + x) * 4;
        out[i + 3] = 0;
      }
    }
  }
  return { data: out, width, height };
}

// ---- build a solid-white 180×180 image (like chalk/gabbro dimensions) ----
const W = 180, H = 180;
const rawRgba = new Uint8Array(W * H * 4);
for (let i = 0; i < rawRgba.length; i += 4) {
  rawRgba[i] = 200; rawRgba[i+1] = 150; rawRgba[i+2] = 100; rawRgba[i+3] = 255;
}

const masked = applyCircularMask({ data: rawRgba, width: W, height: H });

// ---- encode to PNG via pngjs ----
const png = new PNG({ width: W, height: H, colorType: 6 }); // colorType 6 = RGBA
const buf = Buffer.from(masked.data.buffer);
buf.copy(png.data);
const pngBuf = PNG.sync.write(png);

// ---- decode back and verify ----
const decoded = PNG.sync.read(pngBuf);

function alpha(img, x, y) {
  return img.data[(y * img.width + x) * 4 + 3];
}
function rgb(img, x, y) {
  const i = (y * img.width + x) * 4;
  return `rgb(${img.data[i]},${img.data[i+1]},${img.data[i+2]})`;
}

console.log(`PNG dimensions: ${decoded.width}×${decoded.height}`);
console.log(`PNG has alpha channel: ${decoded.alpha}`);

const cx = Math.floor(W / 2);
const cy = Math.floor(H / 2);
const centerAlpha = alpha(decoded, cx, cy);
const corner00Alpha = alpha(decoded, 0, 0);
const cornerNEAlpha = alpha(decoded, W - 1, 0);
const cornerSWAlpha = alpha(decoded, 0, H - 1);
const cornerSEAlpha = alpha(decoded, W - 1, H - 1);

console.log(`\nCenter  (${cx},${cy}): alpha=${centerAlpha} ${rgb(decoded, cx, cy)}`);
console.log(`Corner  (0,0):         alpha=${corner00Alpha}`);
console.log(`Corner  (${W-1},0):      alpha=${cornerNEAlpha}`);
console.log(`Corner  (0,${H-1}):      alpha=${cornerSWAlpha}`);
console.log(`Corner  (${W-1},${H-1}):   alpha=${cornerSEAlpha}`);

let pass = true;
if (centerAlpha !== 255) { console.error(`FAIL: center alpha should be 255, got ${centerAlpha}`); pass = false; }
if (corner00Alpha !== 0) { console.error(`FAIL: corner (0,0) alpha should be 0, got ${corner00Alpha}`); pass = false; }
if (cornerNEAlpha !== 0) { console.error(`FAIL: corner NE alpha should be 0, got ${cornerNEAlpha}`); pass = false; }
if (cornerSWAlpha !== 0) { console.error(`FAIL: corner SW alpha should be 0, got ${cornerSWAlpha}`); pass = false; }
if (cornerSEAlpha !== 0) { console.error(`FAIL: corner SE alpha should be 0, got ${cornerSEAlpha}`); pass = false; }

if (pass) {
  console.log("\nPASS: round PNG has transparent corners + opaque center.");
} else {
  process.exit(1);
}

// ---- Also verify square capture is unchanged (no mask) ----
console.log("\n--- Square capture (no mask) ---");
const sqDecoded = PNG.sync.read(
  (() => {
    const p = new PNG({ width: W, height: H, colorType: 6 });
    Buffer.from(rawRgba.buffer).copy(p.data);
    return PNG.sync.write(p);
  })()
);
const sqCornerAlpha = alpha(sqDecoded, 0, 0);
const sqCenterAlpha = alpha(sqDecoded, cx, cy);
console.log(`Square corner (0,0) alpha: ${sqCornerAlpha} (expect 255)`);
console.log(`Square center alpha: ${sqCenterAlpha} (expect 255)`);
if (sqCornerAlpha !== 255 || sqCenterAlpha !== 255) {
  console.error("FAIL: square capture corners should be opaque");
  process.exit(1);
}
console.log("PASS: square capture is fully opaque.");
