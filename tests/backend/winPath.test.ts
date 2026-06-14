import { describe, it, expect } from "vitest";
import { winPath } from "../../src/main/backend/winPath.js";

describe("winPath", () => {
  const cases: [string, string][] = [
    // Native Windows absolute path: identity (already usable by pebble.exe).
    ["C:\\Users\\Jane Doe\\My Watch.pbw", "C:\\Users\\Jane Doe\\My Watch.pbw"],
    // Forward slashes are tolerated by Win32; normalize to backslashes.
    ["C:/Users/x/a.pbw", "C:\\Users\\x\\a.pbw"],
    // Mixed slashes normalize.
    ["C:\\Users/x\\sub/a.pbw", "C:\\Users\\x\\sub\\a.pbw"],
    // UNC paths normalize slashes but keep the leading \\.
    ["\\\\server\\share\\a.pbw", "\\\\server\\share\\a.pbw"],
    ["//server/share/a.pbw", "\\\\server\\share\\a.pbw"],
    // Empty string returned unchanged (defensive).
    ["", ""],
  ];
  it.each(cases)("normalizes %j -> %j", (input, expected) => {
    expect(winPath(input)).toBe(expected);
  });
});
