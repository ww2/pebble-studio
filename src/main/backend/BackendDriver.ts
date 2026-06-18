import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BootToken, OnStep } from "./bootEmulator.js";

export interface RunResult { code: number; stdout: string; stderr: string; }
export type Runner = (cmd: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;
export interface VncEndpoint { host: string; port: number; wsPath: string; }

/** Result of a health-activation attempt. `status` is the BlobResponse code
 * (1 === Success); null when the helper produced no parseable status. */
export interface HealthActivateResult { ok: boolean; status: number | null; detail: string; }

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
  /** Write the qemu time-shim control file (true custom date/freeze/rate).
   * target=null keeps the current fake time; rate 0=frozen, 1=real, N=N×. */
  setFakeTime(targetUnix: number | null, rate: number): Promise<void>;
  /** Deploy + verify the LD_PRELOAD time shim (cached). False ⇒ fall back to
   * utc_offset-only behavior. */
  ensureTimeShim(): Promise<boolean>;
  timeFormat(hour24: boolean): Promise<void>;
  bluetooth(connected: boolean): Promise<void>;
  battery(percent: number, charging: boolean): Promise<void>;
  /** Activate Pebble Health on the running emulator (BlobDB Prefs INSERT over
   * pypkjs). Never throws — returns the BlobResponse status so callers can log/
   * surface success vs. skip. Safe to call when health is already active. */
  activateHealth(): Promise<HealthActivateResult>;
  screenshot(outPath: string): Promise<void>;
  /** BACKLIGHT-FREE framebuffer screenshot over the watch protocol (libpebble2
   * Screenshot service, endpoint 8000 — bright regardless of the LCD backlight),
   * written to `outPath` as PNG. Resolves true on success, false on ANY failure
   * (unsupported driver, no emulator, helper/grab error, timeout) so the caller
   * can fall back to the VNC-canvas + backlight grab. Only the windows-native
   * driver implements it (reusing the persistent input helper's pypkjs socket);
   * the others return false. */
  screenshotFramebuffer(outPath: string): Promise<boolean>;
  /** Wipe all emulator data for the current SDK version. The emulator cannot
   * survive a wipe; caller must reboot afterward. */
  wipe(): Promise<void>;
  timelineQuickView(on: boolean): Promise<void>;
  /** Insert a short-lived sample timeline pin so the quick-view peek is visible.
   * Optional: only the windows-native driver implements it (native/WSL keep the
   * peek-only behavior). `pinTimeUnix` is absolute watch UTC seconds. */
  insertSamplePin?(pinTimeUnix: number, title: string): Promise<void>;
  /** Remove the sample pin inserted by insertSamplePin. Optional (see above). */
  deleteSamplePin?(): Promise<void>;
}
