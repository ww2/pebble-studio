import { describe, it, expect } from "vitest";
import { selectDriverKind, type ProbeResult } from "../../src/main/backend/driverFactory.js";

describe("selectDriverKind", () => {
  const base: ProbeResult = { platform: "linux", nativePebbleOnPath: false, nativeQemuOnPath: false, wslAvailable: false };

  it("prefers native when both pebble and qemu are on PATH", () => {
    expect(selectDriverKind({ ...base, nativePebbleOnPath: true, nativeQemuOnPath: true })).toBe("native");
  });

  it("falls back to wsl on win32 when native tools are missing but wsl exists", () => {
    expect(selectDriverKind({ ...base, platform: "win32", wslAvailable: true })).toBe("wsl");
  });

  it("throws when nothing is available", () => {
    expect(() => selectDriverKind(base)).toThrow(/no usable emulator backend/i);
  });

  it("honors an explicit override", () => {
    expect(selectDriverKind({ ...base, override: "wsl", wslAvailable: true })).toBe("wsl");
  });
});
