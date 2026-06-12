import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";

export interface PebbleCommand {
  // Usually "pebble"; setTzOffsetCmd uses "bash -lc …" to run the raw-SetUTC helper.
  cmd: string;
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

/**
 * Push the watch's UTC offset (minutes) via a RAW SetUTC packet, bypassing
 * `pebble emu-set-time`.
 *
 * WHY NOT `emu-set-time`: the qemu RTC is slaved to host UTC, so SetUTC's
 * `unix_time` is ignored — only `utc_offset` moves the displayed time. But the
 * stock CLI can only send offset 0 (`--utc`) or the host offset (no `--utc`),
 * never an arbitrary zone. AND every `pebble` command re-syncs host time on
 * connect (commands/base.py post_connect). A raw libpebble2 connection sends ONLY
 * our offset and skips post_connect entirely. (See timeController's contract.)
 *
 * Self-contained: deploys a tiny helper (base64 below) under ~/.pebble-studio on
 * first/every call, then runs it with pebble-tool's bundled python (whose libpebble2
 * has the protocol). Returned as a `bash -lc` command so the same (cmd,args) routes
 * through the native runner OR the WSL runner (`wsl.exe -- bash -lc …`) unchanged.
 */
// Helper source (pb-set-tz.py): connects to the running emulator's pypkjs websocket
// (port from /tmp/pb-emulator.json) and sends SetUTC(now, utc_offset=argv[1]).
const SET_TZ_HELPER_B64 =
  "aW1wb3J0IHN5cywganNvbiwgdGltZQpmcm9tIGxpYnBlYmJsZTIuY29tbXVuaWNhdGlvbiBpbXBvcnQgUGViYmxlQ29ubmVjdGlvbgpmcm9tIGxpYnBlYmJsZTIuY29tbXVuaWNhdGlvbi50cmFuc3BvcnRzLndlYnNvY2tldCBpbXBvcnQgV2Vic29ja2V0VHJhbnNwb3J0CmZyb20gbGlicGViYmxlMi5wcm90b2NvbC5zeXN0ZW0gaW1wb3J0IFRpbWVNZXNzYWdlLCBTZXRVVEMKb2Zmc2V0ID0gaW50KHN5cy5hcmd2WzFdKQppbmZvID0ganNvbi5sb2FkKG9wZW4oJy90bXAvcGItZW11bGF0b3IuanNvbicpKQpwb3J0ID0gTm9uZQpmb3IgcGxhdCwgdmVycyBpbiBpbmZvLml0ZW1zKCk6CiAgICBmb3IgdiwgZCBpbiB2ZXJzLml0ZW1zKCk6CiAgICAgICAgcCA9IChkLmdldCgncHlwa2pzJykgb3Ige30pLmdldCgncG9ydCcpCiAgICAgICAgaWYgcDogcG9ydCA9IHAKaWYgcG9ydCBpcyBOb25lOgogICAgc3lzLmV4aXQoJ25vIHB5cGtqcyBwb3J0IGluIC90bXAvcGItZW11bGF0b3IuanNvbicpCmMgPSBQZWJibGVDb25uZWN0aW9uKFdlYnNvY2tldFRyYW5zcG9ydCgnd3M6Ly9sb2NhbGhvc3Q6JWQvJyAlIHBvcnQpKQpjLmNvbm5lY3QoKTsgYy5ydW5fYXN5bmMoKQp0cyA9IGludCh0aW1lLnRpbWUoKSkKbmFtZSA9ICdVVEMlK2QnICUgKG9mZnNldCAvLyA2MCkKYy5zZW5kX3BhY2tldChUaW1lTWVzc2FnZShtZXNzYWdlPVNldFVUQyh1bml4X3RpbWU9dHMsIHV0Y19vZmZzZXQ9b2Zmc2V0LCB0el9uYW1lPW5hbWUpKSkKdGltZS5zbGVlcCgwLjQpCnByaW50KCdzZW50IG9mZnNldD0lZCAoJXMpIHZpYSB3cyBwb3J0ICVkJyAlIChvZmZzZXQsIG5hbWUsIHBvcnQpKQo=";

export function setTzOffsetCmd(offsetMin: number): PebbleCommand {
  const off = Math.trunc(offsetMin);
  const oneLiner =
    `mkdir -p "$HOME/.pebble-studio"; ` +
    `H="$HOME/.pebble-studio/pb-set-tz.py"; ` +
    `echo '${SET_TZ_HELPER_B64}' | base64 -d > "$H"; ` +
    `PYBIN=$(sed -n '1s/^#!//p' "$(command -v pebble)"); ` +
    `"$PYBIN" "$H" ${off}`;
  return { cmd: "bash", args: ["-lc", oneLiner] };
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
