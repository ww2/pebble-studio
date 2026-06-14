import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const svg = readFileSync(path.join(root, "build/icon.svg"), "utf8");
const sizes = [16, 24, 32, 48, 64, 128, 256];

const pngs = sizes.map((s) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: s } }).render().asPng()),
);
writeFileSync(
  path.join(root, "build/icon.png"),
  Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 512 } }).render().asPng()),
);
const ico = await pngToIco(pngs);
writeFileSync(path.join(root, "build/icon.ico"), ico);
console.log("wrote build/icon.ico (" + sizes.join(",") + ") + build/icon.png (512)");
