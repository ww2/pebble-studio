import { describe, it, expect } from "vitest";
import { tasklistArgs, parseTasklistAlive, taskkillByImageArgs, taskkillByPidArgs, parseStatePids } from "../../src/main/backend/winProc.js";

const TASKLIST_CSV_ALIVE =
  `"Image Name","PID","Session Name","Session#","Mem Usage"\r\n` +
  `"qemu-pebble.exe","12345","Console","1","250,000 K"\r\n`;
const TASKLIST_CSV_NONE = `INFO: No tasks are running which match the specified criteria.\r\n`;

describe("winProc", () => {
  it("tasklistArgs filters by image name in CSV mode", () => {
    expect(tasklistArgs("qemu-pebble.exe")).toEqual(["/FI", "IMAGENAME eq qemu-pebble.exe", "/FO", "CSV", "/NH"]);
  });

  it("parseTasklistAlive is true when a matching row is present", () => {
    expect(parseTasklistAlive(TASKLIST_CSV_ALIVE)).toBe(true);
  });

  it("parseTasklistAlive is false for the 'No tasks' banner", () => {
    expect(parseTasklistAlive(TASKLIST_CSV_NONE)).toBe(false);
  });

  it("parseTasklistAlive is false for empty output", () => {
    expect(parseTasklistAlive("")).toBe(false);
  });

  it("taskkillByImageArgs force-kills the whole tree by image", () => {
    expect(taskkillByImageArgs("qemu-pebble.exe")).toEqual(["/IM", "qemu-pebble.exe", "/T", "/F"]);
  });

  it("taskkillByPidArgs force-kills the whole tree by pid", () => {
    expect(taskkillByPidArgs(12345)).toEqual(["/PID", "12345", "/T", "/F"]);
  });
});

describe("parseStatePids", () => {
  const full = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 1001, port: 63000, monitor: 63002, vnc: true },
        pypkjs: { pid: 1002, port: 63001 },
        websockify: { pid: 1003 },
      },
    },
  });

  it("returns qemu + pypkjs + websockify pids", () => {
    expect(parseStatePids(full).sort()).toEqual([1001, 1002, 1003]);
  });

  it("collects pids across multiple platforms/versions and dedupes", () => {
    const multi = JSON.stringify({
      emery: { "4.9.169": { qemu: { pid: 1 }, pypkjs: { pid: 2 } } },
      basalt: { "4.9.169": { qemu: { pid: 1 }, websockify: { pid: 3 } } },
    });
    expect(parseStatePids(multi).sort()).toEqual([1, 2, 3]);
  });

  it("ignores non-numeric / non-positive pids", () => {
    const bad = JSON.stringify({ emery: { "4.9": { qemu: { pid: "x" }, pypkjs: { pid: 0 }, websockify: { pid: -5 } } } });
    expect(parseStatePids(bad)).toEqual([]);
  });

  it("returns [] for empty / malformed / non-object json", () => {
    expect(parseStatePids("")).toEqual([]);
    expect(parseStatePids("{ not json")).toEqual([]);
    expect(parseStatePids("null")).toEqual([]);
    expect(parseStatePids("42")).toEqual([]);
  });
});
