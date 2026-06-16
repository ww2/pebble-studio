import { describe, it, expect } from "vitest";
import { formatTimeDisplay, parseTimeInput, to12h, from12h } from "../../src/renderer/timeFormat.js";

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

describe("to12h", () => {
  it("maps the midnight/noon edges correctly", () => {
    expect(to12h("00:00")).toEqual({ hour: 12, minute: 0, ampm: "AM" });
    expect(to12h("12:00")).toEqual({ hour: 12, minute: 0, ampm: "PM" });
  });
  it("maps AM and PM hours", () => {
    expect(to12h("09:05")).toEqual({ hour: 9, minute: 5, ampm: "AM" });
    expect(to12h("13:30")).toEqual({ hour: 1, minute: 30, ampm: "PM" });
    expect(to12h("23:59")).toEqual({ hour: 11, minute: 59, ampm: "PM" });
  });
  it("falls back to 12:00 AM on invalid input", () => {
    expect(to12h("")).toEqual({ hour: 12, minute: 0, ampm: "AM" });
    expect(to12h("99:99")).toEqual({ hour: 12, minute: 0, ampm: "AM" });
  });
});

describe("from12h", () => {
  it("folds 12h + AM/PM back to canonical 24h HH:MM", () => {
    expect(from12h(12, 0, "AM")).toBe("00:00");
    expect(from12h(12, 0, "PM")).toBe("12:00");
    expect(from12h(9, 5, "AM")).toBe("09:05");
    expect(from12h(1, 30, "PM")).toBe("13:30");
    expect(from12h(11, 59, "PM")).toBe("23:59");
  });
  it("round-trips with to12h across all 1440 minutes", () => {
    const pad = (n: number): string => String(n).padStart(2, "0");
    for (let h = 0; h < 24; h++) {
      for (let mi = 0; mi < 60; mi++) {
        const canon = `${pad(h)}:${pad(mi)}`;
        const { hour, minute, ampm } = to12h(canon);
        expect(from12h(hour, minute, ampm)).toBe(canon);
      }
    }
  });
});
