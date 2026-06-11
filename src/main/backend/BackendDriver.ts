import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";

export interface RunResult { code: number; stdout: string; stderr: string; }
export type Runner = (cmd: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;
export interface VncEndpoint { host: string; port: number; wsPath: string; }

export interface BackendDriver {
  setPlatform(id: PlatformId): void;
  start(id: PlatformId): Promise<VncEndpoint>;
  stop(): Promise<void>;
  install(pbwPath: string): Promise<void>;
  button(id: ButtonId, action: ButtonAction): Promise<void>;
  accelTap(): Promise<void>;
  setTime(value: string | "system"): Promise<void>;
  bluetooth(connected: boolean): Promise<void>;
  battery(percent: number, charging: boolean): Promise<void>;
  screenshot(outPath: string): Promise<void>;
  /** Wipe all emulator data for the current SDK version. The emulator cannot
   * survive a wipe; caller must reboot afterward. */
  wipe(): Promise<void>;
}
