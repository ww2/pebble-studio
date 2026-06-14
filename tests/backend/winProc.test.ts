import { describe, it, expect } from "vitest";
import { tasklistArgs, parseTasklistAlive, taskkillByImageArgs, taskkillByPidArgs } from "../../src/main/backend/winProc.js";

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
