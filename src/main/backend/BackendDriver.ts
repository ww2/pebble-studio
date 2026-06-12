import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BootToken, OnStep } from "./bootEmulator.js";

export interface RunResult { code: number; stdout: string; stderr: string; }
export type Runner = (cmd: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;
export interface VncEndpoint { host: string; port: number; wsPath: string; }

export interface BackendDriver {
  setPlatform(id: PlatformId): void;
  /** Boot the emulator. An optional cancellation token lets an in-flight boot
   * abort promptly (the boot's wait loops check it). An optional `onStep` receives
   * a label before each major boot step (for diagnostic boot notes). */
  start(id: PlatformId, token?: BootToken, onStep?: OnStep): Promise<VncEndpoint>;
  stop(): Promise<void>;
  install(pbwPath: string): Promise<void>;
  button(id: ButtonId, action: ButtonAction): Promise<void>;
  accelTap(): Promise<void>;
  setTime(value: string, opts?: { utc?: boolean }): Promise<void>;
  /** Push the watch's UTC offset (minutes) via a raw SetUTC — the only lever that
   * moves the displayed time on qemu-pebble (see timeController's contract).
   * `tzName` (IANA zone) is sent as the SetUTC tz_name; falls back to "UTC±h". */
  setTzOffset(offsetMin: number, tzName?: string): Promise<void>;
  timeFormat(hour24: boolean): Promise<void>;
  bluetooth(connected: boolean): Promise<void>;
  battery(percent: number, charging: boolean): Promise<void>;
  screenshot(outPath: string): Promise<void>;
  /** Wipe all emulator data for the current SDK version. The emulator cannot
   * survive a wipe; caller must reboot afterward. */
  wipe(): Promise<void>;
  timelineQuickView(on: boolean): Promise<void>;
}
