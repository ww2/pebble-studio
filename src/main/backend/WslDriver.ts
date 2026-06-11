import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, Runner, RunResult, VncEndpoint } from "./BackendDriver.js";
import { NativeDriver, type BootFn, type StopFn } from "./NativeDriver.js";

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

  async start(id: PlatformId): Promise<VncEndpoint> {
    // NOTE: This boots the emulator through the injectable boot fn (or the
    // WSL-side default boot). On a real Windows+WSL2 host, the boot fn would
    // invoke `wsl.exe -- pebble emu-control ...`. WSL2 forwards the VNC port
    // to the Windows host automatically, so the endpoint host remains localhost.
    // This path is NOT exercised in the Linux/WSL dev environment.
    const endpoint = await this.inner.start(id);
    return { ...endpoint, host: "localhost" };
  }

  async stop(): Promise<void> {
    return this.inner.stop();
  }

  async install(pbwPath: string): Promise<void> {
    return this.inner.install(pbwPath);
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> {
    return this.inner.button(id, action);
  }

  async accelTap(): Promise<void> {
    return this.inner.accelTap();
  }

  async setTime(value: string | "system"): Promise<void> {
    return this.inner.setTime(value);
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

  async wipe(): Promise<void> {
    return this.inner.wipe();
  }
}
