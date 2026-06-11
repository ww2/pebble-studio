import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { readFile, rm } from "node:fs/promises";
import type { PlatformId } from "../../shared/types.js";
import type { VncEndpoint } from "./BackendDriver.js";

/**
 * Real-boot orchestration for the qemu-pebble emulator (Task 1.5).
 *
 * APPROACH 1 (empirically verified to work): we let the `pebble` tool own the
 * whole emulator stack (qemu + pypkjs + websockify) via
 *   `pebble emu-control --emulator <platform> --vnc`
 *
 * The pebble-tool spawns:
 *   - qemu-pebble with `-vnc :1` (raw RFB on localhost:5901)
 *   - pypkjs (phone-sim websocket bridge)
 *   - websockify --heartbeat=30 6080 localhost:5901  (ws://localhost:6080/)
 * and records pids/ports in /tmp/pb-emulator.json.
 *
 * Because the tool reuses the running qemu/pypkjs (by pid, from that json file)
 * for subsequent discrete commands (`pebble install`, `pebble emu-button ...`),
 * those commands hit the SAME running emulator and do NOT tear down the VNC.
 *
 * The one obstacle the spike found: the tool's VNC boot passes
 *   `-L <sdk-root>/toolchain/lib/pc-bios`
 * for the qemu keymap, but that dir has no `en-us` keymap, so qemu aborts.
 * We pre-seed that keymap (idempotent) before booting.
 */

const HOME = process.env.HOME ?? "";
const SDK_ROOT = `${HOME}/.local/share/pebble-sdk/SDKs/4.9.169`;
const PC_BIOS = `${SDK_ROOT}/toolchain/lib/pc-bios`;
const STUB_KEYMAP = `${HOME}/.pebble-qemu-data/keymaps/en-us`;
const EMU_INFO_PATH = "/tmp/pb-emulator.json";
const VNC_RFB_PORT = 5901;
const WS_PORT = 6080;

export interface SpawnDeps {
  /** Spawn `pebble emu-control --emulator <id> --vnc` detached; resolve once launched. */
  bootControl: (id: PlatformId) => Promise<void>;
  /** Ensure the qemu keymap exists at the pc-bios path the tool's VNC boot uses. */
  ensureKeymap: () => Promise<void>;
  /** Resolve once a TCP connection to host:port succeeds (or reject on timeout). */
  waitForPort: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** Resolve once /tmp/pb-emulator.json contains a live entry for the platform. */
  waitForEmuInfo: (id: PlatformId, timeoutMs: number) => Promise<void>;
  /** Stop any prior emulator + websockify so we boot a clean stack. */
  killAll: () => Promise<void>;
}

const sh = (cmd: string, args: string[], env?: Record<string, string>) =>
  new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 127, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stderr }));
  });

function defaultWaitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = netConnect({ host, port });
      sock.setTimeout(1000);
      const fail = () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`timeout waiting for ${host}:${port}`));
        else setTimeout(attempt, 300);
      };
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", fail);
      sock.once("timeout", fail);
    };
    attempt();
  });
}

async function defaultWaitForEmuInfo(id: PlatformId, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(EMU_INFO_PATH, "utf8");
      const json = JSON.parse(raw) as Record<string, Record<string, { qemu?: { pid?: number } }>>;
      const versions = json[id];
      if (versions) {
        for (const v of Object.values(versions)) {
          if (v?.qemu?.pid) return;
        }
      }
    } catch {
      /* file not written yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for emulator info for ${id}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function defaultEnsureKeymap(): Promise<void> {
  await sh("mkdir", ["-p", `${PC_BIOS}/keymaps`]);
  await sh("cp", ["-n", STUB_KEYMAP, `${PC_BIOS}/keymaps/en-us`]);
  await sh("cp", ["-n", STUB_KEYMAP, `${PC_BIOS}/en-us`]);
}

async function defaultBootControl(id: PlatformId): Promise<void> {
  // Detach: emu-control --vnc stays alive (opens a sensor/control session).
  // We don't await its exit; we just kick it off and rely on /tmp/pb-emulator.json + ports.
  const child = spawn("pebble", ["emu-control", "--emulator", id, "--vnc"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  child.on("error", () => { /* swallow; readiness is checked via ports */ });
}

async function defaultKillAll(): Promise<void> {
  // `pebble kill` SIGKILLs the qemu/pypkjs pids recorded in the state file, but it
  // leaves the detached `emu-control --vnc` session process AND websockify alive,
  // and a SIGKILL'd qemu can linger as a zombie whose pid still "exists" — which
  // would make a fresh boot think qemu is already running. So we also pkill the
  // session + websockify + pypkjs by pattern, and delete the stale state file so
  // the next boot starts from a clean slate.
  await sh("pebble", ["kill"]);
  await sh("pkill", ["-9", "-f", "emu-control"]);
  await sh("pkill", ["-9", "-f", "qemu-pebble"]);
  await sh("pkill", ["-9", "-f", "websockify"]);
  await sh("pkill", ["-9", "-f", "m pypkjs"]);
  try { await rm(EMU_INFO_PATH, { force: true }); } catch { /* ignore */ }
  // Give the OS a beat to release the VNC display + ports.
  await new Promise((r) => setTimeout(r, 800));
}

const defaultDeps: SpawnDeps = {
  bootControl: defaultBootControl,
  ensureKeymap: defaultEnsureKeymap,
  waitForPort: defaultWaitForPort,
  waitForEmuInfo: defaultWaitForEmuInfo,
  killAll: defaultKillAll,
};

export async function bootEmulator(
  platformId: PlatformId,
  deps: Partial<SpawnDeps> = {},
): Promise<VncEndpoint> {
  const d: SpawnDeps = { ...defaultDeps, ...deps };

  // 1. Tear down any prior emulator so we own a clean stack.
  await d.killAll();
  // 2. Make the tool's VNC keymap path valid.
  await d.ensureKeymap();
  // 3. Boot the full stack (qemu + pypkjs + websockify) under the pebble tool.
  await d.bootControl(platformId);
  // 4. Wait for readiness: state file, raw RFB, and the websocket proxy.
  await d.waitForEmuInfo(platformId, 60_000);
  await d.waitForPort("localhost", VNC_RFB_PORT, 60_000);
  await d.waitForPort("localhost", WS_PORT, 60_000);

  return { host: "localhost", port: WS_PORT, wsPath: "/" };
}

export async function stopEmulator(deps: Partial<Pick<SpawnDeps, "killAll">> = {}): Promise<void> {
  const killAll = deps.killAll ?? defaultKillAll;
  await killAll();
}
