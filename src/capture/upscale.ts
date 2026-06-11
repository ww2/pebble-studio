export interface RgbaImage { data: Uint8Array; width: number; height: number; }

export function upscaleNearest(src: Uint8Array, width: number, height: number, factor: number): RgbaImage {
  if (factor === 1) return { data: src, width, height };
  const outW = width * factor, outH = height * factor;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor(x / factor);
      const si = (sy * width + sx) * 4;
      const di = (y * outW + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}
