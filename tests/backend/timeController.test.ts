import { describe, it, expect } from "vitest";
import { tzOffsetMinutes, computeTargetEpochSec, type TimeState } from "../../src/main/backend/timeController.js";

// A fixed winter instant (no US DST): 2026-01-15T12:00:00Z
const WINTER = new Date("2026-01-15T12:00:00Z");

describe("tzOffsetMinutes", () => {
  it("UTC is 0", () => expect(tzOffsetMinutes("UTC", WINTER)).toBe(0));
  it("Los Angeles is -480 in winter (PST)", () =>
    expect(tzOffsetMinutes("America/Los_Angeles", WINTER)).toBe(-480));
  it("Kolkata is +330", () =>
    expect(tzOffsetMinutes("Asia/Kolkata", WINTER)).toBe(330));
  it("invalid zone falls back to 0", () =>
    expect(tzOffsetMinutes("Not/AZone", WINTER)).toBe(0));
});

describe("computeTargetEpochSec", () => {
  const realMs = WINTER.getTime();
  const realSec = Math.floor(realMs / 1000);

  it("system + 1x shows zone wall-clock as a UTC epoch", () => {
    const st: TimeState = { source: "system", multiplier: 1, timezone: "America/Los_Angeles", anchorUtcSec: realSec - 480 * 60, anchorRealMs: realMs };
    expect(computeTargetEpochSec(st, realMs)).toBe(realSec - 480 * 60);
  });

  it("frozen holds the anchor regardless of elapsed real time", () => {
    const st: TimeState = { source: "custom", multiplier: 0, timezone: "UTC", anchorUtcSec: 1000, anchorRealMs: realMs };
    expect(computeTargetEpochSec(st, realMs + 60_000)).toBe(1000);
  });

  it("4x advances 4 virtual seconds per real second", () => {
    const st: TimeState = { source: "custom", multiplier: 4, timezone: "UTC", anchorUtcSec: 1000, anchorRealMs: realMs };
    expect(computeTargetEpochSec(st, realMs + 10_000)).toBe(1000 + 40);
  });

  it("1x advances one-for-one", () => {
    const st: TimeState = { source: "system", multiplier: 1, timezone: "UTC", anchorUtcSec: 1000, anchorRealMs: realMs };
    expect(computeTargetEpochSec(st, realMs + 5_000)).toBe(1005);
  });
});
