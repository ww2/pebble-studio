import { describe, it, expect } from "vitest";
import { splitLines } from "../../src/main/backend/lineStream.js";

describe("splitLines", () => {
  it("returns complete lines and keeps the trailing partial as rest", () => {
    expect(splitLines("", "a\nb\nc")).toEqual({ lines: ["a", "b"], rest: "c" });
  });
  it("prepends previously-buffered text", () => {
    expect(splitLines("ab", "c\nd\n")).toEqual({ lines: ["abc", "d"], rest: "" });
  });
  it("handles CRLF", () => {
    expect(splitLines("", "a\r\nb\r\n")).toEqual({ lines: ["a", "b"], rest: "" });
  });
});
