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

  it("prefers windows-native on win32 when pebble.exe AND qemu(.exe)/PEBBLE_QEMU_PATH resolve", () => {
    expect(
      selectDriverKind({ ...base, platform: "win32", nativePebbleOnPath: true, nativeQemuOnPath: true }),
    ).toBe("windows-native");
  });

  it("on win32 falls back to wsl when native qemu is absent but wsl exists", () => {
    expect(
      selectDriverKind({ ...base, platform: "win32", nativePebbleOnPath: true, nativeQemuOnPath: false, wslAvailable: true }),
    ).toBe("wsl");
  });

  it("honors an explicit windows-native override when win tools are present", () => {
    expect(
      selectDriverKind({ ...base, platform: "win32", override: "windows-native", nativePebbleOnPath: true, nativeQemuOnPath: true }),
    ).toBe("windows-native");
  });

  it("throws if windows-native is overridden but win tools are missing", () => {
    expect(() =>
      selectDriverKind({ ...base, platform: "win32", override: "windows-native", nativePebbleOnPath: false, nativeQemuOnPath: false }),
    ).toThrow(/windows-native.*not found/i);
  });

  it("keeps native (Linux) selection unchanged", () => {
    expect(selectDriverKind({ ...base, nativePebbleOnPath: true, nativeQemuOnPath: true })).toBe("native");
  });
});
