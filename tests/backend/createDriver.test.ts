import { describe, it, expect } from "vitest";
import { createDriver } from "../../src/main/backend/createDriver.js";

describe("createDriver", () => {
  it("returns kind 'native' on this linux dev machine (pebble + sdk qemu present)", async () => {
    const { kind } = await createDriver();
    expect(kind).toBe("native");
  });
});

describe("createDriver windows-native construction", () => {
  it("maps the windows-native kind to the WindowsNativeDriver class", async () => {
    const { driverClassForKind } = await import("../../src/main/backend/createDriver.js");
    const { WindowsNativeDriver } = await import("../../src/main/backend/WindowsNativeDriver.js");
    expect(driverClassForKind("windows-native")).toBe(WindowsNativeDriver);
  });

  it("maps native and wsl kinds to their classes", async () => {
    const { driverClassForKind } = await import("../../src/main/backend/createDriver.js");
    const { NativeDriver } = await import("../../src/main/backend/NativeDriver.js");
    const { WslDriver } = await import("../../src/main/backend/WslDriver.js");
    expect(driverClassForKind("native")).toBe(NativeDriver);
    expect(driverClassForKind("wsl")).toBe(WslDriver);
  });
});
