import { describe, it, expect } from "vitest";
import { formatTimeDisplay, parseTimeInput, timePlaceholder } from "../../src/renderer/timeFormat.js";

describe("formatTimeDisplay", () => {
  it("24h mode is zero-padded HH:MM with no AM/PM", () => {
    expect(formatTimeDisplay("09:05", true)).toBe("09:05");
    expect(formatTimeDisplay("21:30", true)).toBe("21:30");
    expect(formatTimeDisplay("00:00", true)).toBe("00:00");
  });
  it("12h mode uses h:mm with AM/PM", () => {
    expect(formatTimeDisplay("09:05", false)).toBe("9:05 AM");
    expect(formatTimeDisplay("21:30", false)).toBe("9:30 PM");
    expect(formatTimeDisplay("00:00", false)).toBe("12:00 AM");
    expect(formatTimeDisplay("12:00", false)).toBe("12:00 PM");
  });
  it("invalid canon yields empty string", () => {
    expect(formatTimeDisplay("", true)).toBe("");
    expect(formatTimeDisplay("99:99", true)).toBe("");
  });
});

describe("parseTimeInput", () => {
  it("parses 24h forms to canonical HH:MM", () => {
    expect(parseTimeInput("9:05")).toBe("09:05");
    expect(parseTimeInput("09:05")).toBe("09:05");
    expect(parseTimeInput("21:5")).toBe("21:05");
    expect(parseTimeInput("00:00")).toBe("00:00");
  });
  it("parses 12h forms (case/spacing-tolerant) to canonical HH:MM", () => {
    expect(parseTimeInput("9:05 pm")).toBe("21:05");
    expect(parseTimeInput("9:05PM")).toBe("21:05");
    expect(parseTimeInput("12:00 am")).toBe("00:00");
    expect(parseTimeInput("12:00 pm")).toBe("12:00");
  });
  it("rejects garbage and out-of-range", () => {
    expect(parseTimeInput("")).toBeNull();
    expect(parseTimeInput("25:00")).toBeNull();
    expect(parseTimeInput("13:00 pm")).toBeNull();
    expect(parseTimeInput("nope")).toBeNull();
  });
  it("round-trips with formatTimeDisplay", () => {
    for (const canon of ["00:00", "09:05", "12:00", "13:30", "23:59"]) {
      expect(parseTimeInput(formatTimeDisplay(canon, false))).toBe(canon);
      expect(parseTimeInput(formatTimeDisplay(canon, true))).toBe(canon);
    }
  });
});

describe("timePlaceholder", () => {
  it("differs by mode", () => {
    expect(timePlaceholder(true)).toContain("HH:MM");
    expect(timePlaceholder(false)).toContain("AM/PM");
  });
});
