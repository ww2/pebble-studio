// batteryController.ts — remember the user's chosen simulated battery level and
// re-assert it after every emulator reboot.
//
// `pebble emu-battery` only sets the LIVE emulator's level; a reboot boots the
// firmware back at its default (emery 100%, basalt 80%), silently dropping the
// user's choice. Reboots happen for several reasons — the sim-weather refresh
// (stop → clear → start → reinstall), "Clear emulator", and a model relaunch —
// and the renderer pushes battery ONLY on the "Set battery" click, so without a
// main-side memory the level reverts on the next boot (the reported bug: change
// the weather and the battery snaps back to default). This controller stores the
// last applied (percent, charging) and re-pushes it whenever a fresh boot
// re-asserts state, alongside the time controller.

export interface BatteryDriver {
  battery(percent: number, charging: boolean): Promise<void>;
}

export interface BatteryState {
  percent: number;
  charging: boolean;
}

export interface BatteryController {
  /** Apply a level to the live emulator and remember it for future reboots. */
  set(percent: number, charging: boolean): Promise<void>;
  /** Re-push the last applied level to a freshly booted emulator. No-op until the
   *  user has set one this session; best-effort (never throws — the bridge may
   *  not be ready yet, same as the time controller's reassert). */
  reassert(): Promise<void>;
  /** The last applied level, or null until the first set() (for inspection/tests). */
  get(): BatteryState | null;
}

/** Round and clamp to a valid integer percentage in [0,100]. */
export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
}

export function makeBatteryController(
  getDriver: () => BatteryDriver | null,
): BatteryController {
  let last: BatteryState | null = null;
  return {
    async set(percent, charging) {
      const state: BatteryState = { percent: clampPercent(percent), charging: !!charging };
      // Remember BEFORE the live push so the level is retained for the next reboot
      // even if this push fails (bridge contention) — symmetric with the time
      // controller persisting its config independently of the push succeeding.
      last = state;
      const d = getDriver();
      if (d) await d.battery(state.percent, state.charging);
    },
    async reassert() {
      if (!last) return;
      const d = getDriver();
      if (!d) return;
      try {
        await d.battery(last.percent, last.charging);
      } catch {
        /* bridge down / not ready — best-effort, re-pushes on the next boot */
      }
    },
    get() {
      return last;
    },
  };
}
