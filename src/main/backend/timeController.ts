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
