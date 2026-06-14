import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, Runner, VncEndpoint } from "./BackendDriver.js";
import { NativeDriver, type BootFn, type StopFn } from "./NativeDriver.js";
import type { BootToken, OnStep } from "./bootEmulator.js";
import type { PebbleCmdBuilder } from "./winBootDeps.js";
import { winPath } from "./winPath.js";
import { winSetTzOffsetArgv } from "./pebbleCli.js";
import type { WinInputChannel } from "./winInputChannel.js";
import { ensureWinTimeShim, writeWinFakeTime, type WinShimPaths } from "./winTimeShim.js";

export interface WinTimeHelper {
  /** Python interpreter that has pebble-tool's libpebble2. */
  pythonExe: string;
  /** Deployed pb-set-tz.py helper path. */
  helperPath: string;
}

export interface WindowsNativeDriverDeps {
  run: Runner;
  /** Build the bundled pebble-tool invocation (winRuntime.pebbleCmd). When set,
   * discrete `pebble` commands are rewritten to the bundled python + run_tool()
   * call with the runtime env. When absent, they spawn bare `pebble` on PATH
   * (legacy behavior). */
  pebble?: PebbleCmdBuilder;
  /** Windows boot orchestration (makeWinBootDeps-backed in production). */
  boot?: BootFn;
  /** Windows teardown orchestration. */
  stop?: StopFn;
  /** Resolved python + helper paths for the legacy utc_offset time push. When
   * absent, setTzOffset degrades to a no-op (legacy time silently unavailable),
   * mirroring how the POSIX path degrades when the tool isn't found. */
  timeHelper?: WinTimeHelper;
  /** Persistent input channel. When set, button/accelTap go through the long-lived
   * helper (a stdin write, ~0ms) instead of a per-press `pebble emu-button` spawn.
   * Falls back to the inner CLI path when the channel is unavailable (not booted,
   * helper died). Absent → always uses the CLI path (legacy behavior). */
  inputChannel?: WinInputChannel;
  /** Injected-DLL time shim (the Windows analog of the LD_PRELOAD shim). When set,
   * ensureTimeShim self-tests the bundled DLL+launcher and setFakeTime writes the
   * %TEMP% control file. Absent → ensureTimeShim=false + setFakeTime=no-op (no
   * custom time, same as before this increment). */
  timeShim?: { paths: WinShimPaths; ctlPath: string };
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
    // The inner NativeDriver builds VNC-agnostic `pebble` commands (cmd "pebble").
    // We wrap its runner so every such command is rewritten to the bundled
    // invocation (python + run_tool() + runtime env). Non-pebble commands (e.g.
    // the python time-helper argv) pass through untouched. Per-command env (e.g.
    // installCmd's PEBBLE_EMULATOR) is merged over the bundled env.
    const run: Runner = deps.pebble
      ? (cmd, args, env) => {
          if (cmd !== "pebble") return deps.run(cmd, args, env);
          const c = deps.pebble!(args);
          return deps.run(c.cmd, c.args, { ...c.env, ...env });
        }
      : deps.run;
    this.inner = new NativeDriver({ run, boot: deps.boot, stop: deps.stop });
  }

  setPlatform(id: PlatformId): void { this.inner.setPlatform(id); }

  async start(id: PlatformId, token?: BootToken, onStep?: OnStep): Promise<VncEndpoint> {
    // qemu-pebble binds to 127.0.0.1 on the Windows host; enforce localhost so
    // callers don't depend on whatever makeWinBootDeps' boot fn returns (mirrors
    // WslDriver, where WSL2 also forwards to the Windows loopback).
    const endpoint = await this.inner.start(id, token, onStep);
    return { ...endpoint, host: "localhost" };
  }

  async stop(): Promise<void> {
    // Terminate the persistent input helper alongside the emulator so it doesn't
    // linger holding a dead pypkjs connection (the next boot respawns it).
    this.deps.inputChannel?.stop();
    return this.inner.stop();
  }

  async install(pbwPath: string): Promise<void> {
    return this.inner.install(winPath(pbwPath));
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> {
    // Fast path: write one line to the persistent helper (~0ms) instead of
    // spawning a fresh `pebble emu-button` per press. The helper sends the same
    // QemuButton relay packet. Map ButtonAction → helper verb: press=click
    // (down+up), hold=hold (down only), release=release.
    const ch = this.deps.inputChannel;
    if (ch) {
      const verb = action === "release" ? "release" : action === "hold" ? `hold ${id}` : `click ${id}`;
      if (ch.send(verb)) return;
    }
    return this.inner.button(id, action);
  }

  async accelTap(): Promise<void> {
    if (this.deps.inputChannel?.send("tap x+")) return;
    return this.inner.accelTap();
  }
  async setTime(value: string, opts?: { utc?: boolean }): Promise<void> { return this.inner.setTime(value, opts); }

  async setTzOffset(offsetMin: number, tzName?: string): Promise<void> {
    const h = this.deps.timeHelper;
    if (!h) return; // legacy time unavailable until python/helper are provisioned
    const c = winSetTzOffsetArgv({ pythonExe: h.pythonExe, helperPath: h.helperPath, offsetMin, tzName });
    const r = await this.deps.run(c.cmd, c.args, c.env);
    if (r.code !== 0) console.warn(`[time] win setTzOffset(${offsetMin}) exit ${r.code}: ${r.stderr || r.stdout}`);
  }

  // Injected-DLL time shim (Windows analog of LD_PRELOAD). ensureTimeShim
  // self-tests the bundled DLL+launcher (real injection into probe.exe); when it
  // passes, the native boot routes PEBBLE_QEMU_PATH through the launcher (see
  // createDriver) so the DLL is active. setFakeTime writes the control file the
  // DLL reads — connection-free, the entire custom/freeze/rate mechanism. When no
  // timeShim dep is wired both degrade to the pre-increment no-op behavior.
  async ensureTimeShim(): Promise<boolean> {
    const ts = this.deps.timeShim;
    if (!ts) return false;
    return ensureWinTimeShim(ts.paths);
  }
  async setFakeTime(targetUnix: number | null, rate: number): Promise<void> {
    const ts = this.deps.timeShim;
    if (!ts) return; // no shim wired — legacy/no-op
    await writeWinFakeTime(ts.ctlPath, targetUnix, rate);
  }

  async timeFormat(hour24: boolean): Promise<void> { return this.inner.timeFormat(hour24); }
  async bluetooth(connected: boolean): Promise<void> { return this.inner.bluetooth(connected); }
  async battery(percent: number, charging: boolean): Promise<void> { return this.inner.battery(percent, charging); }
  // winPath canonicalizes backslash/forward-slash; outPath is already a Windows
  // path (app-constructed), so this is a no-op slash normalization kept for
  // symmetry with install.
  async screenshot(outPath: string): Promise<void> { return this.inner.screenshot(winPath(outPath)); }
  async wipe(): Promise<void> { return this.inner.wipe(); }
  async timelineQuickView(on: boolean): Promise<void> { return this.inner.timelineQuickView(on); }
}
