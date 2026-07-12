import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = readFileSync(join(repoRoot, "electron-builder.yml"), "utf8");

describe("electron-builder packages the arm64 qemu bundle", () => {
  it("has an extraResources entry copying vendor/qemu-pebble-win-arm64 to qemu-pebble-win-arm64", () => {
    expect(yml).toMatch(/from:\s*vendor\/qemu-pebble-win-arm64/);
    expect(yml).toMatch(/to:\s*qemu-pebble-win-arm64/);
  });
});
