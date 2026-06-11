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

  it("throws on an unknown platform", () => {
    // @ts-expect-error testing runtime guard
    expect(() => getPlatform("nope")).toThrow(/unknown platform/i);
  });
});
