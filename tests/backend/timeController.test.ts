import { describe, it, expect, vi, afterEach } from "vitest";
import {
  tzOffsetMinutes, offsetMinutesFor, fakeTargetUnix, detectHostTimezone, makeTimeController,
  OFFSET_MAX_MINUTES, DEFAULT_TIME_CONFIG, isNonSystemTime, type TimeConfig,
} from "../../src/main/backend/timeController.js";

// A fixed winter instant (no US DST): 2026-01-15T12:00:00Z — LA is PST (−480).
const WINTER = new Date("2026-01-15T12:00:00Z");
const HOST = "America/Los_Angeles";
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

describe("offsetMinutesFor (constant per config)", () => {
  const t0 = WINTER.getTime();

  it("System → host offset; Timezone → the chosen zone's offset", () => {
    expect(offsetMinutesFor(cfg({ source: "system", timezone: HOST }), t0, HOST)).toBe(-480);
    expect(offsetMinutesFor(cfg({ source: "system", timezone: "Asia/Tokyo" }), t0, HOST)).toBe(540);
  });

  it("Custom → the HOST zone's offset (clobber-immune: post_connect re-push is a no-op)", () => {
    const c = cfg({ source: "custom", rate: "frozen", customWallMs: t0 + 1000 * 86_400_000 });
    expect(offsetMinutesFor(c, t0, HOST)).toBe(-480); // independent of customWallMs/rate
  });
});

describe("fakeTargetUnix", () => {
  const t0 = WINTER.getTime();

  it("subtracts the host offset at the CURRENT instant (January → PST −480)", () => {
    const wall = Date.UTC(2026, 0, 15, 9, 30, 0); // entered 09:30 local, UTC-naive
    expect(fakeTargetUnix(wall, HOST, t0)).toBe(Math.trunc(wall / 1000) + 480 * 60);
  });

  it("an entered SUMMER date still uses the current (January) offset, not PDT", () => {
    const wall = Date.UTC(2026, 6, 4, 12, 0, 0); // July 4 — PDT would be −420
    expect(fakeTargetUnix(wall, HOST, t0)).toBe(Math.trunc(wall / 1000) + 480 * 60);
  });
});

describe("DEFAULT_TIME_CONFIG", () => {
  it("defaults to a 12-hour clock", () => expect(DEFAULT_TIME_CONFIG.hour24).toBe(false));
});

describe("isNonSystemTime", () => {
  it("flags custom source, non-1× rate, or a non-host zone", () => {
    expect(isNonSystemTime(cfg({ source: "custom" }), HOST)).toBe(true);
    expect(isNonSystemTime(cfg({ source: "system", rate: "10x", timezone: HOST }), HOST)).toBe(true);
    expect(isNonSystemTime(cfg({ source: "system", timezone: "Asia/Tokyo" }), HOST)).toBe(true);
    expect(isNonSystemTime(cfg({ source: "system", rate: "1x", timezone: HOST }), HOST)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

function fakeDriver(opts: { shim?: boolean } = {}) {
  const shim = opts.shim ?? true;
  const tz: Array<[number, string | undefined]> = [];
  const fake: Array<[number | null, number]> = [];
  const fmts: boolean[] = [];
  let ensureCalls = 0;
  return {
    tz, fake, fmts,
    get ensureCalls() { return ensureCalls; },
    setTzOffset: async (o: number, name?: string) => { tz.push([o, name]); },
    setFakeTime: async (t: number | null, r: number) => { fake.push([t, r]); },
    timeFormat: async (h: boolean) => { fmts.push(h); },
    ensureTimeShim: async () => { ensureCalls++; return shim; },
  };
}

describe("makeTimeController — shim-backed (primary path)", () => {
  const t0 = WINTER.getTime();
  const t0Sec = Math.trunc(t0 / 1000);
  const deps = { now: () => t0, hostTz: () => HOST };

  it("custom@frozen: setFakeTime(target, 0) + setTzOffset(hostOffset, hostTz)", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    const wall = t0 + 3600_000;
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: wall, hour24: true }));
    expect(d.fmts).toEqual([true]);
    expect(d.tz).toEqual([[-480, HOST]]);
    expect(d.fake).toEqual([[fakeTargetUnix(wall, HOST, t0), 0]]);
    expect(d.ensureCalls).toBe(1); // awaited exactly once per apply
    tc.stop();
  });

  it("custom@10x → rate 10; custom@1x → rate 1", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    await tc.setConfig(cfg({ source: "custom", rate: "10x", customWallMs: t0 }));
    await tc.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 }));
    expect(d.fake).toEqual([
      [fakeTargetUnix(t0, HOST, t0), 10],
      [fakeTargetUnix(t0, HOST, t0), 1],
    ]);
    tc.stop();
  });

  it("system after custom: setFakeTime(nowSec, 1) returns the fake clock to real time", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: t0 }));
    await tc.setConfig(cfg({ source: "system", timezone: HOST }));
    expect(d.fake[d.fake.length - 1]).toEqual([t0Sec, 1]);
    tc.stop();
  });

  it("timezone mode: setTzOffset(540, Asia/Tokyo) + setFakeTime(now,1); reassert re-pushes 540", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    await tc.setConfig(cfg({ source: "system", timezone: "Asia/Tokyo" }));
    expect(d.tz).toEqual([[540, "Asia/Tokyo"]]);
    expect(d.fake).toEqual([[t0Sec, 1]]);
    await tc.reassert();
    expect(d.tz).toEqual([[540, "Asia/Tokyo"], [540, "Asia/Tokyo"]]);
    tc.stop();
  });

  it("reassert in shim-backed custom mode is a NO-OP (offset already = host offset)", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: t0 }));
    const tzBefore = d.tz.length, fakeBefore = d.fake.length;
    await tc.reassert();
    expect(d.tz.length).toBe(tzBefore);
    expect(d.fake.length).toBe(fakeBefore);
    tc.stop();
  });

  it("reassert in plain system mode (host zone) pushes nothing", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    await tc.setConfig(cfg({ source: "system", timezone: HOST }));
    const tzBefore = d.tz.length;
    await tc.reassert();
    expect(d.tz.length).toBe(tzBefore);
    tc.stop();
  });

  it("getStatus().shim reflects the last ensureTimeShim result", async () => {
    const ok = fakeDriver({ shim: true });
    const tc1 = makeTimeController(() => ok, deps);
    expect(tc1.getStatus().shim).toBe(false); // default before any apply
    await tc1.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 }));
    expect(tc1.getStatus().shim).toBe(true);
    tc1.stop();

    const bad = fakeDriver({ shim: false });
    const tc2 = makeTimeController(() => bad, deps);
    await tc2.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 }));
    expect(tc2.getStatus().shim).toBe(false);
    tc2.stop();
  });
});

describe("makeTimeController — legacy fallback (shim unavailable)", () => {
  const t0 = WINTER.getTime();

  afterEach(() => { vi.useRealTimers(); });

  it("custom@frozen: virtual-clock offset pushed; timer decrements it over minutes", async () => {
    vi.useFakeTimers();
    const d = fakeDriver({ shim: false });
    let t = t0;
    const tc = makeTimeController(() => d, { now: () => t, hostTz: () => HOST });
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: t0 + 3600_000 })); // +60 min
    // Constant host-offset push first (clobber baseline), then the legacy virtual offset.
    expect(d.tz).toEqual([[-480, HOST], [60, undefined]]);
    expect(d.fake).toEqual([]); // never touches the control file without the shim

    t += 5 * 60_000; // 5 real minutes pass
    await vi.advanceTimersByTimeAsync(1000); // one 1 s tick
    expect(d.tz[d.tz.length - 1]).toEqual([55, undefined]); // offset dropped 5 → minute held
    tc.stop();
  });

  it("custom@10x: offset grows 9/min (fast-forward)", async () => {
    vi.useFakeTimers();
    const d = fakeDriver({ shim: false });
    let t = t0;
    const tc = makeTimeController(() => d, { now: () => t, hostTz: () => HOST });
    await tc.setConfig(cfg({ source: "custom", rate: "10x", customWallMs: t0 }));
    expect(d.tz).toEqual([[-480, HOST], [0, undefined]]);

    t += 60_000; // +1 real min → display +10 min → offset +9
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.tz[d.tz.length - 1]).toEqual([9, undefined]);
    tc.stop();
  });

  it("legacy custom clamps to the Int16 utc_offset range (far dates)", async () => {
    vi.useFakeTimers();
    const d = fakeDriver({ shim: false });
    const tc = makeTimeController(() => d, { now: () => t0, hostTz: () => HOST });
    await tc.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 + 1000 * 86_400_000 }));
    expect(d.tz[d.tz.length - 1]).toEqual([OFFSET_MAX_MINUTES, undefined]);
    tc.stop();
  });

  it("reassert in legacy custom mode force-re-pushes the virtual offset (heals a clobber)", async () => {
    const d = fakeDriver({ shim: false });
    let t = t0;
    const tc = makeTimeController(() => d, { now: () => t, hostTz: () => HOST });
    await tc.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 + 30 * 60_000 }));
    expect(d.tz[d.tz.length - 1]).toEqual([30, undefined]);
    t += 10 * 60_000;
    await tc.reassert(); // 1× → constant offset; force re-push after a clobber
    expect(d.tz[d.tz.length - 1]).toEqual([30, undefined]);
    tc.stop();
  });

  it("switching legacy custom → system stops the timer and pushes nothing further", async () => {
    vi.useFakeTimers();
    const d = fakeDriver({ shim: false });
    let t = t0;
    const tc = makeTimeController(() => d, { now: () => t, hostTz: () => HOST });
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: t0 + 3600_000 }));
    await tc.setConfig(cfg({ source: "system", timezone: HOST }));
    const tzAfterSwitch = d.tz.length;
    expect(d.fake).toEqual([]); // shim unavailable → no fake-clock reset attempted

    t += 10 * 60_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.tz.length).toBe(tzAfterSwitch); // timer is gone
    tc.stop();
  });

  it("no timer runs for legacy custom@1x (constant offset)", async () => {
    vi.useFakeTimers();
    const d = fakeDriver({ shim: false });
    let t = t0;
    const tc = makeTimeController(() => d, { now: () => t, hostTz: () => HOST });
    await tc.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 + 30 * 60_000 }));
    const count = d.tz.length;
    t += 10 * 60_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.tz.length).toBe(count);
    tc.stop();
  });
});
