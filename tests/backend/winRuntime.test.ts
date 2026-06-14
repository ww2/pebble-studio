import { describe, it, expect } from "vitest";
import {
  qemuExe,
  pebblePyExe,
  sdkBundleRoot,
  pebbleDataDir,
  pebbleCmd,
  bundledToolsPresent,
  type WinRuntimeCtx,
} from "../../src/main/backend/winRuntime.js";

/** A packaged context: bundles live under process.resourcesPath. */
const packaged: WinRuntimeCtx = {
  packaged: true,
  resourcesPath: "C:\\Program Files\\Pebble Studio\\resources",
  repoRoot: "C:\\repo",
  userDataDir: "C:\\Users\\Jason Lin\\AppData\\Roaming\\Pebble Studio",
  exists: () => true,
};

/** A dev context where the vendor bundles ARE staged in the repo. */
const devStaged: WinRuntimeCtx = {
  packaged: false,
  resourcesPath: "C:\\ignored",
  repoRoot: "C:\\repo",
  userDataDir: "C:\\data",
  exists: () => true,
};

/** A dev context where vendor bundles are NOT yet staged (use C:\tmp fallbacks). */
const devUnstaged: WinRuntimeCtx = {
  packaged: false,
  resourcesPath: "C:\\ignored",
  repoRoot: "C:\\repo",
  userDataDir: "C:\\data",
  exists: () => false,
};

describe("winRuntime path resolution", () => {
  it("resolves the bundled qemu exe under resourcesPath when packaged", () => {
    expect(qemuExe(packaged)).toBe(
      "C:\\Program Files\\Pebble Studio\\resources\\qemu-pebble-win\\qemu-pebble.exe",
    );
  });

  it("resolves the bundled python exe under resourcesPath when packaged", () => {
    expect(pebblePyExe(packaged)).toBe(
      "C:\\Program Files\\Pebble Studio\\resources\\pebble-py\\python.exe",
    );
  });

  it("resolves the sdk bundle root under resourcesPath when packaged", () => {
    expect(sdkBundleRoot(packaged)).toBe(
      "C:\\Program Files\\Pebble Studio\\resources\\pebble-sdk",
    );
  });

  it("resolves bundles under repo vendor/ in dev when they are staged", () => {
    expect(qemuExe(devStaged)).toBe("C:\\repo\\vendor\\qemu-pebble-win\\qemu-pebble.exe");
    expect(pebblePyExe(devStaged)).toBe("C:\\repo\\vendor\\pebble-py\\python.exe");
    expect(sdkBundleRoot(devStaged)).toBe("C:\\repo\\vendor\\pebble-sdk");
  });

  it("falls back to the C:\\tmp build location for the python bundle in dev when unstaged", () => {
    expect(pebblePyExe(devUnstaged)).toBe("C:\\tmp\\pebble-py-build\\python\\python.exe");
  });

  it("pebbleDataDir is the writable app-data persist root under userData", () => {
    expect(pebbleDataDir(packaged)).toBe(
      "C:\\Users\\Jason Lin\\AppData\\Roaming\\Pebble Studio\\pebble-data",
    );
  });
});

describe("winRuntime bundledToolsPresent", () => {
  it("is true when both the bundled qemu exe and bundled python exe exist", () => {
    expect(bundledToolsPresent({ ...packaged, exists: () => true })).toBe(true);
  });

  it("is false when the bundles are absent", () => {
    expect(bundledToolsPresent({ ...packaged, exists: () => false })).toBe(false);
  });

  it("is false when only one of qemu/python is present", () => {
    const onlyQemu = (p: string) => p.endsWith("qemu-pebble.exe");
    expect(bundledToolsPresent({ ...packaged, exists: onlyQemu })).toBe(false);
  });
});

describe("winRuntime pebbleCmd invocation contract", () => {
  it("invokes the bundled python path-independently via run_tool() and passes pebble args", () => {
    const c = pebbleCmd(["emu-control", "--emulator", "emery", "--vnc"], packaged);
    expect(c.cmd).toBe("C:\\Program Files\\Pebble Studio\\resources\\pebble-py\\python.exe");
    expect(c.args).toEqual([
      "-c",
      "from pebble_tool import run_tool; run_tool()",
      "emu-control",
      "--emulator",
      "emery",
      "--vnc",
    ]);
  });

  it("sets PEBBLE_QEMU_PATH to the bundled qemu and XDG_DATA_HOME to the writable data dir", () => {
    const c = pebbleCmd(["wipe"], packaged);
    expect(c.env?.PEBBLE_QEMU_PATH).toBe(
      "C:\\Program Files\\Pebble Studio\\resources\\qemu-pebble-win\\qemu-pebble.exe",
    );
    expect(c.env?.XDG_DATA_HOME).toBe(
      "C:\\Users\\Jason Lin\\AppData\\Roaming\\Pebble Studio\\pebble-data",
    );
  });
});
