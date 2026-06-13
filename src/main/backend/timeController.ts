export type TimeSource = "system" | "custom";
export type Rate = "frozen" | "1x" | "2x" | "4x" | "10x";

/** Fake-clock multiplier per rate. 0 = frozen, 1 = real-time, N = N× faster. */
export const RATE_MULT: Record<Rate, number> = { frozen: 0, "1x": 1, "2x": 2, "4x": 4, "10x": 10 };

/**
 * EMULATOR TIME CONTRACT — v0.0.13 control-file model (spec:
 * docs/superpowers/specs/2026-06-12-pebble-studio-v0.0.13-time-clay-port-design.md §A2;
 * background: memory `pebble-emu-time-mechanism`):
 *
 *   - The qemu firmware clock is continuously re-jammed from the qemu PROCESS's
 *     CLOCK_REALTIME. An LD_PRELOAD shim (timeShim.ts) fakes that clock, driven
 *     by a control file `<target_unix|-> <rate>` re-read on mtime change. This
 *     is the PRIMARY lever: true absolute date, real frozen seconds, exact rates,
 *     via driver.setFakeTime(targetUnix|null, rate).
 *   - `utc_offset` (Int16 minutes, raw SetUTC via driver.setTzOffset) remains
 *     only for TIMEZONE DISPLAY: displayed local = fake_UTC + utc_offset. Every
 *     `pebble` command's connect re-pushes the HOST's current offset
 *     (post_connect clobber), so:
 *       · System   → host offset; control file `- 1` (shim is a no-op).
 *       · Timezone → chosen zone's offset; clobbers healed by reassert().
 *       · Custom   → we keep utc_offset AT THE HOST OFFSET and bake the entered
 *         wall-clock into the control-file target instead — the clobber's
 *         host-offset re-push is then a no-op (immune by construction); no
 *         reassert, no pusher timer.
 *   - LEGACY FALLBACK (shim failed to deploy/self-test): the pre-v0.0.13
 *     virtual-clock path — a 1 s timer pushing time-varying utc_offset values.
 *     Minute granularity (seconds can't freeze), |offset| ≤ 32767 min caps the
 *     displacement at ~±22.7 days, and resets on reboot.
 */
export interface TimeConfig {
  source: TimeSource;
  rate: Rate;
  timezone: string;     // IANA name — always the host zone now (the user-facing timezone picker was removed); used by offsetMinutesFor for the host offset.
  hour24: boolean;
  customWallMs: number; // custom mode: the entered wall-clock as a UTC-naive epoch ms (Date.UTC).
}

/** SetUTC.utc_offset is an Int16 (minutes) → ~±22.7 days of shift. */
export const OFFSET_MIN_MINUTES = -32767;
export const OFFSET_MAX_MINUTES = 32767;

export const DEFAULT_TIME_CONFIG: TimeConfig = {
  source: "system", rate: "1x", timezone: "UTC", hour24: false, customWallMs: 0,
};

/** Minutes east of UTC for `tz` at instant `at`. Invalid zones → 0. (Pure; uses Intl.) */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? "0" : p.hour), +p.minute, +p.second);
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Pick the host IANA zone; fall back to PST when empty or a bare "UTC". */
export function detectHostTimezone(get: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const tz = (get() || "").trim();
  if (!tz || tz === "UTC") return "America/Los_Angeles";
  return tz;
}

function clampOffset(min: number): number {
  return Math.max(OFFSET_MIN_MINUTES, Math.min(OFFSET_MAX_MINUTES, Math.round(min)));
}

/**
 * The CONSTANT `utc_offset` (minutes) for a config. System/Timezone: the
 * configured zone's offset. Custom: the HOST zone's offset — the entered time
 * lives in the control-file target instead, so post_connect's host-offset
 * re-push is a no-op (clobber-immune by construction).
 */
export function offsetMinutesFor(
  cfg: TimeConfig,
  nowMs: number,
  hostTz: string = detectHostTimezone(),
): number {
  return clampOffset(tzOffsetMinutes(cfg.source === "custom" ? hostTz : cfg.timezone, new Date(nowMs)));
}

/** Control-file target for the entered wall-clock: interpret the UTC-naive
 * customWallMs in the host zone AT THE CURRENT INSTANT (not the entered date's
 * DST regime) so displayed = entered even across DST boundaries. */
export function fakeTargetUnix(customWallMs: number, hostTz: string, nowMs: number): number {
  return Math.trunc(customWallMs / 1000) - tzOffsetMinutes(hostTz, new Date(nowMs)) * 60;
}

/** Watch time differs from plain host system time? (drives the renderer badge.)
 * The `hostTz` param is retained for signature compatibility with callers but is
 * no longer consulted — the user-facing Timezone mode was removed, so the only
 * non-system states are a custom anchor or a non-1× rate. */
export function isNonSystemTime(cfg: TimeConfig, _hostTz: string): boolean {
  void _hostTz;
  return cfg.source === "custom" || cfg.rate !== "1x";
}

interface TimeDriver {
  /** Push a UTC offset (minutes) via a short-lived raw SetUTC. `tzName` (IANA
   * zone) becomes the SetUTC tz_name; omitted/absent for custom-anchor mode. */
  setTzOffset(offsetMin: number, tzName?: string): Promise<void>;
  /** Write the time-shim control file: `<targetUnix|-> <rate>`. */
  setFakeTime(targetUnix: number | null, rate: number): Promise<void>;
  /** Deploy + self-test the LD_PRELOAD time shim (cached after first success). */
  ensureTimeShim(): Promise<boolean>;
  timeFormat(hour24: boolean): Promise<void>;
}

export interface TimeController {
  setConfig(cfg: TimeConfig): Promise<void>;
  getConfig(): TimeConfig;
  /** Re-assert current config on the (re)booted emulator. */
  applyAll(): Promise<void>;
  /** Force-push the current offset after a command that may have reset it (every
   * pebble command re-syncs the HOST offset on connect). Only matters for
   * Timezone mode and the legacy custom fallback — shim-backed custom keeps the
   * offset at the host offset, so the clobber is already a no-op. */
  reassert(): Promise<void>;
  /** Time-shim readiness as last reported by ensureTimeShim(). `checked` is
   * false until the first real probe (at boot/apply) — the renderer must not
   * show "shim unavailable" off the unchecked default. */
  getStatus(): { shim: boolean; checked: boolean };
  stop(): void;
}

/** How often the legacy virtual-clock pusher recomputes (it only sends on minute change). */
const VCLOCK_TICK_MS = 1000;

export function makeTimeController(
  getDriver: () => TimeDriver | null,
  deps: { now?: () => number; hostTz?: () => string } = {},
): TimeController {
  const now = deps.now ?? (() => Date.now());
  const hostTz = deps.hostTz ?? (() => detectHostTimezone());
  let cfg: TimeConfig = { ...DEFAULT_TIME_CONFIG };
  let shimReady = false;     // last ensureTimeShim() result (false until first check)
  let shimChecked = false;   // has ensureTimeShim() ever actually been probed?
  let legacyActive = false;  // custom mode is running on the legacy fallback

  // -------------------------------------------------------------------------
  // LEGACY FALLBACK — pre-v0.0.13 virtual-clock machinery, kept VERBATIM for
  // systems where the shim can't deploy (glibc mismatch, no compiler, …).
  // Models V(t) = entered + rate·(t − anchor) and pushes utc_offset =
  // round((V − now)/60) on a 1 s timer whenever the minute value changes.
  // Limits: minute granularity (seconds always tick from the host), ±22.7 days.
  // -------------------------------------------------------------------------
  let anchorMs = now();                  // real time the current cfg was applied
  let lastPushed: number | null = null;  // last offset minutes actually sent
  let timer: ReturnType<typeof setInterval> | null = null;
  let pushing = false;

  /** Legacy custom: time-varying offset so the display tracks the virtual clock. */
  function legacyOffsetMinutesFor(c: TimeConfig, nowMs: number, anchor: number): number {
    const mult = RATE_MULT[c.rate];
    const virtualMs = c.customWallMs + mult * (nowMs - anchor);
    return clampOffset((virtualMs - nowMs) / 60000);
  }

  /** Legacy custom: send the current virtual-clock offset if its minute changed. */
  async function legacyPush(force: boolean): Promise<void> {
    if (pushing) return;
    pushing = true;
    try {
      const d = getDriver();
      if (!d) return;
      const off = legacyOffsetMinutesFor(cfg, now(), anchorMs);
      if (!force && off === lastPushed) return; // no minute change → leave bridge free
      // Custom is a bare offset anchor (no real zone) → no tz_name; the raw
      // SetUTC helper synthesizes "UTC±h".
      await d.setTzOffset(off);
      lastPushed = off;
    } catch { /* tool/emulator may be absent; degrade silently */ }
    finally { pushing = false; }
  }

  function clearTimer(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** The 1 s pusher runs ONLY in legacy custom mode with a non-1× rate
   * (1× is a constant offset; shim-backed modes never need a timer). */
  function syncLegacyTimer(): void {
    clearTimer();
    if (legacyActive && RATE_MULT[cfg.rate] !== 1) {
      timer = setInterval(() => void legacyPush(false), VCLOCK_TICK_MS);
    }
  }
  // ----------------------------- end legacy ---------------------------------

  /**
   * Apply the current cfg. ORDER IS LOAD-BEARING (v0.0.13.1 fix):
   *
   * The shim control-file write (setFakeTime) is CONNECTION-FREE and is the
   * ENTIRE custom/freeze/rate mechanism, so it runs FIRST and is the only awaited
   * emulator call. The 12/24h format and the utc_offset push connect to the
   * SINGLE-CLIENT pypkjs bridge, which hangs for tens of seconds — or FOREVER if
   * the bridge has died (a real failure mode: pypkjs crashes, leaving qemu up) —
   * under contention. They are therefore best-effort FIRE-AND-FORGET and can
   * never starve the control-file write or block the renderer.
   *
   * (Pre-fix bug: setFakeTime sat AFTER an awaited setTzOffset. When pypkjs was
   * contended/dead, setTzOffset hung and setFakeTime never ran, so custom time
   * silently never reached the watch — it kept showing whatever the control file
   * last held. Confirmed live: setTzOffset hung 25 s+, setFakeTime wrote in 129 ms.)
   *
   * Custom keeps the HOST offset (which post_connect already supplies, so a missed
   * push is harmless); Timezone's offset is also healed by reassert() after each
   * command. Only the LEGACY fallback (no shim) must await its offset push, since
   * there the utc_offset IS the only lever.
   */
  async function apply(): Promise<void> {
    clearTimer();
    legacyActive = false;
    const d = getDriver();
    if (!d) return;

    // Shim readiness — connection-free (cached after the first deploy).
    try { shimReady = await d.ensureTimeShim(); } catch { shimReady = false; }
    shimChecked = true;

    if (cfg.source === "custom" && !shimReady) {
      // Legacy fallback (no shim): the utc_offset virtual clock IS the mechanism,
      // so its push must be awaited. Only reached when the shim can't deploy.
      legacyActive = true;
      anchorMs = now();
      lastPushed = null;
      await legacyPush(true);
      syncLegacyTimer();
    } else if (shimReady) {
      // PRIMARY PATH: write the control file FIRST. Custom → entered wall-clock at
      // the chosen rate; System/Timezone → real time at 1× (the shim has no reset,
      // so jumping the fake clock to now IS the reset; sub-second skew acceptable).
      const target = cfg.source === "custom"
        ? fakeTargetUnix(cfg.customWallMs, hostTz(), now())
        : Math.trunc(now() / 1000);
      const rate = cfg.source === "custom" ? RATE_MULT[cfg.rate] : 1;
      try { await d.setFakeTime(target, rate); } catch { /* ignore */ }
    }
    // System/Timezone with no shim: nothing to write — skip.

    // Best-effort, FIRE-AND-FORGET pypkjs work — must NOT block the write above.
    void d.timeFormat(cfg.hour24).catch(() => { /* bridge down — non-fatal */ });
    if (!(cfg.source === "custom" && !shimReady)) {
      // Skipped in legacy custom: legacyPush already owns the offset, and a
      // host-offset push here would clobber its virtual-clock offset.
      const tzName = cfg.source === "custom" ? hostTz() : cfg.timezone;
      void d.setTzOffset(offsetMinutesFor(cfg, now(), hostTz()), tzName)
        .catch(() => { /* bridge down — non-fatal */ });
    }
  }

  return {
    getConfig: () => ({ ...cfg }),
    async setConfig(next: TimeConfig): Promise<void> {
      cfg = { ...next };
      await apply();
    },
    async applyAll(): Promise<void> {
      await apply();
    },
    async reassert(): Promise<void> {
      // Heal the post_connect host-offset clobber only where it matters: the
      // legacy custom fallback, whose time-varying utc_offset IS the mechanism.
      // (The user-facing Timezone mode was removed, so the offset is always the
      // host offset — exactly what post_connect re-pushes.)
      if (cfg.source === "custom" && legacyActive) {
        // Legacy custom — re-push the virtual-clock offset.
        await legacyPush(true);
      }
      // Shim-backed custom: NO-OP (offset is the host offset — exactly what
      // post_connect pushes). Plain system mode (host zone): NO-OP.
    },
    getStatus: () => ({ shim: shimReady, checked: shimChecked }),
    stop(): void { clearTimer(); },
  };
}
