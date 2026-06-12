import { describe, it, expect } from "vitest";
import { tzOffsetMinutes, computeTargetEpochSec, type TimeState } from "../../src/main/backend/timeController.js";
import { detectHostTimezone, anchorFor, makeTimeController, type TimeConfig } from "../../src/main/backend/timeController.js";

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

describe("detectHostTimezone", () => {
  it("returns the Intl zone, or PST fallback for empty/UTC-only", () => {
    expect(detectHostTimezone(() => "America/New_York")).toBe("America/New_York");
    expect(detectHostTimezone(() => "")).toBe("America/Los_Angeles");
    expect(detectHostTimezone(() => "UTC")).toBe("America/Los_Angeles");
  });
});

describe("anchorFor", () => {
  // Winter instant so the host (LA) offset is a stable −480 (PST, no DST).
  const realMs = new Date("2026-01-15T12:00:00Z").getTime();
  const HOST = "America/Los_Angeles";
  it("System mode (zone === host) nets out to true UTC", () => {
    // The firmware re-applies the host offset, so we send plain UTC and it renders host-local.
    const a = anchorFor({ source: "system", rate: "1x", timezone: HOST, hour24: true, customWallMs: 0 }, realMs, HOST);
    expect(a.anchorUtcSec).toBe(Math.floor(realMs / 1000));
    expect(a.multiplier).toBe(1);
  });
  it("Timezone mode shifts by (zone − host)", () => {
    // host LA (−480), view Tokyo (+540) → net shift +1020 min.
    const a = anchorFor({ source: "system", rate: "1x", timezone: "Asia/Tokyo", hour24: true, customWallMs: 0 }, realMs, HOST);
    expect(a.anchorUtcSec).toBe(Math.floor(realMs / 1000) + (540 - -480) * 60);
  });
  it("custom subtracts the host offset so the entered wall-clock displays", () => {
    const customWallMs = Date.UTC(2026, 5, 1, 14, 30, 0); // user typed 2026-06-01 14:30
    const a = anchorFor({ source: "custom", rate: "frozen", timezone: "UTC", hour24: false, customWallMs }, realMs, HOST);
    // host offset measured at realMs (Jan) → LA −480; subtracting a negative adds 28800s.
    expect(a.anchorUtcSec).toBe(Math.floor(customWallMs / 1000) - -480 * 60);
    expect(a.multiplier).toBe(0);
  });
});

describe("makeTimeController applies on config change", () => {
  it("sends epoch+utc and the 12/24h format", async () => {
    const setTimeCalls: Array<{ v: string; utc: boolean }> = [];
    let fmt: boolean | null = null;
    const driver = {
      setTime: async (v: string, opts?: { utc?: boolean }) => { setTimeCalls.push({ v, utc: !!opts?.utc }); },
      timeFormat: async (h: boolean) => { fmt = h; },
    };
    // host = UTC → zero host offset, so the pushed epoch equals the raw anchor.
    const tc = makeTimeController(() => driver, { now: () => new Date("2026-01-15T12:00:00Z").getTime(), hostTz: () => "UTC" });
    await tc.setConfig({ source: "custom", rate: "frozen", timezone: "UTC", hour24: true, customWallMs: 1000 * 1000 });
    expect(setTimeCalls[0]).toEqual({ v: "1000", utc: true });
    expect(fmt).toBe(true);
    tc.stop();
  });
});
