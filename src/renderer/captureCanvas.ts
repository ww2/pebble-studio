import { upscaleNearest, type RgbaImage } from "../capture/upscale.js";

/**
 * Apply a circular mask to an RGBA image.
 * Pixels OUTSIDE the inscribed circle (centered, radius = min(w,h)/2) are set
 * to alpha 0. Pixels inside are unchanged. Returns a new RgbaImage (copy).
 */
export function applyCircularMask(image: RgbaImage): RgbaImage {
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

/**
 * Read pixel data from the noVNC canvas inside `host`.
 * noVNC renders into a <canvas> child; we draw it onto a fresh canvas first
 * to avoid any cross-origin or taint issues, then call getImageData.
 */
export function grabFrame(host: HTMLElement): RgbaImage {
  const vncCanvas = host.querySelector("canvas");
  if (!vncCanvas) throw new Error("No canvas found inside host element");

  const w = vncCanvas.width || vncCanvas.offsetWidth;
  const h = vncCanvas.height || vncCanvas.offsetHeight;

  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d")!;
  ctx.drawImage(vncCanvas, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  return { data: new Uint8Array(imageData.data.buffer), width: w, height: h };
}

/** Grab frame and apply integer nearest-neighbor upscale. */
export function grabUpscaled(host: HTMLElement, factor: number): RgbaImage {
  const frame = grabFrame(host);
  return upscaleNearest(frame.data, frame.width, frame.height, factor);
}

/**
 * Convert an RgbaImage to a PNG Blob using an offscreen canvas.
 * Uses the browser-native canvas PNG encoder — no pngjs needed in the renderer.
 */
export function rgbaToBlob(image: RgbaImage): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  const clampedData = new Uint8ClampedArray(image.data.length);
  clampedData.set(image.data);
  const imageData = new ImageData(clampedData, image.width, image.height);
  ctx.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
