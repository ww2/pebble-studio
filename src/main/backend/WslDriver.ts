import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, Runner, RunResult, VncEndpoint } from "./BackendDriver.js";
import { NativeDriver, type BootFn, type StopFn } from "./NativeDriver.js";
import type { BootToken, OnStep } from "./bootEmulator.js";
import { toWslPath } from "./wslPath.js";

export interface WslDriverDeps {
  run: Runner;
  /**
   * Injectable boot function. In production (createDriver) this routes the full
   * emulator boot through `wsl.exe -- bash -lc "... pebble emu-control --vnc"`
   * so the lifecycle runs INSIDE WSL — the only place qemu-pebble exists when
   * the Electron app runs on a Windows host. Injectable so tests stay hermetic.
   */
  boot?: BootFn;
  /** Injectable stop; in production this tears down the stack inside WSL. */
  stop?: StopFn;
}

/**
 * WslDriver — routes every pebble command through `wsl.exe -- pebble <args>`.
 *
 * Use this driver when the Electron app is running on a Windows host and the
 * Pebble emulator lives inside WSL2. WSL2 automatically forwards localhost
 * ports to the Windows host, so the VNC endpoint host stays "localhost".
 *
 * Design: we compose NativeDriver with a wsl-wrapping Runner. The wrapper
 * intercepts each (cmd, args) call and re-issues it as:
 *   wsl.exe  ["--", cmd, ...args]
 *
 * This means NativeDriver's `--vnc` injection, throw-on-nonzero logic, and all
 * discrete-action methods are reused without modification or duplication.
 */
export class WslDriver implements BackendDriver {
  private readonly inner: NativeDriver;

  constructor(private readonly deps: WslDriverDeps) {
    // Run each command inside a WSL *login* shell:
    //   wsl.exe -- bash -lc "<cmd> <args...>"
    // `pebble` lives in ~/.local/bin, which is only on the PATH of a login
    // shell — a bare `wsl.exe -- pebble ...` fails with "command not found" on
    // a Windows host. Every token is shell-quoted so paths with spaces (e.g.
    // dropped .pbw files) survive. (Env vars don't cross the Windows->WSL
    // boundary, but every command already carries --emulator explicitly, so
    // PEBBLE_EMULATOR would be redundant anyway.)
    const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const wslRun: Runner = (cmd: string, args: string[], _env?: Record<string, string>): Promise<RunResult> => {
      const cmdline = [cmd, ...args].map(shQuote).join(" ");
      return deps.run("wsl.exe", ["--", "bash", "-lc", cmdline]);
    };

    this.inner = new NativeDriver({ run: wslRun, boot: deps.boot, stop: deps.stop });
  }

  setPlatform(id: PlatformId): void {
    this.inner.setPlatform(id);
  }

  async start(id: PlatformId, token?: BootToken, onStep?: OnStep): Promise<VncEndpoint> {
    // NOTE: This boots the emulator through the injectable boot fn (or the
    // WSL-side default boot). On a real Windows+WSL2 host, the boot fn would
    // invoke `wsl.exe -- pebble emu-control ...`. WSL2 forwards the VNC port
    // to the Windows host automatically, so the endpoint host remains localhost.
    // This path is NOT exercised in the Linux/WSL dev environment. The token
    // threads through so a force-close aborts the in-WSL boot's wait loops.
    const endpoint = await this.inner.start(id, token, onStep);
    return { ...endpoint, host: "localhost" };
  }

  async stop(): Promise<void> {
    return this.inner.stop();
  }

  async install(pbwPath: string): Promise<void> {
    // Dropped/picked .pbw files arrive as Windows paths on a Windows host
    // (`C:\Users\you\app.pbw`). Translate to the WSL mount (`/mnt/c/...`) before
    // the path crosses into WSL — `pebble` inside WSL can't open a `C:\` path.
    // This also covers reinstall-on-boot, since lib:installAll / emu:install
    // both route through driver.install(). NativeDriver is left untouched (its
    // paths are already POSIX in pure-Linux dev).
    return this.inner.install(toWslPath(pbwPath));
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> {
    return this.inner.button(id, action);
  }

  async accelTap(): Promise<void> {
    return this.inner.accelTap();
  }

  async setTime(value: string, opts?: { utc?: boolean }): Promise<void> {
    return this.inner.setTime(value, opts);
  }

  async setTzOffset(offsetMin: number, tzName?: string): Promise<void> {
    return this.inner.setTzOffset(offsetMin, tzName);
  }

  async setFakeTime(targetUnix: number | null, rate: number): Promise<void> {
    return this.inner.setFakeTime(targetUnix, rate);
  }

  async ensureTimeShim(): Promise<boolean> {
    return this.inner.ensureTimeShim();
  }

  async timeFormat(hour24: boolean): Promise<void> {
    return this.inner.timeFormat(hour24);
  }

  async bluetooth(connected: boolean): Promise<void> {
    return this.inner.bluetooth(connected);
  }

  async battery(percent: number, charging: boolean): Promise<void> {
    return this.inner.battery(percent, charging);
  }

  async screenshot(outPath: string): Promise<void> {
    return this.inner.screenshot(outPath);
  }

  // No persistent pypkjs helper on the WSL path — fall back to the canvas grab.
  async screenshotFramebuffer(outPath: string): Promise<boolean> {
    return this.inner.screenshotFramebuffer(outPath);
  }

  async wipe(): Promise<void> {
    return this.inner.wipe();
  }

  async timelineQuickView(on: boolean): Promise<void> {
    return this.inner.timelineQuickView(on);
  }
}
