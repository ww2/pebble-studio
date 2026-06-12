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
  timezone: string;     // IANA name. System: the host zone. Timezone mode: a chosen zone.
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

/** Watch time differs from plain host system time? (drives the renderer badge.) */
export function isNonSystemTime(cfg: TimeConfig, hostTz: string): boolean {
  return cfg.source === "custom" || cfg.rate !== "1x" || cfg.timezone !== hostTz;
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
  /** Time-shim readiness as last reported by ensureTimeShim() (false until checked). */
  getStatus(): { shim: boolean };
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

  /** Apply the current cfg: 12/24h format, the constant utc_offset, then the
   * shim control file (or the legacy fallback when the shim is unavailable). */
  async function apply(): Promise<void> {
    clearTimer();
    legacyActive = false;
    const d = getDriver();
    if (!d) return;

    try { await d.timeFormat(cfg.hour24); } catch { /* ignore */ }

    // Constant offset for ALL modes — boot needs it (firmware may default to
    // offset 0). Custom keeps the HOST offset (clobber-immune, see contract).
    const tzName = cfg.source === "custom" ? hostTz() : cfg.timezone;
    try { await d.setTzOffset(offsetMinutesFor(cfg, now(), hostTz()), tzName); } catch { /* ignore */ }

    try { shimReady = await d.ensureTimeShim(); } catch { shimReady = false; }

    if (cfg.source === "custom") {
      if (shimReady) {
        try {
          await d.setFakeTime(fakeTargetUnix(cfg.customWallMs, hostTz(), now()), RATE_MULT[cfg.rate]);
        } catch { /* ignore */ }
      } else {
        // Legacy fallback: virtual clock via utc_offset.
        legacyActive = true;
        anchorMs = now();
        lastPushed = null;
        await legacyPush(true);
        syncLegacyTimer();
      }
    } else if (shimReady) {
      // System & Timezone: return the fake clock to real time. The shim has no
      // reset; jumping to now at 1× IS the reset (sub-second skew acceptable).
      try { await d.setFakeTime(Math.trunc(now() / 1000), 1); } catch { /* ignore */ }
    }
    // System/Timezone with no shim: nothing to undo — skip silently.
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
      // Heal the post_connect host-offset clobber only where it matters:
      // Timezone mode is system-source with a non-host zone.
      const isTimezoneMode = cfg.source === "system" && cfg.timezone !== hostTz();
      if (isTimezoneMode) {
        // Timezone mode — re-push the chosen zone's offset.
        const d = getDriver();
        if (!d) return;
        try { await d.setTzOffset(offsetMinutesFor(cfg, now(), hostTz()), cfg.timezone); } catch { /* ignore */ }
      } else if (cfg.source === "custom" && legacyActive) {
        // Legacy custom — re-push the virtual-clock offset.
        await legacyPush(true);
      }
      // Shim-backed custom: NO-OP (offset is the host offset — exactly what
      // post_connect pushes). Plain system mode (host zone): NO-OP.
    },
    getStatus: () => ({ shim: shimReady }),
    stop(): void { clearTimer(); },
  };
}
