import { describe, it, expect } from "vitest";
import { PLATFORMS, getPlatform, listPlatformIds } from "../../src/main/backend/emulatorRegistry.js";

describe("emulatorRegistry", () => {
  it("lists all seven supported platforms", () => {
    expect(listPlatformIds().sort()).toEqual(
      ["aplite", "basalt", "chalk", "diorite", "emery", "flint", "gabbro"].sort()
    );
  });

  it("marks only emery and gabbro as touch-capable", () => {
    const touch = PLATFORMS.filter((p) => p.touch).map((p) => p.id).sort();
    expect(touch).toEqual(["emery", "gabbro"]);
  });

  it("returns chalk as a round color display", () => {
    const chalk = getPlatform("chalk");
    expect(chalk.round).toBe(true);
    expect(chalk.color).toBe(true);
    expect(chalk.width).toBe(180);
    expect(chalk.height).toBe(180);
  });

  it("maps basalt to its qemu machine", () => {
    expect(getPlatform("basalt").machine).toBe("pebble-snowy-bb");
  });

  it("returns gabbro as a 260x260 round color touch display", () => {
    const gabbro = getPlatform("gabbro");
    expect(gabbro.round).toBe(true);
    expect(gabbro.color).toBe(true);
    expect(gabbro.touch).toBe(true);
    expect(gabbro.width).toBe(260);
    expect(gabbro.height).toBe(260);
  });

  it("throws on an unknown platform", () => {
    // @ts-expect-error testing runtime guard
    expect(() => getPlatform("nope")).toThrow(/unknown platform/i);
  });
});
