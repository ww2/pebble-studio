import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, Runner, RunResult, VncEndpoint } from "./BackendDriver.js";
import { NativeDriver, type BootFn } from "./NativeDriver.js";

export interface WslDriverDeps {
  run: Runner;
  /**
   * Injectable boot function for unit tests (avoids spawning real processes).
   *
   * NOTE: The WSL-host boot path (wsl.exe booting the emulator from a Windows
   * host) is unvalidated in the current Linux/WSL dev environment — there is no
   * Windows host here. This path is exercised only when Electron runs on a real
   * Windows host with WSL2 installed. The injectable boot keeps tests hermetic.
   */
  boot?: BootFn;
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
    // Build a runner that prepends ["--", originalCmd] so every call becomes:
    //   wsl.exe -- <cmd> <args...>
    const wslRun: Runner = (cmd: string, args: string[], env?: Record<string, string>): Promise<RunResult> => {
      return deps.run("wsl.exe", ["--", cmd, ...args], env);
    };

    this.inner = new NativeDriver({ run: wslRun, boot: deps.boot });
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
}
