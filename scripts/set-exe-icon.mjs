// Post-build: embed the app icon + version strings into the packaged Windows
// .exe using resedit (pure JS — works on Linux/WSL without wine, unlike
// electron-builder's rcedit path which we disable via signAndEditExecutable:false).
import * as ResEdit from "resedit";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const exePath = path.join(root, "release/win-unpacked/Pebble Studio.exe");
const icoPath = path.join(root, "build/icon.ico");
const version = createRequire(import.meta.url)(path.join(root, "package.json")).version;

if (!existsSync(exePath)) { console.error("[set-exe-icon] exe not found:", exePath); process.exit(1); }
if (!existsSync(icoPath)) { console.error("[set-exe-icon] icon not found:", icoPath); process.exit(1); }

const exe = ResEdit.NtExecutable.from(readFileSync(exePath));
const res = ResEdit.NtExecutableResource.from(exe);

// Replace the icon group (Electron's default group id is 1) with our icon's sizes.
const iconFile = ResEdit.Data.IconFile.from(readFileSync(icoPath));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  1,
  1033, // en-US
  iconFile.icons.map((i) => i.data),
);

// Version / product strings so the exe reads "Pebble Studio v<version>".
const [maj, min, pat] = version.split(".").map((n) => parseInt(n, 10) || 0);
const vi = ResEdit.Resource.VersionInfo.createEmpty();
vi.setFileVersion(maj, min, pat, 0, 1033);
vi.setProductVersion(maj, min, pat, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  ProductName: "Pebble Studio",
  FileDescription: "Pebble Studio",
  CompanyName: "Jason Lin",
  LegalCopyright: `Copyright © ${new Date().getFullYear()} Jason Lin`,
  OriginalFilename: "Pebble Studio.exe",
  InternalName: "Pebble Studio",
  ProductVersion: version,
  FileVersion: version,
});
vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`[set-exe-icon] embedded ${iconFile.icons.length} icon sizes + v${version} into ${path.basename(exePath)}`);
