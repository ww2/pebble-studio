import { describe, it, expect } from "vitest";
import { createDriver } from "../../src/main/backend/createDriver.js";

describe("createDriver", () => {
  // Linux-dev-machine assertion: createDriver()'s win32 path builds a prod ctx via
  // defaultCtx(), which requires the electron runtime (absent under vitest), so it can
  // only run on the POSIX dev host. The win32 selection logic is covered by
  // winRuntime.test.ts.
  it.skipIf(process.platform === "win32")(
    "returns kind 'native' on this linux dev machine (pebble + sdk qemu present)",
    async () => {
      const { kind } = await createDriver();
      expect(kind).toBe("native");
    },
  );
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
