import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { spawnRunner } from "./spawnRunner.js";
import { selectDriverKind, type ProbeResult, type DriverKind } from "./driverFactory.js";
import { NativeDriver } from "./NativeDriver.js";
import { WslDriver } from "./WslDriver.js";
import { WindowsNativeDriver } from "./WindowsNativeDriver.js";
import { bootEmulator, stopEmulator, makeWslBootDeps } from "./bootEmulator.js";
import { makeWinBootDeps } from "./winBootDeps.js";
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
  const sdkQemu = `${home}/.local/share/pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble`;
  try {
    await access(sdkQemu);
    return true;
  } catch {
    /* fall through */
  }

  // Probe the Windows bundled SDK location (win32 only).
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const winSdkQemu = `${local}\\pebble-sdk\\SDKs\\current\\toolchain\\bin\\qemu-pebble.exe`;
    try {
      await access(winSdkQemu);
      return true;
    } catch {
      /* fall through */
    }
  }

  return false;
}

type DriverClass = typeof NativeDriver | typeof WslDriver | typeof WindowsNativeDriver;

/** Maps a driver kind to its class (used by createDriver + a construction test).
 * The `never` guard makes a new DriverKind member a compile error here. */
export function driverClassForKind(kind: DriverKind): DriverClass {
  if (kind === "native") return NativeDriver;
  if (kind === "wsl") return WslDriver;
  if (kind === "windows-native") return WindowsNativeDriver;
  const _never: never = kind;
  throw new Error(`Unknown driver kind: ${String(_never)}`);
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

  let driver: BackendDriver;
  if (kind === "windows-native") {
    // Detached spawn into a new process group (Job Object assignment is a later
    // increment — see the Phase-1 spec). windowsHide avoids a console flash.
    const detachSpawn = async (cmd: string, args: string[]): Promise<void> => {
      const child = spawn(cmd, args, { detached: true, windowsHide: true, stdio: "ignore" });
      child.unref();
      child.on("error", () => { /* readiness is checked via ports/state file */ });
    };
    const winDeps = makeWinBootDeps({ run: spawnRunner, detachSpawn });
    driver = new WindowsNativeDriver({
      run: spawnRunner,
      boot: (id, token, onStep) => bootEmulator(id, winDeps, token, onStep),
      stop: () => stopEmulator({ killAll: winDeps.killAll }),
    });
  } else if (kind === "native") {
    driver = new NativeDriver({ run: spawnRunner }); // native default boot/stop
  } else {
    driver = new WslDriver({
      run: spawnRunner,
      // On a Windows host the emulator lifecycle must run inside WSL via
      // wsl.exe, not as Node-spawned Linux binaries on the Windows host. The
      // token threads through so a force-close aborts the in-WSL boot.
      // onStep MUST be forwarded too — without it the WSL boot emits NO
      // progress notes, so the diagnostics boot log is blank on Windows (the
      // long-standing "no detailed steps on the .exe" bug, fixed v0.0.13.7).
      boot: (id, token, onStep) => bootEmulator(id, makeWslBootDeps(), token, onStep),
      stop: () => stopEmulator({ killAll: makeWslBootDeps().killAll }),
    });
  }
  return { driver, kind };
}
