export type TimeSource = "system" | "custom";
export type Rate = "frozen" | "1x" | "2x" | "4x" | "10x";

/** Fake-clock multiplier per rate. 0 = frozen, 1 = real-time, N = N× faster. */
export const RATE_MULT: Record<Rate, number> = { frozen: 0, "1x": 1, "2x": 2, "4x": 4, "10x": 10 };

/**
 * The rate actually WRITTEN to qemu's control file for "Frozen" — a tiny non-zero
 * value, NOT 0.
 *
 * WHY (proven live on basalt, v3.0.3-test9): an exactly-0 rate freezes the RTC
 * dead, and the session-8 freeze-fix firmware (`rtc_alarm_get_elapsed_ticks()`
 * falling back to the commanded wakeup duration when the RTC doesn't advance) then
 * fires the MINUTE-tick alarm, re-arms it, and "elapses" it again instantly → a
 * tight minute-tick loop. A STATIC watchface shows nothing (so this looked like
 * "frozen just stops repaint"), but an animated face (e.g. JR-Shinkansen, which
 * animates on each minute rollover) replays its animation many times per second.
 *
 * A tiny rate makes the RTC inch forward so the tick alarm sees real progress and
 * never re-fires in a loop, while the user still perceives a frozen clock: at
 * 1e-3 the displayed minute changes only once every ~16.7 h of real time. The
 * controller keeps the LOGICAL rate at 0 (RATE_MULT.frozen) everywhere else —
 * currentWatchUnix, the heal gate — so only the value qemu sees changes. Empirically
 * validated static at 1e-3 and 1e-2; do NOT lower toward 0 without re-testing (too
 * small re-enters the firmware's zero-delta fallback).
 */
export const QEMU_FROZEN_RATE = 1e-3;

/**
 * EMULATOR TIME CONTRACT — v0.0.13 control-file model:
 *
 *   - The qemu firmware clock is continuously re-jammed from the qemu PROCESS's
 *     CLOCK_REALTIME. An LD_PRELOAD shim (timeShim.ts) fakes that clock, driven
 *     by a control file `<target_unix|-> <rate>` re-read on mtime change. This
 *     is the PRIMARY lever: true absolute date, real frozen seconds, exact rates,
 *     via driver.setFakeTime(targetUnix|null, rate).
 *   - `utc_offset` (Int16 minutes, raw SetUTC via driver.setTzOffset) is the
 *     display offset: displayed local = fake_UTC + utc_offset. It is ALWAYS the
 *     HOST offset now (the user-facing Timezone picker was removed in v0.0.13.1);
 *     pebble-tool's post_connect already re-pushes the host offset on every
 *     command connect, so our push is a best-effort backstop (covers a freshly
 *     booted watch with no app installed yet), not the mechanism:
 *       · System → fake clock = real time (control file `<now> 1`).
 *       · Custom → fake clock = the entered wall-clock baked into the control-file
 *         target; utc_offset stays at the host offset, so post_connect's re-push
 *         is a no-op (clobber-immune by construction; no reassert, no timer).
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
 * The CONSTANT `utc_offset` (minutes) for a config. This is always the host
 * offset now (Timezone mode removed): System reads cfg.timezone, which the UI
 * always sets to the host zone; Custom reads the host zone directly. (The pure
 * function still accepts any zone — it's also where the host offset is computed.)
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
  /** Force-push the offset after a command that may have reset it. Only matters
   * for the legacy custom fallback now — shim-backed custom keeps the offset at
   * the host offset (post_connect's re-push is already a no-op), and System needs
   * no re-push. */
  reassert(): Promise<void>;
  /** Time-shim readiness as last reported by ensureTimeShim(). `checked` is
   * false until the first real probe (at boot/apply) — the renderer must not
   * show "shim unavailable" off the unchecked default. */
  getStatus(): { shim: boolean; checked: boolean };
  /** The watch's current UTC (unix seconds): system → real time; custom → the
   * entered target advanced by its rate since apply. Drives sample-pin timing. */
  currentWatchUnix(): number;
  stop(): void;
}

/** How often the legacy virtual-clock pusher recomputes (it only sends on minute change). */
const VCLOCK_TICK_MS = 1000;

/**
 * FROZEN SetUTC RE-ASSERT — delays (ms after a frozen custom apply) at which the
 * watch time is re-pushed so the LAST SetUTC it sees is the correct custom time.
 *
 * WHY (verified live on emery/QEMU10): while the clock is FROZEN the watch's
 * displayed time is whatever the most recent SetUTC carried — NOT qemu's RTC. A
 * running clock re-jams the RTC from the fake clock every tick (self-correcting),
 * but a frozen clock does not, so a stray SetUTC sticks and a control-file write
 * canNOT dislodge it (tested: `- 0`, `- 1`, even a fresh absolute target leave the
 * wedged time unchanged). The ONLY things that move it are another SetUTC or a
 * watchface reload (menu→back). pebble-tool's post_connect sends a SetUTC on every
 * libpebble2 connect using time.time(); the bundled python's sitecustomize fakes
 * that to the custom time only when PEBBLE_FAKETIME_FILE is in the process env, so
 * a connect missing it (or one landing just after our own push) can leave a stray
 * time on the frozen face — the "custom Frozen time shows a random time" bug.
 *
 * The fix is to make OUR correct SetUTC the last word: re-running timeFormat()
 * fires pebble-tool's post_connect, which (with the fake-time env now exported to
 * every child — see createDriver.ts) re-pushes SetUTC(custom time). This was
 * proven to recover an already-wedged frozen face. Two staggered re-asserts cover
 * a slow/contended connect that lands after the first.
 */
const FROZEN_HEAL_DELAYS_MS = [1500, 3500];

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

  // Fake-clock anchor for currentWatchUnix(). Updated on every shim apply() write.
  // Defaults describe real time at construction so a pre-apply read is sane.
  let fakeTarget = Math.trunc(now() / 1000);
  let fakeRate = 1;
  let fakeAppliedAtMs = now();

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
  // Pending FROZEN_HEAL_DELAYS_MS re-jam timers (see that constant). Cleared at
  // the start of every apply() and on stop() so they never fire after a newer
  // config is applied or after teardown.
  let healTimers: ReturnType<typeof setTimeout>[] = [];
  function clearHealTimers(): void {
    for (const t of healTimers) clearTimeout(t);
    healTimers = [];
  }
  // In-flight guard for the apply()/reassert host-offset push. setTzOffset opens a
  // connection to the single-client pypkjs bridge; without this, a slow/contended
  // push fired on every boot/install/relaunch overlaps with the next one and they
  // stack up (confirmed live: 15+ hung pb-set-tz.py chains), starving the bridge.
  // Combined with the helper's `timeout` bound, pushes can neither hang nor pile up.
  let tzPushInFlight = false;
  async function pushTzOffsetGuarded(d: TimeDriver, off: number, tzName?: string): Promise<void> {
    if (tzPushInFlight) return; // a push is already running — skip (latest state re-pushes next time)
    tzPushInFlight = true;
    try {
      await d.setTzOffset(off, tzName);
    } catch {
      /* bridge down — non-fatal */
    } finally {
      tzPushInFlight = false;
    }
  }

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
   * push is harmless). Only the LEGACY fallback (no shim) must await its offset
   * push, since there the utc_offset IS the only lever.
   */
  async function apply(): Promise<void> {
    clearTimer();
    clearHealTimers();
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
      // PRIMARY PATH: write the control file FIRST.
      //   · Custom → the entered wall-clock baked into an ABSOLUTE target at rate.
      //   · System → a RELATIVE anchor ("- 1"), NOT an absolute "<now> 1". The f2xx
      //     RTC (basalt/chalk/diorite/aplite) seeds its clock from the control file
      //     at qemu *realize*, which happens BEFORE this apply() runs (apply fires
      //     after the emulator reaches "live"). An absolute target written here is
      //     read one boot STALE at the next realize, seeding that RTC tens-of-seconds
      //     behind real — and the f2xx host→target offset is computed once and
      //     sticks, so the watch runs permanently ~1 min behind. (The generic-RTC
      //     M33 boards — emery/gabbro/flint — re-read the live clock every access,
      //     so they were unaffected.) A relative "-" anchor reads as real time
      //     WHENEVER qemu reads it, so the seed is correct regardless of ordering.
      const isCustom = cfg.source === "custom";
      const target = isCustom ? fakeTargetUnix(cfg.customWallMs, hostTz(), now()) : null;
      const rate = isCustom ? RATE_MULT[cfg.rate] : 1;
      fakeTarget = target ?? Math.trunc(now() / 1000); // currentWatchUnix anchor: system tracks real now
      fakeRate = rate; // LOGICAL rate (0 for frozen) — keeps currentWatchUnix truly frozen
      fakeAppliedAtMs = now();
      // QEMU rate: substitute the tiny QEMU_FROZEN_RATE for an exactly-0 (frozen)
      // rate so the firmware's minute-tick alarm doesn't loop (see QEMU_FROZEN_RATE).
      const qemuRate = rate === 0 ? QEMU_FROZEN_RATE : rate;
      try { await d.setFakeTime(target, qemuRate); } catch { /* ignore */ }
    }
    // System with no shim: nothing to write — skip.

    // Best-effort, FIRE-AND-FORGET pypkjs work — must NOT block the write above.
    void d.timeFormat(cfg.hour24).catch(() => { /* bridge down — non-fatal */ });
    if (!(cfg.source === "custom" && !shimReady)) {
      // Skipped in legacy custom: legacyPush already owns the offset, and a
      // host-offset push here would clobber its virtual-clock offset.
      const tzName = cfg.source === "custom" ? hostTz() : cfg.timezone;
      void pushTzOffsetGuarded(d, offsetMinutesFor(cfg, now(), hostTz()), tzName);
    }

    // FROZEN SetUTC RE-ASSERT (see FROZEN_HEAL_DELAYS_MS): only a shim-backed
    // FROZEN custom clock needs it — running rates re-jam every tick (self-
    // healing), and the legacy fallback drives the display via the offset pusher.
    // Each timer re-runs timeFormat(): its post_connect re-pushes SetUTC(custom
    // time) so OUR correct time is the last SetUTC the frozen watch sees, undoing
    // any stray push that landed just after apply().
    if (cfg.source === "custom" && shimReady && RATE_MULT[cfg.rate] === 0) {
      for (const delayMs of FROZEN_HEAL_DELAYS_MS) {
        healTimers.push(setTimeout(() => {
          const dd = getDriver();
          if (dd) void dd.timeFormat(cfg.hour24).catch(() => { /* emulator gone — non-fatal */ });
        }, delayMs));
      }
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
    currentWatchUnix(): number {
      return Math.trunc(fakeTarget + ((now() - fakeAppliedAtMs) / 1000) * fakeRate);
    },
    stop(): void { clearTimer(); clearHealTimers(); },
  };
}
