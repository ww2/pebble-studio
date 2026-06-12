export type TimeSource = "system" | "custom";
export type Rate = "frozen" | "1x" | "2x" | "4x" | "10x";

/** Virtual-clock multiplier per rate. 0 = frozen, 1 = real-time, N = N× faster. */
export const RATE_MULT: Record<Rate, number> = { frozen: 0, "1x": 1, "2x": 2, "4x": 4, "10x": 10 };

/**
 * EMULATOR TIME CONTRACT (verified empirically against qemu-pebble + pebble-tool
 * v5.0.37 / SDK 4.9.169 — see memory `pebble-emu-time-mechanism`):
 *
 *   - The qemu RTC is slaved to the HOST wall-clock UTC. A pushed absolute time is
 *     IGNORED — both SetUTC.unix_time AND SetLocaltime are no-ops (the clock stays
 *     at host UTC, ticking 1×). We can NOT set absolute time.
 *   - The firmware DOES honor `utc_offset` (Int16 minutes): displayed local =
 *     host_UTC + utc_offset. (Verified: +540 → Tokyo, −240 → New York.)
 *   - pypkjs (the phone bridge we push through) serves ONE client at a time, so a
 *     PERSISTENT pusher would starve the app's button/screenshot commands. We
 *     therefore push via SHORT-LIVED connections (driver.setTzOffset), and only
 *     when the integer offset actually changes — leaving the bridge free between.
 *
 * The single lever is `utc_offset`. We model a virtual clock V(t)=base+rate·(t−anchor)
 * and, on a 1 s main-process timer, push offset=round((V−host_UTC)/60) whenever that
 * minute value changes. Consequences:
 *   - System   → constant host offset (no timer churn).
 *   - Timezone → constant zone offset.
 *   - Custom 1× → constant (entered − now); shows the entered time, drifts at 1×.
 *   - Custom Frozen → offset decrements ~1/min so the displayed minute holds.
 *   - Custom 2×/4×/10× → offset grows so the display fast-forwards.
 * Minute granularity means SECONDS always come from the host (can't be frozen), and
 * |offset| ≤ 32767 min caps absolute displacement at ~±22.7 days. Resets on reboot.
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
  source: "system", rate: "1x", timezone: "UTC", hour24: true, customWallMs: 0,
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
 * The `utc_offset` (minutes) to display the configured time at real instant `nowMs`.
 * For non-1× custom rates this is time-varying (the virtual clock); for everything
 * else it is constant. `anchorMs` is the real time the config was applied (so the
 * virtual clock advances from there). `hostTz` is injectable for tests.
 */
export function offsetMinutesFor(
  cfg: TimeConfig,
  nowMs: number,
  hostTz: string = detectHostTimezone(),
  anchorMs: number = nowMs,
): number {
  void hostTz; // System & Timezone both encode the desired zone in cfg.timezone.
  if (cfg.source === "custom") {
    // virtual(now) = entered + rate·(elapsed since apply); display = host_UTC + offset,
    // host_UTC = now, so offset = virtual − now.
    const mult = RATE_MULT[cfg.rate];
    const virtualMs = cfg.customWallMs + mult * (nowMs - anchorMs);
    return clampOffset((virtualMs - nowMs) / 60000);
  }
  return clampOffset(tzOffsetMinutes(cfg.timezone, new Date(nowMs)));
}

/** Does this config use a time-varying offset (needs the 1 s pusher)? */
export function isVirtualClock(cfg: TimeConfig): boolean {
  return cfg.source === "custom" && RATE_MULT[cfg.rate] !== 1;
}

/** Watch time differs from plain host system time? (drives the renderer badge.) */
export function isNonSystemTime(cfg: TimeConfig, hostTz: string): boolean {
  return cfg.source === "custom" || cfg.rate !== "1x" || cfg.timezone !== hostTz;
}

interface TimeDriver {
  /** Push a UTC offset (minutes) via a short-lived raw SetUTC. */
  setTzOffset(offsetMin: number): Promise<void>;
  timeFormat(hour24: boolean): Promise<void>;
}

export interface TimeController {
  setConfig(cfg: TimeConfig): Promise<void>;
  getConfig(): TimeConfig;
  /** Re-assert current config on the (re)booted emulator. */
  applyAll(): Promise<void>;
  /** Force-push the current offset after a command that may have reset it (every
   * pebble command re-syncs host time on connect). Heals the clobber immediately. */
  reassert(): Promise<void>;
  stop(): void;
}

/** How often the virtual-clock pusher recomputes (it only sends on minute change). */
const VCLOCK_TICK_MS = 1000;

export function makeTimeController(
  getDriver: () => TimeDriver | null,
  deps: { now?: () => number; hostTz?: () => string } = {},
): TimeController {
  const now = deps.now ?? (() => Date.now());
  const hostTz = deps.hostTz ?? (() => detectHostTimezone());
  let cfg: TimeConfig = { ...DEFAULT_TIME_CONFIG };
  let anchorMs = now();           // real time the current cfg was applied
  let lastPushed: number | null = null;  // last offset minutes actually sent
  let timer: ReturnType<typeof setInterval> | null = null;
  let pushing = false;

  /** Send the offset for instant `t` if it differs from the last sent value. */
  async function push(force: boolean): Promise<void> {
    if (pushing) return;
    pushing = true;
    try {
      const d = getDriver();
      if (!d) return;
      const off = offsetMinutesFor(cfg, now(), hostTz(), anchorMs);
      if (!force && off === lastPushed) return; // no minute change → leave bridge free
      await d.setTzOffset(off);
      lastPushed = off;
    } catch { /* tool/emulator may be absent; degrade silently */ }
    finally { pushing = false; }
  }

  function clearTimer(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function syncTimer(): void {
    clearTimer();
    // Only a virtual clock needs periodic re-pushing (offset changes over time).
    // Static modes hold a constant offset; clobbers are healed by reassert().
    if (isVirtualClock(cfg)) timer = setInterval(() => void push(false), VCLOCK_TICK_MS);
  }

  /** Apply the current cfg: set the 12/24h format and push the initial offset. */
  async function apply(): Promise<void> {
    anchorMs = now();
    lastPushed = null;
    const d = getDriver();
    if (d) { try { await d.timeFormat(cfg.hour24); } catch { /* ignore */ } }
    await push(true);
    syncTimer();
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
      await push(true);
    },
    stop(): void { clearTimer(); },
  };
}
