import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, Runner, VncEndpoint } from "./BackendDriver.js";
import { NativeDriver, type BootFn, type StopFn } from "./NativeDriver.js";
import type { BootToken, OnStep } from "./bootEmulator.js";
import { winPath } from "./winPath.js";
import { winSetTzOffsetArgv } from "./pebbleCli.js";

export interface WinTimeHelper {
  /** Python interpreter that has pebble-tool's libpebble2. */
  pythonExe: string;
  /** Deployed pb-set-tz.py helper path. */
  helperPath: string;
}

export interface WindowsNativeDriverDeps {
  run: Runner;
  /** Windows boot orchestration (makeWinBootDeps-backed in production). */
  boot?: BootFn;
  /** Windows teardown orchestration. */
  stop?: StopFn;
  /** Resolved python + helper paths for the legacy utc_offset time push. When
   * absent, setTzOffset degrades to a no-op (legacy time silently unavailable),
   * mirroring how the POSIX path degrades when the tool isn't found. */
  timeHelper?: WinTimeHelper;
}

/**
 * WindowsNativeDriver — drives qemu-pebble natively on Windows (no WSL, no bash).
 *
 * Composes an inner NativeDriver with a PLAIN runner: discrete `pebble` commands
 * spawn `pebble.exe` directly (argv, shell:false; Node resolves the `.exe` via
 * PATHEXT). The boot/stop orchestration is injected (Windows tasklist/taskkill +
 * Node fs + net.connect; see winBootDeps). Methods that depend on POSIX-only
 * mechanics are overridden:
 *   - install: winPath() normalization (no /mnt translation).
 *   - ensureTimeShim: false (LD_PRELOAD doesn't exist on Windows; the DLL shim is
 *     a later increment) → timeController uses the legacy utc_offset path.
 *   - setFakeTime: no-op (no shim) — legacy time is driven by setTzOffset.
 *   - setTzOffset: shell-free python-helper argv (best-effort, never throws).
 */
export class WindowsNativeDriver implements BackendDriver {
  private readonly inner: NativeDriver;

  constructor(private readonly deps: WindowsNativeDriverDeps) {
    this.inner = new NativeDriver({ run: deps.run, boot: deps.boot, stop: deps.stop });
  }

  setPlatform(id: PlatformId): void { this.inner.setPlatform(id); }

  async start(id: PlatformId, token?: BootToken, onStep?: OnStep): Promise<VncEndpoint> {
    return this.inner.start(id, token, onStep);
  }

  async stop(): Promise<void> { return this.inner.stop(); }

  async install(pbwPath: string): Promise<void> {
    return this.inner.install(winPath(pbwPath));
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> { return this.inner.button(id, action); }
  async accelTap(): Promise<void> { return this.inner.accelTap(); }
  async setTime(value: string, opts?: { utc?: boolean }): Promise<void> { return this.inner.setTime(value, opts); }

  async setTzOffset(offsetMin: number, tzName?: string): Promise<void> {
    const h = this.deps.timeHelper;
    if (!h) return; // legacy time unavailable until python/helper are provisioned
    const c = winSetTzOffsetArgv({ pythonExe: h.pythonExe, helperPath: h.helperPath, offsetMin, tzName });
    const r = await this.deps.run(c.cmd, c.args, c.env);
    if (r.code !== 0) console.warn(`[time] win setTzOffset(${offsetMin}) exit ${r.code}: ${r.stderr || r.stdout}`);
  }

  // No LD_PRELOAD shim on Windows: report unavailable so timeController uses the
  // legacy utc_offset path, and make the control-file write a no-op.
  async ensureTimeShim(): Promise<boolean> { return false; }
  async setFakeTime(_targetUnix: number | null, _rate: number): Promise<void> { /* no shim yet */ }

  async timeFormat(hour24: boolean): Promise<void> { return this.inner.timeFormat(hour24); }
  async bluetooth(connected: boolean): Promise<void> { return this.inner.bluetooth(connected); }
  async battery(percent: number, charging: boolean): Promise<void> { return this.inner.battery(percent, charging); }
  async screenshot(outPath: string): Promise<void> { return this.inner.screenshot(winPath(outPath)); }
  async wipe(): Promise<void> { return this.inner.wipe(); }
  async timelineQuickView(on: boolean): Promise<void> { return this.inner.timelineQuickView(on); }
}
