import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, Runner, RunResult, VncEndpoint } from "./BackendDriver.js";
import type { PebbleCommand } from "./pebbleCli.js";
import * as cli from "./pebbleCli.js";
import { bootEmulator, stopEmulator } from "./bootEmulator.js";

export type BootFn = (id: PlatformId) => Promise<VncEndpoint>;

export interface NativeDriverDeps {
  run: Runner;
  /** Real boot orchestration; injectable so unit tests never spawn processes. */
  boot?: BootFn;
}

export class NativeDriver implements BackendDriver {
  constructor(private readonly deps: NativeDriverDeps) {}

  setPlatform(id: PlatformId): void {
    cli.setActivePlatform(id);
  }

  async start(id: PlatformId): Promise<VncEndpoint> {
    this.setPlatform(id);
    return (this.deps.boot ?? bootEmulator)(id);
  }

  async stop(): Promise<void> {
    await stopEmulator();
  }

  async install(pbwPath: string): Promise<void> {
    await this.exec(cli.installCmd(pbwPath));
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> {
    await this.exec(cli.buttonCmd(id, action));
  }

  async accelTap(): Promise<void> {
    await this.exec(cli.accelTapCmd());
  }

  async setTime(value: string | "system"): Promise<void> {
    // emu-set-time wants HH:MM:SS (today, local) or unix seconds — never ISO 8601.
    const time = value === "system" ? new Date().toTimeString().slice(0, 8) : value;
    await this.exec(cli.setTimeCmd(time));
  }

  async bluetooth(connected: boolean): Promise<void> {
    await this.exec(cli.btCmd(connected));
  }

  async battery(percent: number, charging: boolean): Promise<void> {
    await this.exec(cli.batteryCmd(percent, charging));
  }

  async screenshot(outPath: string): Promise<void> {
    await this.exec(cli.screenshotCmd(outPath));
  }

  private async exec(c: PebbleCommand): Promise<RunResult> {
    const args = withVnc(c.args);
    const result = await this.deps.run(c.cmd, args, c.env);
    if (result.code !== 0) {
      throw new Error(
        `pebble ${args.join(" ")} failed (code ${result.code}): ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }
}

/**
 * Inject `--vnc` into any `--emulator`-targeted pebble command.
 *
 * EMPIRICAL FINDING (Task 1.5): the emulator was booted with VNC enabled
 * (`emu-control --vnc`). A discrete command like `pebble emu-button --emulator
 * basalt click up` issued WITHOUT `--vnc` returns exit 0 but the pebble tool
 * sees a VNC-state mismatch, SIGKILLs the running VNC qemu, and spawns a fresh
 * non-VNC emulator — tearing down ws://localhost:6080 and RFB :5901. Passing
 * `--vnc` makes the tool reuse the running VNC emulator (qemu pid unchanged,
 * VNC survives). The pure pebbleCli builders stay VNC-agnostic; the VNC concern
 * lives here in the driver that owns the booted VNC stack.
 */
function withVnc(args: string[]): string[] {
  if (!args.includes("--emulator") || args.includes("--vnc")) return args;
  // Insert right after the `--emulator <platform>` pair so flag ordering is sane.
  const i = args.indexOf("--emulator");
  const out = args.slice();
  out.splice(i + 2, 0, "--vnc");
  return out;
}
