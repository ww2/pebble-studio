import { describe, it, expect } from "vitest";
import {
  tzOffsetMinutes, offsetMinutesFor, isVirtualClock, detectHostTimezone, makeTimeController,
  OFFSET_MAX_MINUTES, OFFSET_MIN_MINUTES, DEFAULT_TIME_CONFIG, type TimeConfig,
} from "../../src/main/backend/timeController.js";

// A fixed winter instant (no US DST): 2026-01-15T12:00:00Z
const WINTER = new Date("2026-01-15T12:00:00Z");
/** Build a TimeConfig from partial overrides on the default. */
const cfg = (o: Partial<TimeConfig>): TimeConfig => ({ ...DEFAULT_TIME_CONFIG, ...o });

describe("tzOffsetMinutes", () => {
  it("UTC is 0", () => expect(tzOffsetMinutes("UTC", WINTER)).toBe(0));
  it("Los Angeles is -480 in winter (PST)", () =>
    expect(tzOffsetMinutes("America/Los_Angeles", WINTER)).toBe(-480));
  it("Tokyo is +540", () => expect(tzOffsetMinutes("Asia/Tokyo", WINTER)).toBe(540));
  it("invalid zone falls back to 0", () => expect(tzOffsetMinutes("Not/AZone", WINTER)).toBe(0));
});

describe("detectHostTimezone", () => {
  it("returns the Intl zone, or PST fallback for empty/UTC-only", () => {
    expect(detectHostTimezone(() => "America/New_York")).toBe("America/New_York");
    expect(detectHostTimezone(() => "")).toBe("America/Los_Angeles");
    expect(detectHostTimezone(() => "UTC")).toBe("America/Los_Angeles");
  });
});

describe("offsetMinutesFor", () => {
  const HOST = "America/Los_Angeles";
  const t0 = WINTER.getTime();

  it("System → host offset; Timezone → the chosen zone's offset", () => {
    expect(offsetMinutesFor(cfg({ source: "system", timezone: HOST }), t0, HOST)).toBe(-480);
    expect(offsetMinutesFor(cfg({ source: "system", timezone: "Asia/Tokyo" }), t0, HOST)).toBe(540);
  });

  it("Custom 1× → constant (entered − now); at apply shows entered, then drifts", () => {
    const c = cfg({ source: "custom", rate: "1x", customWallMs: t0 + 30 * 60_000 });
    expect(offsetMinutesFor(c, t0, HOST, t0)).toBe(30);
    // 10 min later the offset is unchanged (display advanced 10 min on its own).
    expect(offsetMinutesFor(c, t0 + 10 * 60_000, HOST, t0)).toBe(30);
  });

  it("Custom Frozen → offset decreases ~1/min so the displayed minute holds", () => {
    const c = cfg({ source: "custom", rate: "frozen", customWallMs: t0 + 3 * 3600_000 });
    expect(offsetMinutesFor(c, t0, HOST, t0)).toBe(180);          // +3h at apply
    expect(offsetMinutesFor(c, t0 + 5 * 60_000, HOST, t0)).toBe(175); // 5 min later → still displays +3h
  });

  it("Custom 10× → offset grows 9/min (fast-forward)", () => {
    const c = cfg({ source: "custom", rate: "10x", customWallMs: t0 });
    expect(offsetMinutesFor(c, t0, HOST, t0)).toBe(0);
    expect(offsetMinutesFor(c, t0 + 60_000, HOST, t0)).toBe(9); // +1 real min → display +10 min
  });

  it("Custom clamps to the Int16 utc_offset range (far dates)", () => {
    expect(offsetMinutesFor(cfg({ source: "custom", rate: "1x", customWallMs: t0 + 1000 * 86_400_000 }), t0, HOST, t0)).toBe(OFFSET_MAX_MINUTES);
    expect(offsetMinutesFor(cfg({ source: "custom", rate: "1x", customWallMs: t0 - 1000 * 86_400_000 }), t0, HOST, t0)).toBe(OFFSET_MIN_MINUTES);
  });
});

describe("isVirtualClock", () => {
  it("true only for Custom with a non-1× rate", () => {
    expect(isVirtualClock(cfg({ source: "custom", rate: "frozen" }))).toBe(true);
    expect(isVirtualClock(cfg({ source: "custom", rate: "10x" }))).toBe(true);
    expect(isVirtualClock(cfg({ source: "custom", rate: "1x" }))).toBe(false);
    expect(isVirtualClock(cfg({ source: "system", rate: "1x" }))).toBe(false);
  });
});

describe("makeTimeController", () => {
  function fakeDriver() {
    const offsets: number[] = [];
    let fmt: boolean | null = null;
    return {
      offsets, get fmt() { return fmt; },
      setTzOffset: async (o: number) => { offsets.push(o); },
      timeFormat: async (h: boolean) => { fmt = h; },
    };
  }

  it("setConfig pushes the computed offset and the 12/24h format", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, { now: () => WINTER.getTime(), hostTz: () => "America/Los_Angeles" });
    await tc.setConfig(cfg({ source: "system", rate: "1x", timezone: "Asia/Tokyo", hour24: true }));
    expect(d.offsets).toEqual([540]);
    expect(d.fmt).toBe(true);
    tc.stop();
  });

  it("reassert force-re-pushes the current offset (heals a clobber)", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, { now: () => WINTER.getTime(), hostTz: () => "America/Los_Angeles" });
    await tc.setConfig(cfg({ source: "system", timezone: "Asia/Tokyo" }));
    await tc.reassert();
    expect(d.offsets).toEqual([540, 540]);
    tc.stop();
  });

  it("a frozen custom config advances its pushed offset as real time passes", async () => {
    const d = fakeDriver();
    let t = WINTER.getTime();
    const tc = makeTimeController(() => d, { now: () => t, hostTz: () => "America/Los_Angeles" });
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: t + 3600_000 })); // +60 min
    expect(d.offsets).toEqual([60]);
    t += 5 * 60_000;          // 5 real minutes pass
    await tc.reassert();      // (the 1 s timer would do this; reassert exercises the recompute)
    expect(d.offsets).toEqual([60, 55]); // offset dropped 5 → displayed minute held
    tc.stop();
  });
});
