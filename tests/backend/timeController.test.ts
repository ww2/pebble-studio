import { describe, it, expect, vi, afterEach } from "vitest";
import {
  tzOffsetMinutes, offsetMinutesFor, fakeTargetUnix, detectHostTimezone, makeTimeController,
  OFFSET_MAX_MINUTES, DEFAULT_TIME_CONFIG, isNonSystemTime, QEMU_FROZEN_RATE, type TimeConfig,
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

  it("computes the offset for any IANA zone (used for the host offset)", () => {
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
  it("flags custom source or a non-1× rate; plain host system time is not flagged", () => {
    expect(isNonSystemTime(cfg({ source: "custom" }), HOST)).toBe(true);
    expect(isNonSystemTime(cfg({ source: "system", rate: "10x", timezone: HOST }), HOST)).toBe(true);
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
  const deps = { now: () => t0, hostTz: () => HOST };

  it("applyAll with no driver is a no-op", async () => {
    const tc = makeTimeController(() => null, deps);
    await expect(tc.applyAll()).resolves.toBeUndefined();
    tc.stop();
  });

  it("custom@frozen: setFakeTime(target, 0) + setTzOffset(hostOffset, hostTz)", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    const wall = t0 + 3600_000;
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: wall, hour24: true }));
    expect(d.fmts).toEqual([true]);
    expect(d.tz).toEqual([[-480, HOST]]);
    // Frozen writes the tiny QEMU_FROZEN_RATE (not 0) — see that constant.
    expect(d.fake).toEqual([[fakeTargetUnix(wall, HOST, t0), QEMU_FROZEN_RATE]]);
    expect(d.ensureCalls).toBe(1); // awaited exactly once per apply
    tc.stop();
  });

  it("control-file write is NOT gated behind a hung pypkjs bridge (regression: custom time silently never applied when setTzOffset/timeFormat hung)", async () => {
    const fake: Array<[number | null, number]> = [];
    const neverResolves = (): Promise<void> => new Promise<void>(() => { /* hung bridge */ });
    const hung = {
      setTzOffset: neverResolves, // single-client pypkjs contended/dead → hangs
      timeFormat: neverResolves,
      setFakeTime: async (t: number | null, r: number) => { fake.push([t, r]); },
      ensureTimeShim: async () => true,
    };
    const wall = t0 + 3600_000;
    const tc = makeTimeController(() => hung, deps);
    // setConfig MUST resolve promptly even though both pypkjs calls hang forever;
    // the connection-free control-file write is what custom time actually needs.
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: wall }));
    expect(fake).toEqual([[fakeTargetUnix(wall, HOST, t0), QEMU_FROZEN_RATE]]);
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

  it("system after custom: setFakeTime(<now>, 1) — an ABSOLUTE target returns the fake clock to real time", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: t0 }));
    await tc.setConfig(cfg({ source: "system", timezone: HOST }));
    // A live switch to System writes an ABSOLUTE "<now> 1", NOT a relative "-":
    // "-" means "keep the current fake anchor" (timeshim.c), so after a Custom
    // session it would re-anchor at the CUSTOM time and never return to real time.
    // The f2xx boot-seed is kept correct by a "- 1" reset at BOOT instead (see
    // WindowsNativeDriver.start), not by writing "-" here.
    expect(d.fake[d.fake.length - 1]).toEqual([Math.trunc(t0 / 1000), 1]);
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

  it("getStatus().checked is false until the first real probe (regression: no false 'unavailable' at launch)", async () => {
    const tc = makeTimeController(() => fakeDriver({ shim: false }), deps);
    expect(tc.getStatus()).toEqual({ shim: false, checked: false });
    await tc.applyAll();
    expect(tc.getStatus()).toEqual({ shim: false, checked: true });
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
    // Legacy custom pushes ONLY the virtual-clock offset (no redundant host-offset
    // push — that would clobber it; v0.0.13.1 dropped the old double-push).
    expect(d.tz).toEqual([[60, undefined]]);
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
    expect(d.tz).toEqual([[0, undefined]]); // virtual offset only (no host-offset double-push)

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

describe("custom frozen avoids the qemu rate-0 firmware minute-tick loop", () => {
  // Writing an exactly-0 rate to qemu makes the freeze-fix firmware fire MINUTE
  // ticks in a tight loop (rtc_alarm_get_elapsed_ticks falls back to the commanded
  // duration when the RTC doesn't advance), so animated watchfaces replay their
  // minute-change animation many times/sec. A tiny non-zero rate gives the alarm
  // forward progress while the watch stays visually frozen (minute changes only
  // every several hours of real time). Proven live on basalt (v3.0.3-test9).
  const t0 = WINTER.getTime();
  const deps = { now: () => t0, hostTz: () => HOST };

  it("writes a tiny non-zero rate (QEMU_FROZEN_RATE), never 0, to the control file", async () => {
    const d = fakeDriver();
    const tc = makeTimeController(() => d, deps);
    const wall = t0 + 3600_000;
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: wall }));
    const [tgt, rate] = d.fake[d.fake.length - 1];
    expect(tgt).toBe(fakeTargetUnix(wall, HOST, t0));
    expect(rate).toBe(QEMU_FROZEN_RATE);
    expect(rate).toBeGreaterThan(0);   // 0 is the bug — loops the firmware tick alarm
    expect(rate).toBeLessThan(0.01);   // small enough to stay visually frozen
    tc.stop();
  });

  it("keeps the watch's LOGICAL time frozen despite the tiny qemu rate", async () => {
    let nowMs = t0;
    const d = fakeDriver();
    const tc = makeTimeController(() => d, { now: () => nowMs, hostTz: () => HOST });
    const wall = t0 + 3600_000;
    await tc.setConfig(cfg({ source: "custom", rate: "frozen", customWallMs: wall }));
    const target = fakeTargetUnix(wall, HOST, t0);
    nowMs = t0 + 600_000; // 10 real minutes later
    expect(tc.currentWatchUnix()).toBe(target); // unchanged — frozen for sample-pin timing
    tc.stop();
  });
});

describe("tz-offset push latch always releases (even a hung setTzOffset)", () => {
  const t0 = WINTER.getTime();
  afterEach(() => { vi.useRealTimers(); });

  it("a setTzOffset that hangs forever does not permanently drop later pushes", async () => {
    vi.useFakeTimers();
    let tzCalls = 0;
    const d = {
      // Hangs forever — models a dead/contended pypkjs bridge with no `timeout`
      // bound (the windows-native path). Without the timeout race in
      // pushTzOffsetGuarded this latches tzPushInFlight true for the session.
      setTzOffset: () => { tzCalls++; return new Promise<void>(() => {}); },
      setFakeTime: async () => {},
      timeFormat: async () => {},
      ensureTimeShim: async () => true,
    };
    const tc = makeTimeController(() => d, { now: () => t0, hostTz: () => HOST });

    await tc.setConfig(cfg({ source: "custom", rate: "1x", customWallMs: t0 }));
    expect(tzCalls).toBe(1);            // first push fired, now hung + latched
    await tc.applyAll();
    expect(tzCalls).toBe(1);            // still latched — the in-flight guard holds

    await vi.advanceTimersByTimeAsync(8000); // the timeout race elapses → latch releases
    await tc.applyAll();
    expect(tzCalls).toBe(2);            // a later push goes through again
    tc.stop();
  });
});

describe("currentWatchUnix", () => {
  // A driver whose shim is ready, so apply() takes the shim (primary) path.
  const shimDriver = () => ({
    setTzOffset: async () => {},
    setFakeTime: async () => {},
    ensureTimeShim: async () => true,
    timeFormat: async () => {},
  });
  const HOSTZ = "America/Los_Angeles";
  // Winter instant so the host offset is a stable PST −480 (no DST ambiguity).
  const T0 = new Date("2026-01-15T20:00:00Z").getTime();

  it("system mode tracks real time from the apply instant", async () => {
    let nowMs = T0;
    const c = makeTimeController(shimDriver, { now: () => nowMs, hostTz: () => HOSTZ });
    await c.setConfig({ ...DEFAULT_TIME_CONFIG, source: "system", rate: "1x", timezone: HOSTZ });
    expect(c.currentWatchUnix()).toBe(Math.trunc(T0 / 1000));
    nowMs = T0 + 30_000; // 30s later
    expect(c.currentWatchUnix()).toBe(Math.trunc(T0 / 1000) + 30);
  });

  it("custom frozen holds the entered target", async () => {
    let nowMs = T0;
    const wall = Date.UTC(2020, 0, 1, 9, 0, 0); // entered 2020-01-01 09:00 local
    const c = makeTimeController(shimDriver, { now: () => nowMs, hostTz: () => HOSTZ });
    await c.setConfig({ ...DEFAULT_TIME_CONFIG, source: "custom", rate: "frozen", customWallMs: wall, timezone: HOSTZ });
    const target = fakeTargetUnix(wall, HOSTZ, T0);
    expect(c.currentWatchUnix()).toBe(target);
    nowMs = T0 + 120_000; // 2 min later — frozen → unchanged
    expect(c.currentWatchUnix()).toBe(target);
  });

  it("custom 10x advances at the rate", async () => {
    let nowMs = T0;
    const wall = Date.UTC(2020, 0, 1, 9, 0, 0);
    const c = makeTimeController(shimDriver, { now: () => nowMs, hostTz: () => HOSTZ });
    await c.setConfig({ ...DEFAULT_TIME_CONFIG, source: "custom", rate: "10x", customWallMs: wall, timezone: HOSTZ });
    const target = fakeTargetUnix(wall, HOSTZ, T0);
    nowMs = T0 + 10_000; // 10 real s → 100 watch s at 10x
    expect(c.currentWatchUnix()).toBe(target + 100);
  });
});
