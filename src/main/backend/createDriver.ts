import { access } from "node:fs/promises";
import { spawnRunner } from "./spawnRunner.js";
import { selectDriverKind, type ProbeResult, type DriverKind } from "./driverFactory.js";
import { NativeDriver } from "./NativeDriver.js";
import { WslDriver } from "./WslDriver.js";
import type { BackendDriver } from "./BackendDriver.js";

/**
 * Check whether a command is findable by the OS.
 *
 * On Linux/macOS we use `which <cmd>` (an actual executable, unlike the
 * `command` shell builtin which cannot be spawned directly).
 * On Windows we use `where <cmd>`.
 */
async function onPath(cmd: string): Promise<boolean> {
  const [probe, args] =
    process.platform === "win32"
      ? ["where", [cmd]]
      : ["which", [cmd]];
  const r = await spawnRunner(probe, args).catch(() => ({ code: 1 } as { code: number }));
  return r.code === 0;
}

/**
 * Like `onPath` but also accepts an absolute path that the user may have
 * configured via an environment variable, or checks known SDK install locations
 * as a fallback.
 *
 * For `qemu-pebble` specifically, the pebble-tool ships qemu-pebble inside its
 * SDK toolchain directory (`~/.local/share/pebble-sdk/SDKs/<ver>/toolchain/bin/`)
 * which is not on the system PATH. We probe that well-known path so that an SDK
 * install without a manual PATH entry still registers as available.
 */
async function qemuAvailable(): Promise<boolean> {
  if (await onPath("qemu-pebble")) return true;
  if (process.env.PEBBLE_QEMU_PATH) return true;

  // Probe the well-known pebble-tool SDK location used by bootEmulator.ts.
  const home = process.env.HOME ?? "";
  const sdkQemu = `${home}/.local/share/pebble-sdk/SDKs/4.9.169/toolchain/bin/qemu-pebble`;
  try {
    await access(sdkQemu);
    return true;
  } catch {
    return false;
  }
}

export async function createDriver(override?: DriverKind): Promise<{ driver: BackendDriver; kind: DriverKind }> {
  const probe: ProbeResult = {
    platform: process.platform,
    nativePebbleOnPath: await onPath("pebble"),
    nativeQemuOnPath: await qemuAvailable(),
    wslAvailable: process.platform === "win32" ? await onPath("wsl.exe") : false,
    override,
  };
  const kind = selectDriverKind(probe);
  const driver = kind === "native"
    ? new NativeDriver({ run: spawnRunner })
    : new WslDriver({ run: spawnRunner });
  return { driver, kind };
}
