import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { applyCircularMaskToPngFile } from "../../src/main/backend/circularMaskPng.js";

/** Write a solid-color opaque RGBA PNG to disk and return its path. */
async function writeSolidPng(dir: string, name: string, w: number, h: number): Promise<string> {
  const png = new PNG({ width: w, height: h, colorType: 6 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200; png.data[i + 1] = 150; png.data[i + 2] = 100; png.data[i + 3] = 255;
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, PNG.sync.write(png));
  return file;
}

function alpha(img: PNG, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3];
}

describe("applyCircularMaskToPngFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mask-test-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("zeros corner alpha and keeps center opaque (chalk 180x180)", async () => {
    const file = await writeSolidPng(dir, "chalk.png", 180, 180);
    await applyCircularMaskToPngFile(file);
    const img = PNG.sync.read(await fs.readFile(file));
    expect(alpha(img, 0, 0)).toBe(0);
    expect(alpha(img, 179, 0)).toBe(0);
    expect(alpha(img, 0, 179)).toBe(0);
    expect(alpha(img, 179, 179)).toBe(0);
    expect(alpha(img, 90, 90)).toBe(255);
  });

  it("preserves RGB of unmasked pixels (gabbro 260x260)", async () => {
    const file = await writeSolidPng(dir, "gabbro.png", 260, 260);
    await applyCircularMaskToPngFile(file);
    const img = PNG.sync.read(await fs.readFile(file));
    const ci = (130 * img.width + 130) * 4;
    expect(img.data[ci]).toBe(200);
    expect(img.data[ci + 1]).toBe(150);
    expect(img.data[ci + 2]).toBe(100);
    expect(img.data[ci + 3]).toBe(255);
  });
});
