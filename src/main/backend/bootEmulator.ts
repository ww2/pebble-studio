import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { rm } from "node:fs/promises";
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
 *
 * TWO HOSTS, ONE INTERFACE (Task: WSL-aware boot):
 * Every shell operation goes through a `Shell` abstraction with two impls:
 *   - native: `bash -lc "<cmdline>"` directly (Linux/macOS host).
 *   - wsl:    `wsl.exe -- bash -lc "<cmdline>"` (Windows host driving WSL2).
 * The cmdlines are identical; only the launcher differs. WSL2 forwards
 * localhost ports to the Windows host, so readiness checks stay on localhost.
 */

const HOME = process.env.HOME ?? "";
// Use the `current` symlink rather than a hardcoded version so any active SDK
// works. On a WSL host the path is resolved INSIDE wsl via `bash -lc`, so we
// keep it as a literal POSIX path / shell expansion (~) rather than a Node path.
const SDK_ROOT = "$HOME/.local/share/pebble-sdk/SDKs/current";
const PC_BIOS = `${SDK_ROOT}/toolchain/lib/pc-bios`;
const STUB_KEYMAP = "$HOME/.pebble-qemu-data/keymaps/en-us";
const EMU_INFO_PATH = "/tmp/pb-emulator.json";
const EMU_LOG_PATH = "/tmp/pebble-emu.log";
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

/**
 * A shell abstraction: it knows how to run a POSIX command line (as it would be
 * typed at a `bash -lc` prompt), either directly (native) or via wsl.exe.
 */
export interface Shell {
  /** Run a command line to completion; capture stdout+stderr+exit code. */
  run(cmdline: string): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Launch a long-running command line and return WITHOUT waiting for it.
   * The command must survive after this call returns (nohup/setsid + bg).
   */
  spawnDetached(cmdline: string): Promise<void>;
}

/** Low-level: run argv to completion, capturing stdout + stderr. */
function execArgv(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Native shell: `bash -lc "<cmdline>"` (login shell ⇒ ~/.local/bin on PATH). */
export function makeNativeShell(): Shell {
  return {
    run: (cmdline) => execArgv("bash", ["-lc", cmdline]),
    async spawnDetached(cmdline) {
      // Wrap in setsid+nohup so the process survives this bash exiting, and
      // detach the Node child so our event loop isn't held open by it.
      const wrapped = `setsid nohup bash -lc ${shQuote(cmdline)} >${EMU_LOG_PATH} 2>&1 &`;
      const child = spawn("bash", ["-lc", wrapped], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
      child.on("error", () => { /* readiness is checked via ports */ });
    },
  };
}

/** WSL shell: `wsl.exe -- bash -lc "<cmdline>"` (same distro, login shell). */
export function makeWslShell(): Shell {
  return {
    run: (cmdline) => execArgv("wsl.exe", ["--", "bash", "-lc", cmdline]),
    async spawnDetached(cmdline) {
      // CRITICAL (Windows host): wsl.exe returns as soon as the inner bash exits.
      // To keep qemu/websockify alive after wsl.exe returns, the emulator must be
      // fully detached from that bash via `setsid nohup ... &`, with stdio
      // redirected to a file so the pipe closing doesn't kill it. We then exit 0
      // immediately so wsl.exe returns while the emulator keeps running.
      const inner = `setsid nohup bash -lc ${shQuote(cmdline)} >${EMU_LOG_PATH} 2>&1 & exit 0`;
      // We DON'T await wsl.exe's exit beyond it returning; run() resolves on close.
      await execArgv("wsl.exe", ["--", "bash", "-lc", inner]);
    },
  };
}

/** Single-quote a string for safe embedding inside a POSIX shell command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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

/**
 * Poll the emulator state file for a live qemu pid. We read the file THROUGH the
 * shell (`cat`), not Node fs, because on a real Windows host the file lives in
 * the WSL filesystem and Node (running on Windows) cannot read that POSIX path.
 */
function makeWaitForEmuInfo(shell: Shell) {
  return async function waitForEmuInfo(id: PlatformId, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { code, stdout } = await shell.run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
      if (code === 0 && stdout.trim()) {
        try {
          const json = JSON.parse(stdout) as Record<string, Record<string, { qemu?: { pid?: number } }>>;
          const versions = json[id];
          if (versions) {
            for (const v of Object.values(versions)) {
              if (v?.qemu?.pid) return;
            }
          }
        } catch {
          /* partial write; retry */
        }
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for emulator info for ${id}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
}

function makeEnsureKeymap(shell: Shell) {
  return async function ensureKeymap(): Promise<void> {
    // -p / -n keep this idempotent. Done in one shell so $HOME expands in-distro.
    await shell.run(
      `mkdir -p "${PC_BIOS}/keymaps" && ` +
      `cp -n "${STUB_KEYMAP}" "${PC_BIOS}/keymaps/en-us" 2>/dev/null; ` +
      `cp -n "${STUB_KEYMAP}" "${PC_BIOS}/en-us" 2>/dev/null; true`,
    );
  };
}

function makeBootControl(shell: Shell) {
  return async function bootControl(id: PlatformId): Promise<void> {
    // emu-control --vnc owns the whole stack and stays alive. We detach it so it
    // survives the launching shell returning (critical on the WSL host path).
    await shell.spawnDetached(`pebble emu-control --emulator ${id} --vnc`);
  };
}

function makeKillAll(shell: Shell) {
  // CRITICAL — SELF-MATCH HAZARD: this sweep runs inside `bash -lc "<cmdline>"`,
  // so the controlling shell's OWN argv literally CONTAINS these patterns. A naive
  // `pkill -9 -f qemu-pebble` therefore matches (and kills) the very shell running
  // it, before it reaches the real emulator. Two defenses:
  //   * qemu — match the EXACT process name with `pkill -x qemu-pebble` (the shell's
  //     comm is `bash`, not `qemu-pebble`, so no self-match).
  //   * websockify / emu-control / pypkjs run as `python …`, so we must use `-f`;
  //     we wrap the first letter in a `[c]haracter class`. `[w]ebsockify` matches
  //     the string "websockify" in the TARGET's argv, but our own cmdline contains
  //     the literal "[w]ebsockify", which does NOT match — the classic grep/pkill
  //     self-exclusion trick.
  //
  // ORDER MATTERS: the `emu-control --vnc` session SUPERVISES qemu and respawns it
  // if killed alone, so we kill the supervisor FIRST, then qemu/websockify/pypkjs,
  // then `pebble kill` for any state-file pids. We sweep TWICE (with a short settle)
  // to catch anything that respawned in the race window, then delete the state file.
  const sweep =
    `pkill -9 -f '[e]mu-control' 2>/dev/null; ` +
    `pkill -9 -x qemu-pebble 2>/dev/null; ` +
    `pkill -9 -f '[w]ebsockify' 2>/dev/null; ` +
    `pkill -9 -f '[m] pypkjs' 2>/dev/null; ` +
    `pebble kill 2>/dev/null; true`;
  return async function killAll(): Promise<void> {
    await shell.run(`${sweep}; sleep 0.4; ${sweep}; rm -f ${EMU_INFO_PATH} 2>/dev/null; true`);
    // Give the OS a beat to release the VNC display + ports.
    await new Promise((r) => setTimeout(r, 800));
  };
}

/** Build the SpawnDeps for a given shell (native or wsl). */
function makeBootDeps(shell: Shell): SpawnDeps {
  return {
    bootControl: makeBootControl(shell),
    ensureKeymap: makeEnsureKeymap(shell),
    waitForPort: defaultWaitForPort,
    waitForEmuInfo: makeWaitForEmuInfo(shell),
    killAll: makeKillAll(shell),
  };
}

/** SpawnDeps wired to run everything in the native (current-host) shell. */
export function makeNativeBootDeps(): SpawnDeps {
  return makeBootDeps(makeNativeShell());
}

/** SpawnDeps wired to run everything inside WSL via wsl.exe. */
export function makeWslBootDeps(): SpawnDeps {
  return makeBootDeps(makeWslShell());
}

const defaultDeps: SpawnDeps = makeNativeBootDeps();

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
  const killAll = deps.killAll ?? defaultDeps.killAll;
  await killAll();
}
