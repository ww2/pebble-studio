export type TimeSource = "system" | "custom";

/** Internal stepping state: a wall-clock anchor (as a UTC epoch) advancing at `multiplier`. */
export interface TimeState {
  source: TimeSource;
  multiplier: number;      // 0=frozen, 1,2,4,10
  timezone: string;        // IANA name
  anchorUtcSec: number;    // displayed wall-clock at anchorRealMs, encoded as a UTC epoch
  anchorRealMs: number;    // real wall-clock (Date.now) when the anchor was set
}

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

/** The epoch (seconds) to send via `emu-set-time <epoch> --utc` at real time `nowMs`. */
export function computeTargetEpochSec(st: TimeState, nowMs: number): number {
  if (st.multiplier === 0) return st.anchorUtcSec; // frozen
  const elapsedSec = (nowMs - st.anchorRealMs) / 1000;
  return Math.floor(st.anchorUtcSec + elapsedSec * st.multiplier);
}

export type Rate = "frozen" | "1x" | "2x" | "4x" | "10x";

export interface TimeConfig {
  source: TimeSource;
  rate: Rate;
  timezone: string;
  hour24: boolean;
  customWallMs: number; // when source==="custom": the wall-clock the user entered, as a UTC-naive epoch ms
}

const RATE_MULT: Record<Rate, number> = { frozen: 0, "1x": 1, "2x": 2, "4x": 4, "10x": 10 };

export const DEFAULT_TIME_CONFIG: TimeConfig = {
  source: "system", rate: "1x", timezone: "UTC", hour24: false, customWallMs: 0,
};

/** Pick the host IANA zone; fall back to PST when empty or a bare "UTC". */
export function detectHostTimezone(get: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const tz = (get() || "").trim();
  if (!tz || tz === "UTC") return "America/Los_Angeles";
  return tz;
}

/**
 * Build the stepping anchor from a config at real time `nowMs`.
 *
 * Firmware offset contract: in practice the emulator firmware renders the pushed
 * epoch through the HOST's local UTC offset — it does NOT treat `--utc` as
 * offset 0 (that assumption put the watch a full host-offset off, e.g. −5h).
 * So we compute the wall-clock we want *displayed* and subtract the host offset
 * once; the firmware adds it back, landing on the intended time. Consequences:
 *   - System mode (cfg.timezone === host): nets out to plain true UTC.
 *   - Timezone mode (cfg.timezone === some zone Z): shifts by (Z − host).
 *   - Custom mode: the entered host-local wall-clock, minus the host offset.
 * `hostTz` is injectable so the math is deterministic under test.
 */
export function anchorFor(
  cfg: TimeConfig,
  nowMs: number,
  hostTz: string = detectHostTimezone(),
): TimeState {
  const multiplier = RATE_MULT[cfg.rate];
  const at = new Date(nowMs);
  const hostOffsetSec = tzOffsetMinutes(hostTz, at) * 60;
  let anchorUtcSec: number;
  if (cfg.source === "system") {
    // Desired display = live wall-clock in cfg.timezone (host for System mode, a
    // chosen zone for Timezone mode). Minus the host offset the firmware re-adds.
    anchorUtcSec = Math.floor(nowMs / 1000) + tzOffsetMinutes(cfg.timezone, at) * 60 - hostOffsetSec;
  } else {
    // Desired display = the entered host-local wall-clock. Minus the host offset.
    anchorUtcSec = Math.floor(cfg.customWallMs / 1000) - hostOffsetSec;
  }
  return { source: cfg.source, multiplier, timezone: cfg.timezone, anchorUtcSec, anchorRealMs: nowMs };
}

/** Watch time differs from plain host system time? (drives the renderer badge.) */
export function isNonSystemTime(cfg: TimeConfig, hostTz: string): boolean {
  return cfg.source === "custom" || cfg.rate !== "1x" || cfg.timezone !== hostTz;
}

interface TimeDriver {
  setTime(value: string, opts?: { utc?: boolean }): Promise<void>;
  timeFormat(hour24: boolean): Promise<void>;
}

export interface TimeController {
  setConfig(cfg: TimeConfig): Promise<void>;
  getConfig(): TimeConfig;
  /** Re-assert current config on the (re)booted emulator. */
  applyAll(): Promise<void>;
  stop(): void;
}

const TICK_MS = 1000;
const RESYNC_MS = 30_000;

export function makeTimeController(
  getDriver: () => TimeDriver | null,
  deps: { now?: () => number; hostTz?: () => string } = {},
): TimeController {
  const now = deps.now ?? (() => Date.now());
  const hostTz = deps.hostTz ?? (() => detectHostTimezone());
  let cfg: TimeConfig = { ...DEFAULT_TIME_CONFIG };
  let state: TimeState = anchorFor(cfg, now(), hostTz());
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSyncMs = 0;
  let pushing = false;

  async function push(): Promise<void> {
    if (pushing) return;
    pushing = true;
    try {
      const d = getDriver();
      if (!d) return;
      const epoch = computeTargetEpochSec(state, now());
      await d.setTime(String(epoch), { utc: true });
    } catch { /* patched CLI may be absent; degrade silently */ }
    finally { pushing = false; }
  }

  function syncTimer(): void {
    // Frozen (mult 0) and acceleration (mult>1) need the ~1s loop. Plain 1x lets
    // the watch RTC tick on its own; we only resync occasionally for drift.
    const needsFastLoop = state.multiplier !== 1;
    if (timer) { clearInterval(timer); timer = null; }
    if (needsFastLoop) {
      timer = setInterval(() => void push(), TICK_MS);
    } else {
      timer = setInterval(() => {
        if (now() - lastSyncMs >= RESYNC_MS) { lastSyncMs = now(); void push(); }
      }, TICK_MS);
    }
  }

  return {
    getConfig: () => ({ ...cfg }),
    async setConfig(next: TimeConfig): Promise<void> {
      cfg = { ...next };
      state = anchorFor(cfg, now(), hostTz());
      lastSyncMs = now();
      const d = getDriver();
      if (d) { try { await d.timeFormat(cfg.hour24); } catch { /* ignore */ } }
      await push();
      syncTimer();
    },
    async applyAll(): Promise<void> {
      state = anchorFor(cfg, now(), hostTz());
      lastSyncMs = now();
      const d = getDriver();
      if (d) { try { await d.timeFormat(cfg.hour24); } catch { /* ignore */ } }
      await push();
      syncTimer();
    },
    stop(): void { if (timer) { clearInterval(timer); timer = null; } },
  };
}
