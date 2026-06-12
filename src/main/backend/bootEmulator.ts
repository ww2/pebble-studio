import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import type { PlatformId } from "../../shared/types.js";
import type { VncEndpoint } from "./BackendDriver.js";
import { EMU_INFO_PATH, EMU_LOG_PATH, SDK_ROOT } from "./hostPaths.js";
// isShimReady() reads the module-level readiness cache populated by
// ensureTimeShim() (driver.ensureTimeShim(), called from ipc before each boot).
// bootEmulator never deploys the shim itself; it only reads the result to
// decide whether to route qemu through the wrapper.
import { isShimReady, WRAPPER } from "./timeShim.js";

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

// SDK_ROOT (imported from hostPaths) uses the `current` symlink rather than a
// hardcoded version so any active SDK works. On a WSL host the path is resolved
// INSIDE wsl via `bash -lc`, so it stays a literal POSIX path / shell expansion
// rather than a Node path. PC_BIOS / STUB_KEYMAP stay derived here — they are
// boot-keymap details, not host-path policy.
const PC_BIOS = `${SDK_ROOT}/toolchain/lib/pc-bios`;
const STUB_KEYMAP = "$HOME/.pebble-qemu-data/keymaps/en-us";
const VNC_RFB_PORT = 5901;
const WS_PORT = 6080;

/**
 * Cancellation token for an in-flight boot. The orchestrator and the poll
 * helpers check `cancelled` between retries; flipping it true makes an active
 * wait loop abort (throw `BootAborted`) within ~300ms instead of blocking up to
 * the full readiness timeout (60s). IPC owns the token and flips it on
 * abort/stop.
 */
export interface BootToken {
  cancelled: boolean;
}

/** Thrown by `bootEmulator` (and its wait loops) when the token is cancelled. */
export class BootAborted extends Error {
  constructor(message = "boot aborted") {
    super(message);
    this.name = "BootAborted";
  }
}

export interface SpawnDeps {
  /** Spawn `pebble emu-control --emulator <id> --vnc` detached; resolve once launched. */
  bootControl: (id: PlatformId) => Promise<void>;
  /** Ensure the qemu keymap exists at the pc-bios path the tool's VNC boot uses. */
  ensureKeymap: () => Promise<void>;
  /** Resolve once a TCP connection to host:port succeeds (or reject on timeout).
   * Honors the optional cancellation token: a cancelled token aborts an active
   * retry loop promptly with `BootAborted`. */
  waitForPort: (host: string, port: number, timeoutMs: number, token?: BootToken) => Promise<void>;
  /** Resolve once /tmp/pb-emulator.json contains a live entry for the platform.
   * Honors the optional cancellation token (aborts active polling promptly). */
  waitForEmuInfo: (id: PlatformId, timeoutMs: number, token?: BootToken) => Promise<void>;
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

function defaultWaitForPort(host: string, port: number, timeoutMs: number, token?: BootToken): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // Bail before opening a fresh socket if the boot was cancelled.
      if (token?.cancelled) { reject(new BootAborted()); return; }
      const sock = netConnect({ host, port });
      sock.setTimeout(1000);
      const fail = () => {
        sock.destroy();
        if (token?.cancelled) reject(new BootAborted());
        else if (Date.now() > deadline) reject(new Error(`timeout waiting for ${host}:${port}`));
        // Re-check the token between retries so cancellation interrupts the loop
        // within one poll interval (~300ms) rather than at the full timeout.
        else setTimeout(() => {
          if (token?.cancelled) reject(new BootAborted());
          else attempt();
        }, 300);
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
  return async function waitForEmuInfo(id: PlatformId, timeoutMs: number, token?: BootToken): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token?.cancelled) throw new BootAborted();
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
      // Re-check the token after the poll delay so an in-flight cancel aborts the
      // loop within ~300ms rather than waiting out the full timeout.
      await new Promise((r) => setTimeout(r, 300));
      if (token?.cancelled) throw new BootAborted();
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
    //
    // When the time shim deployed OK, route qemu through the wrapper via
    // pebble-tool's first-class PEBBLE_QEMU_PATH hook (emulator.py:279). The
    // env assignment is part of the (quote-free) cmdline so it crosses the
    // WSL boundary inside the same single shQuote layer as the rest.
    const prefix = isShimReady() ? `PEBBLE_QEMU_PATH=${WRAPPER} ` : "";
    await shell.spawnDetached(`${prefix}pebble emu-control --emulator ${id} --vnc`);
  };
}

/**
 * Probe whether RFB port 5901 is FREE (refusing connections). Resolves true if
 * the port is free (connection refused/errored/timed out), false if something is
 * still accepting connections there. Ports are localhost-forwarded on both hosts
 * (WSL2 mirrors localhost to Windows), so a native net.connect to 127.0.0.1 is
 * host-agnostic for this free-or-not check.
 */
function defaultPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    sock.setTimeout(1000);
    const free = () => { sock.destroy(); resolve(true); };
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("error", free);
    sock.once("timeout", free);
  });
}

/** Injectable deps for `waitUntilDead` so it's testable without real procs/sockets. */
export interface WaitUntilDeadDeps {
  /** Probe a TCP port; resolve true iff it is FREE (refusing connections). */
  portFree?: (host: string, port: number) => Promise<boolean>;
  /** Override the inter-poll delay (ms) — tests set this to 0 for speed. */
  pollIntervalMs?: number;
}

/**
 * Block until the prior emulator stack is TRULY gone, or the timeout elapses.
 *
 * ROOT CAUSE THIS GUARDS (the "watchface hang"): `killAll` SIGKILLs qemu and then
 * waits a FIXED 800ms with NO verification. SIGKILL is async — the kernel may not
 * have reaped qemu (and released VNC display :1 / RFB port 5901) within 800ms.
 * A same-model relaunch then races the lingering stack: the fresh
 * `emu-control --vnc` collides with the still-bound display/port and the watch
 * never paints. Booting a DIFFERENT model takes longer (and starts a different
 * machine), which accidentally gives the stale stack time to fully release —
 * exactly the "helpfulness" the user observed. This makes that settling
 * DETERMINISTIC: poll until ALL of (a) no `qemu-pebble` process remains,
 * (b) RFB port 5901 is free, AND (c) websockify's ws port 6080 is free,
 * before letting a new boot proceed.
 *
 * `pgrep -x qemu-pebble` matches the EXACT process NAME; the polling shell's comm
 * is `bash`/`pgrep`, never `qemu-pebble`, so there is no self-match (unlike the
 * `-f` patterns killAll must guard with character classes).
 *
 * If the timeout elapses we resolve anyway (never hang the app); after a SIGKILL
 * it normally resolves within a poll or two.
 */
export async function waitUntilDead(
  shell: Shell,
  timeoutMs = 5000,
  deps: WaitUntilDeadDeps = {},
): Promise<void> {
  const portFree = deps.portFree ?? defaultPortFree;
  const pollIntervalMs = deps.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // (a) No qemu-pebble process: pgrep exits non-zero (and prints nothing) when
    // there is no match.
    const { code, stdout } = await shell.run("pgrep -x qemu-pebble");
    const qemuGone = code !== 0 && stdout.trim() === "";
    // (b) RFB port released.
    const rfbFree = qemuGone ? await portFree("127.0.0.1", VNC_RFB_PORT) : false;
    // (c) websockify released the websocket port too — a relaunch's websockify
    // would otherwise collide with the lingering 6080 listener.
    const wsFree = rfbFree ? await portFree("127.0.0.1", WS_PORT) : false;
    if (qemuGone && rfbFree && wsFree) return;
    if (Date.now() >= deadline) return; // give up gracefully; never hang the app
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
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
    // Give the OS a beat to release the VNC display + ports…
    await new Promise((r) => setTimeout(r, 800));
    // …then VERIFY the stack is actually gone before returning. SIGKILL is async,
    // so the fixed settle above is NOT a guarantee; without this gate a same-model
    // relaunch races a not-yet-reaped qemu / still-bound RFB port 5901 and the
    // watchface hangs. waitUntilDead makes teardown deterministic (the same
    // settling a slower different-model boot accidentally provided).
    await waitUntilDead(shell);
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

/**
 * Optional progress callback. `bootEmulator` calls it with a short human label
 * before each major step ("Killing stale emulator…", …, "Ready") so the renderer
 * can surface verbose boot notes in diagnostic mode. Always optional; omitting it
 * leaves the boot unchanged.
 */
export type OnStep = (msg: string) => void;

export async function bootEmulator(
  platformId: PlatformId,
  deps: Partial<SpawnDeps> = {},
  token?: BootToken,
  onStep?: OnStep,
): Promise<VncEndpoint> {
  const d: SpawnDeps = { ...defaultDeps, ...deps };
  // Best-effort step notifier; never let a bad callback break the boot.
  const step = (msg: string): void => { try { onStep?.(msg); } catch { /* ignore */ } };

  // Throw promptly if cancellation already happened (e.g. force-close fired
  // before/right after start). Each wait step below also rechecks the token.
  if (token?.cancelled) throw new BootAborted();
  // 1. Tear down any prior emulator so we own a clean stack.
  step("Killing stale emulator…");
  await d.killAll();
  // 2. Make the tool's VNC keymap path valid.
  step("Preparing keymap…");
  await d.ensureKeymap();
  // 3+4. Boot the full stack (qemu + pypkjs + websockify) under the pebble tool,
  // then wait for readiness: state file, raw RFB, and the websocket proxy. The
  // token threads into each wait so a cancel interrupts the active loop.
  const attempt = async (): Promise<VncEndpoint> => {
    step("Launching qemu…");
    await d.bootControl(platformId);
    step("Waiting for emulator state…");
    await d.waitForEmuInfo(platformId, 60_000, token);
    step("Waiting for VNC…");
    await d.waitForPort("localhost", VNC_RFB_PORT, 60_000, token);
    // websockify binds only after qemu's VNC is up, so it's often the slower
    // wait — give it its own label so diagnostics show the real bottleneck.
    step("Waiting for websockify…");
    await d.waitForPort("localhost", WS_PORT, 60_000, token);
    return { host: "localhost", port: WS_PORT, wsPath: "/" };
  };
  try {
    const ep = await attempt();
    step("Ready");
    return ep;
  } catch (err) {
    // Known flakiness: the managed boot intermittently hangs waiting for the
    // emulator state (a connect-after-marker race in pebble-tool). A clean kill
    // + ONE retry recovers it. Cancellation is never retried.
    if (err instanceof BootAborted || token?.cancelled) throw err;
    step("Boot stalled — retrying once…");
    // The production killAll (makeKillAll) ends with waitUntilDead, so the
    // retry's bootControl never races a not-yet-released qemu/port. Tests stub
    // killAll, so they exercise the retry FLOW, not that teardown gate.
    await d.killAll();
    const ep = await attempt(); // second failure propagates
    step("Ready");
    return ep;
  }
}

export async function stopEmulator(deps: Partial<Pick<SpawnDeps, "killAll">> = {}): Promise<void> {
  const killAll = deps.killAll ?? defaultDeps.killAll;
  await killAll();
}
