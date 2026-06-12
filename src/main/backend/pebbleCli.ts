import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";

export interface PebbleCommand {
  cmd: "pebble";
  args: string[];
  env?: Record<string, string>;
}

let activePlatform: PlatformId = "basalt";
export function setActivePlatform(id: PlatformId): void { activePlatform = id; }
export function getActivePlatform(): PlatformId { return activePlatform; }

function base(sub: string, ...rest: string[]): PebbleCommand {
  return { cmd: "pebble", args: [sub, "--emulator", activePlatform, ...rest] };
}

export function installCmd(pbwPath: string): PebbleCommand {
  return { ...base("install", pbwPath), env: { PEBBLE_EMULATOR: activePlatform } };
}

/**
 * Maps ButtonAction to the CLI's action vocabulary.
 * Real CLI: pebble emu-button {click,push,release} [BUTTON ...]
 *   - "press"   -> "click"  (press + release)
 *   - "hold"    -> "push"   (hold down)
 *   - "release" -> "release"
 */
const ACTION_MAP: Record<ButtonAction, string> = {
  press: "click",
  hold: "push",
  release: "release",
};

export function buttonCmd(button: ButtonId, action: ButtonAction): PebbleCommand {
  // Real CLI order: action first, then button(s)
  return base("emu-button", ACTION_MAP[action], button);
}

/**
 * Sends an accelerometer tap event.
 * Real CLI: pebble emu-tap (separate subcommand, not emu-accel tap)
 */
export function accelTapCmd(): PebbleCommand { return base("emu-tap"); }

/**
 * Sets emulator time. With utc=true appends --utc so the firmware applies the
 * value as UTC (utc_offset=0) — making the *displayed* time exactly the epoch
 * interpreted as UTC, independent of the host timezone. We always pass epoch
 * seconds + utc=true so timezone display is deterministic (see timeController).
 * Real CLI: pebble emu-set-time <time> [--utc]
 *   where <time> is HH:MM:SS (today, local) or Unix UTC seconds.
 *   ISO 8601 strings are NOT accepted.
 */
export function setTimeCmd(time: string, utc = false): PebbleCommand {
  return base("emu-set-time", ...(utc ? [time, "--utc"] : [time]));
}

/**
 * Sets the 12h/24h clock style (what clock_is_24h_style() reads).
 * Real CLI: pebble emu-time-format --format {12h|24h}
 */
export function timeFormatCmd(hour24: boolean): PebbleCommand {
  return base("emu-time-format", "--format", hour24 ? "24h" : "12h");
}

/** Toggle the timeline quick-view (peek) on the watchface. Real CLI:
 * pebble emu-set-timeline-quick-view {on|off} */
export function timelineQuickViewCmd(on: boolean): PebbleCommand {
  return base("emu-set-timeline-quick-view", on ? "on" : "off");
}

/**
 * Toggles Bluetooth connection state.
 * Real CLI: pebble emu-bt-connection --connected {yes,no}
 */
export function btCmd(connected: boolean): PebbleCommand {
  return base("emu-bt-connection", "--connected", connected ? "yes" : "no");
}

export function batteryCmd(percent: number, charging: boolean): PebbleCommand {
  const cmd = base("emu-battery", "--percent", String(percent));
  if (charging) cmd.args.push("--charging");
  return cmd;
}

export function screenshotCmd(outPath: string): PebbleCommand { return base("screenshot", outPath); }

export function bootCmd(platform: PlatformId): PebbleCommand {
  return { cmd: "pebble", args: ["emu-control", "--emulator", platform, "--vnc"] };
}

/**
 * Wipes all emulator data for the current SDK version.
 * NOTE: `pebble wipe` has NO --emulator flag — it wipes ALL platform dirs
 * (basalt, chalk, etc.) under the active SDK version's persist directory.
 * The emulator CANNOT survive a wipe; a full reboot is required afterward.
 * (Empirically confirmed: deletes ~/.local/share/pebble-sdk/<ver>/{basalt,...})
 */
export function wipeCmd(): PebbleCommand {
  return { cmd: "pebble", args: ["wipe"] };
}
