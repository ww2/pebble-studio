import { describe, it, expect } from "vitest";
import {
  winFakeTimeCtlPath,
  winQemuFakeTimeLogPath,
  writeWinFakeTime,
} from "../../src/main/backend/winTimeShim.js";

describe("winFakeTimeCtlPath", () => {
  it("uses %TEMP%, falling back to %TMP% then a Windows default", () => {
    expect(winFakeTimeCtlPath({ TEMP: "C:\\Temp" })).toBe("C:\\Temp\\pb-faketime.ctl");
    expect(winFakeTimeCtlPath({ TMP: "D:\\t" })).toBe("D:\\t\\pb-faketime.ctl");
    expect(winFakeTimeCtlPath({})).toBe("C:\\Windows\\Temp\\pb-faketime.ctl");
  });
});

describe("winQemuFakeTimeLogPath", () => {
  it("uses %TEMP%, falling back to %TMP% then a Windows default", () => {
    expect(winQemuFakeTimeLogPath({ TEMP: "C:\\Temp" })).toBe("C:\\Temp\\pb-qemu-ft.log");
    expect(winQemuFakeTimeLogPath({ TMP: "D:\\t" })).toBe("D:\\t\\pb-qemu-ft.log");
    expect(winQemuFakeTimeLogPath({})).toBe("C:\\Windows\\Temp\\pb-qemu-ft.log");
  });
});

describe("writeWinFakeTime", () => {
  it("writes '<target> <rate>' for an absolute jump", async () => {
    let written = "";
    await writeWinFakeTime("X", 1577836800, 1, async (_p, d) => { written = d; });
    expect(written).toBe("1577836800 1");
  });
  it("writes '- <rate>' when target is null (rate-only)", async () => {
    let written = "";
    await writeWinFakeTime("X", null, 0, async (_p, d) => { written = d; });
    expect(written).toBe("- 0");
  });
  it("truncates a fractional target to an integer (numeric/quote-free)", async () => {
    let written = "";
    await writeWinFakeTime("X", 1000.9, 10, async (_p, d) => { written = d; });
    expect(written).toBe("1000 10");
  });
  it("writes a fractional rate raw (fs path — no shell-safety constraint)", async () => {
    let written = "";
    await writeWinFakeTime("X", 1577836800, 1e-3, async (_p, d) => { written = d; });
    expect(written).toBe("1577836800 0.001");
  });
  it("passes the control path through to the writer", async () => {
    let path = "";
    await writeWinFakeTime("C:\\Temp\\pb-faketime.ctl", 1, 1, async (p) => { path = p; });
    expect(path).toBe("C:\\Temp\\pb-faketime.ctl");
  });
});
