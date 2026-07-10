import type { PlatformId } from "../../shared/types.js";
import type { BootToken, SpawnDeps, BootProbe } from "./bootEmulator.js";
import { BootAborted } from "./bootEmulator.js";
import { winHostPaths } from "./hostPaths.js";
import { tasklistArgs, tasklistPidArgs, parseTasklistPids, parseTasklistImage, parseStatePids } from "./winProc.js";
import { VNC_RFB_PORT, WS_PORT } from "./ports.js";
import { connect as netConnect } from "node:net";
import { spawn } from "node:child_process";
import { readFile as fsReadFile, rm as fsRm, stat as fsStat } from "node:fs/promises";
import type { PebbleCommand } from "./pebbleCli.js";
/** Max wait for a `tasklist` enumeration before we give up on it. tasklist can
 * HANG indefinitely (Windows process enumeration wedges just like `taskkill /T`
 * under load / a bad process state); an unbounded wait here would freeze the
 * startup reap and `backend:init`. On timeout we report "no pids" (degraded) —
 * the state-file pids are still killed directly. */
const TASKLIST_TIMEOUT_MS = 1500;

/** Injectable spawn (tests pass a fake child). */
interface ChildLike {
  stdout: { on(ev: "data", cb: (d: Buffer) => void): void } | null;
  on(ev: "close", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (e: Error) => void): void;
  kill(): void;
}
export interface TasklistDeps {
  spawn?: (cmd: string, args: string[]) => ChildLike;
  timeoutMs?: number;
}

/**
 * Run one `tasklist` query to completion and resolve its raw stdout, BOUNDED by a
 * timeout so a hung tasklist can never wedge the caller. On timeout the child is
 * killed best-effort and "" is returned. Pure-ish (spawn + timeout injectable).
 */
function tasklistStdout(args: string[], deps: TasklistDeps = {}): Promise<string> {
  const doSpawn = deps.spawn ?? ((c, a) => spawn(c, a, { windowsHide: true }) as unknown as ChildLike);
  const timeoutMs = deps.timeoutMs ?? TASKLIST_TIMEOUT_MS;
  return new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const child = doSpawn("tasklist", args);
    const finish = (s: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(""); }, timeoutMs);
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.on("error", () => finish(""));
    child.on("close", () => finish(out));
  });
}

/**
 * Enumerate the pids of a running image via `tasklist`, BOUNDED by a timeout so a
 * hung tasklist can never wedge the caller. On timeout the child is killed
 * best-effort and [] is returned. Pure-ish (spawn + timeout injectable for tests).
 */
export async function tasklistPids(image: string, deps: TasklistDeps = {}): Promise<number[]> {
  return parseTasklistPids(await tasklistStdout(tasklistArgs(image), deps));
}

/**
 * Resolve ONE pid's image name via `tasklist /FI "PID eq <pid>"`, BOUNDED like
 * tasklistPids. Returns "" if the pid no longer exists or tasklist hangs/errors.
 * Used to VERIFY a state-file pid is one of ours before force-killing it.
 */
export async function tasklistImage(pid: number, deps: TasklistDeps = {}): Promise<string> {
  return parseTasklistImage(await tasklistStdout(tasklistPidArgs(pid), deps));
}
/** Max wait for the graceful `pebble kill` (bundled-interpreter spawn) before we
 * stop awaiting it and move on to the direct force-kill. Keeps a hung interpreter
 * from wedging teardown on "stopping…". */
const PEBBLE_KILL_TIMEOUT_MS = 2000;
/** Max time the kill settle/retry loop polls for the ports to free. */
const KILL_SETTLE_TIMEOUT_MS = 5000;

/**
 * Resolve `p`, or reject after `ms`. Used to BOUND a best-effort step (the
 * graceful `pebble kill`): we stop awaiting on timeout, but the underlying child
 * keeps running harmlessly — the direct kill sweep that follows reaps it anyway.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Argv runner (shell:false). Injected so tests don't spawn real processes. */
export type WinRunner = (cmd: string, args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Builds the bundled pebble-tool invocation for a given pebble argv (see
 * winRuntime.pebbleCmd: cmd=bundled python, args prefixed with run_tool(), env
 * carrying PEBBLE_QEMU_PATH + XDG_DATA_HOME). Injected by createDriver; the
 * default below is bare `pebble` on PATH for non-bundled/legacy use.
 */
export type PebbleCmdBuilder = (args: string[]) => PebbleCommand;

export interface WinBootDepsImpl {
  run: WinRunner;
  /** Read a file as utf8; resolves "" if missing. Injected for tests. */
  readFile?: (path: string) => Promise<string>;
  /** Remove a file (ignore-missing). Injected for tests. */
  rm?: (path: string) => Promise<void>;
  /** Launch a long-running detached process (Job Object assignment lives here in
   * production). The `env` (merged over process.env by the spawner) carries the
   * bundled-pebble runtime env. Resolves once launched. Injected for tests. */
  detachSpawn?: (cmd: string, args: string[], env?: Record<string, string>) => Promise<void>;
  /** Build the bundled pebble-tool invocation. Defaults to bare `pebble` on PATH. */
  pebble?: PebbleCmdBuilder;
  /** Override host paths (tests). Defaults to winHostPaths(). */
  paths?: { emuInfo: string; emuLog: string; sdkRoot: string };
  /**
   * Probe whether a TCP port is open; resolve true if open.
   * Injected for tests so the killAll settle loop doesn't touch real sockets.
   * Defaults to portOpen() which uses net.connect with a 1s timeout.
   */
  portOpen?: (host: string, port: number) => Promise<boolean>;
  /**
   * Force-kill ONE pid via a DIRECT TerminateProcess (Node `process.kill`), with
   * NO child-tree walk. This is the core orphan fix: `taskkill /T` builds the full
   * descendant tree before killing, and that enumeration times out (then silently
   * fails) when the box is loaded by a CPU-pegged qemu — so the stack survives
   * every kill. A direct TerminateProcess is immune (Stop-Process killed the same
   * wedged orphans in ~10ms where `taskkill /T /F` timed out). Injected for tests
   * so they never signal a real pid. Default swallows "already gone"/no-perms.
   */
  killPid?: (pid: number) => Promise<void>;
  /**
   * Enumerate the pids of a running image (via `tasklist /FO CSV /NH` + parse).
   * Used to find OUR emulator processes (qemu-pebble.exe / PebbleStudioEmu.exe)
   * for the direct kill above, independent of a possibly-stale state file.
   * Injected for tests. Default runs tasklist through `run`.
   */
  pidsByImage?: (image: string) => Promise<number[]>;
  /**
   * Resolve a pid's image name (bounded tasklist by PID). Used to VERIFY a
   * state-file pid is one of OUR images before force-killing it: %TEMP%\
   * pb-emulator.json survives crashes AND reboots, and Windows recycles pids
   * aggressively, so a stale entry can name an unrelated same-user process — which
   * we must NOT TerminateProcess. Injected for tests. Default = bounded tasklist.
   */
  imageOfPid?: (pid: number) => Promise<string>;
  /**
   * Last-modified time (ms since epoch) of a file, or 0 if missing/unreadable.
   * Used to decide whether the emu-control boot log is stale (older than the
   * current boot) so readBootLog can't mine an error from a prior run. Injected
   * for tests. Default = fs.stat (best-effort; never throws).
   */
  statMtimeMs?: (path: string) => Promise<number>;
}

/**
 * OUR emulator image names, in TEARDOWN ORDER. The PebbleStudioEmu.exe supervisor
 * (emu-control) RESPAWNS qemu if qemu dies alone, so it must go first; qemu second.
 * Both names are uniquely ours, so an image-wide kill is safe (it never touches a
 * user's own python.exe — the reason we must NOT kill by the generic interpreter).
 */
const EMU_IMAGES = ["PebbleStudioEmu.exe", "qemu-pebble.exe"] as const;

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    s.setTimeout(1000);
    const no = () => { s.destroy(); resolve(false); };
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", no);
    s.once("timeout", no);
  });
}

/** Probes for {@link anythingAlive} — the SAME injectable probes killAll/reap use. */
export interface AliveProbeDeps {
  /** Read the emulator state file as utf8 ("" if missing). */
  readState: () => Promise<string>;
  /** Enumerate the pids of one of OUR images (bounded tasklist). */
  pidsByImage: (image: string) => Promise<number[]>;
  /** Probe whether a TCP port is open. */
  portOpen: (host: string, port: number) => Promise<boolean>;
}

/**
 * Best-effort "is any of our emulator stack alive?" — true iff one of OUR images
 * is running, OR the state file names a pid, OR either fixed port (5901/6080) is
 * occupied. Cheap gate for killAll's FAST PATH: when everything reads dead we skip
 * the graceful `pebble kill` bundled-interpreter spawn (~0.3–1s wasted per boot
 * with nothing running). It reuses ONLY the probes killAll/reap already perform.
 *
 * Correctness is NOT critical: a false "alive" costs one harmless graceful kill; a
 * false "dead" still gets force-reaped by killSweep afterward. Short-circuits —
 * pids first (cheap image/state check), and only probes ports if still unknown, so
 * it adds no port I/O on the common "already have pids" path.
 */
export async function anythingAlive(deps: AliveProbeDeps): Promise<boolean> {
  const [stateRaw, perImage] = await Promise.all([
    deps.readState(),
    Promise.all(EMU_IMAGES.map((img) => deps.pidsByImage(img))),
  ]);
  if (perImage.some((pids) => pids.length > 0)) return true;
  if (parseStatePids(stateRaw).length > 0) return true;
  const [rfb, ws] = await Promise.all([
    deps.portOpen("127.0.0.1", VNC_RFB_PORT),
    deps.portOpen("127.0.0.1", WS_PORT),
  ]);
  return rfb || ws;
}

function stateHasLivePid(json: string, id: PlatformId): boolean {
  try {
    const o = JSON.parse(json) as Record<string, Record<string, { qemu?: { pid?: number } }>>;
    const vers = o[id];
    if (!vers) return false;
    for (const v of Object.values(vers)) if (v?.qemu?.pid) return true;
    return false;
  } catch { return false; }
}

export function makeWinBootDeps(impl: WinBootDepsImpl): SpawnDeps & { reap: () => Promise<void> } {
  const run = impl.run;
  const readFile = impl.readFile ?? (async (p: string) => fsReadFile(p, "utf8").catch(() => ""));
  const rm = impl.rm ?? (async (p: string) => { await fsRm(p, { force: true }).catch(() => {}); });
  // no real default — the production caller (createDriver) MUST provide this; the real impl needs detached-spawn + Job Object wiring.
  const detachSpawn = impl.detachSpawn ?? (async () => { throw new Error("detachSpawn not provided"); });
  // Default: bare `pebble` on PATH (legacy / non-bundled). Production injects the
  // bundled-python invocation (winRuntime.pebbleCmd) carrying the runtime env.
  const pebble = impl.pebble ?? ((args: string[]): PebbleCommand => ({ cmd: "pebble", args }));
  const paths = impl.paths ?? winHostPaths();
  const checkPortOpen = impl.portOpen ?? portOpen;
  // Default kill = DIRECT TerminateProcess. Node maps process.kill() to
  // TerminateProcess on Windows; ESRCH (already gone) / EPERM are swallowed.
  const killPid = impl.killPid ?? (async (pid: number): Promise<void> => {
    try { process.kill(pid); } catch { /* already dead or not ours */ }
  });
  // Default image enumeration = BOUNDED tasklist (a hung tasklist must not wedge
  // teardown / the startup reap / backend:init — the v3.0.4-test1 regression).
  const pidsByImage = impl.pidsByImage ?? ((image: string): Promise<number[]> => tasklistPids(image));
  // Default pid→image resolution = BOUNDED tasklist by PID (same wedge guard).
  const imageOfPid = impl.imageOfPid ?? ((pid: number): Promise<string> => tasklistImage(pid));
  // Default mtime probe = fs.stat; missing/unreadable → 0 so a nonexistent log
  // reads as "infinitely stale" and readBootLog returns "" (never mines it).
  const statMtimeMs = impl.statMtimeMs ?? (async (p: string): Promise<number> => fsStat(p).then((s) => s.mtimeMs).catch(() => 0));
  // Timestamp of the most recent bootControl (emu-control launch). readBootLog
  // treats a log file untouched since this instant as stale (see readBootLog).
  let lastBootAt = 0;

  const diagnose = async (): Promise<BootProbe> => {
    // qemu liveness goes through the BOUNDED pid enumeration (alive ⇔ non-empty),
    // NOT the raw unbounded runner: diagnose runs on the boot critical path and on
    // the progress ticker (every ~1.5s during a stall), so a hung `tasklist` here
    // must not freeze the boot — pidsByImage kills a wedged tasklist on timeout.
    const stateRaw = await readFile(paths.emuInfo);
    const [qpids, rfbOpen, wsOpen] = await Promise.all([
      pidsByImage("qemu-pebble.exe"),
      checkPortOpen("127.0.0.1", VNC_RFB_PORT),
      checkPortOpen("127.0.0.1", WS_PORT),
    ]);
    return { qemuAlive: qpids.length > 0, stateFile: stateRaw.trim().length > 0, rfbOpen, wsOpen };
  };

  const waitForEmuInfo = async (id: PlatformId, timeoutMs: number, token?: BootToken): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token?.cancelled) throw new BootAborted();
      const raw = await readFile(paths.emuInfo);
      if (raw.trim() && stateHasLivePid(raw, id)) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for emulator info for ${id}`);
      await new Promise((r) => setTimeout(r, 300));
      if (token?.cancelled) throw new BootAborted();
    }
  };

  const waitForPort = (host: string, port: number, timeoutMs: number, token?: BootToken): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = async () => {
        if (token?.cancelled) return reject(new BootAborted());
        if (await checkPortOpen(host, port)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${host}:${port}`));
        setTimeout(() => { void attempt().catch(reject); }, 300);
      };
      void attempt().catch(reject);
    });
  };

  const isEmuImage = (image: string): boolean =>
    (EMU_IMAGES as readonly string[]).includes(image);

  /**
   * One kill pass: collect every pid we own — by enumerating OUR images (the
   * supervisor + qemu, whose names are uniquely ours so these pids are VERIFIED)
   * AND from the state file (qemu/pypkjs/websockify — the python-hosted bridge +
   * proxy an image kill can't safely target) — and force-kill each via the DIRECT
   * TerminateProcess primitive.
   *
   * State-file pids are UNTRUSTED: %TEMP%\pb-emulator.json survives crashes AND
   * reboots, and Windows recycles pids aggressively, so a stale entry can point at
   * an unrelated same-user process. We therefore VERIFY each state pid's image is
   * one of ours before killing it (image-enumerated pids are already verified and
   * skip the second check), and never signal our own process. If EVERY state pid
   * fails verification the file is stale — drop it. Returns the count killed so the
   * caller can tell whether anything of ours was still there.
   */
  const killSweep = async (): Promise<number> => {
    const fromState = parseStatePids(await readFile(paths.emuInfo));
    // Enumerate images CONCURRENTLY, but keep EMU_IMAGES order (supervisor before
    // qemu) so the kill loop below still fires supervisor-first — a killed qemu
    // can't be respawned before the supervisor itself dies.
    const perImage = await Promise.all(EMU_IMAGES.map((img) => pidsByImage(img)));
    const fromImage = perImage.flat();
    const imageSet = new Set(fromImage);

    // Verify each state pid before trusting it.
    const stateVerified: number[] = [];
    for (const pid of fromState) {
      if (pid === process.pid) continue; // never TerminateProcess ourselves
      if (imageSet.has(pid) || isEmuImage(await imageOfPid(pid))) stateVerified.push(pid);
    }
    // Stale state file: it named pids but NONE are ours (post-reboot pid reuse).
    if (fromState.length > 0 && stateVerified.length === 0) await rm(paths.emuInfo);

    const pids = [...new Set([...fromImage, ...stateVerified])].filter((p) => p !== process.pid);
    for (const pid of pids) await killPid(pid);
    return pids.length;
  };

  /**
   * Poll the VNC/ws ports until BOTH are free, RE-SWEEPING each pass: a still-held
   * port means a kill hasn't landed yet (or the supervisor respawned qemu), so we
   * kill again rather than returning on a silent failure. Bounded so it can never
   * hang the app.
   */
  const settleKilled = async (): Promise<void> => {
    const deadline = Date.now() + KILL_SETTLE_TIMEOUT_MS;
    for (;;) {
      const [rfb, ws] = await Promise.all([
        checkPortOpen("127.0.0.1", VNC_RFB_PORT),
        checkPortOpen("127.0.0.1", WS_PORT),
      ]);
      if (!rfb && !ws) return;
      if (Date.now() >= deadline) return; // give up gracefully; never hang the app
      // If a sweep found NOTHING of ours yet a port is still held, the owner is a
      // FOREIGN process (e.g. a WSL Pebble emulator that mirrors localhost) — we
      // can't free it, so don't burn the full settle budget polling next to it.
      if ((await killSweep()) === 0) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  /**
   * Force-reap our stack with NO graceful `pebble kill` first. Used at app startup
   * to clear orphans from a prior session (a crash / Task-Manager "End process" /
   * the old taskkill-timeout bug) BEFORE the first boot — skipping the bundled-
   * interpreter spawn keeps startup snappy. Safe to call pre-boot: there is no
   * legitimate emulator yet, so the image-wide kill can only hit orphans.
   */
  const reap = async (): Promise<void> => {
    await killSweep();
    await rm(paths.emuInfo);
    await settleKilled();
  };

  const killAll = async (): Promise<void> => {
    // 1. Ask pebble-tool to kill the emulator FIRST (graceful supervisor
    //    shutdown) — but ONLY when something is actually alive. FAST PATH: a fresh
    //    boot with no prior emulator has nothing to gracefully kill, so spawning
    //    the bundled interpreter for a no-op `pebble kill` just wastes ~0.3–1s.
    //    When anythingAlive reads dead we skip straight to the (idempotent) reap.
    //    BOUNDED: under load the bundled-interpreter spawn can be slow, and a hung
    //    `pebble kill` used to wedge teardown on "stopping…"; we never wait more
    //    than PEBBLE_KILL_TIMEOUT_MS for it. Best-effort, non-fatal.
    const alive = await anythingAlive({
      readState: () => readFile(paths.emuInfo),
      pidsByImage,
      portOpen: checkPortOpen,
    });
    if (alive) {
      const k = pebble(["kill"]);
      await withTimeout(run(k.cmd, k.args, k.env), PEBBLE_KILL_TIMEOUT_MS).catch(() => {});
    }
    // 2. Force-kill OUR stack via direct TerminateProcess (NOT taskkill /T, whose
    //    tree-walk times out and silently fails under load — the orphan bug) and
    //    settle the ports with re-sweep retry.
    await reap();
  };

  const preflight = async (): Promise<void> => {
    // Runs ONCE before the boot retry loop, AFTER killAll has freed OUR stack. If
    // the VNC/ws ports are STILL occupied, a FOREIGN process owns them — most
    // commonly a WSL Pebble emulator (WSL2 mirrors localhost to Windows) or a
    // second Pebble Studio instance. emu-control hardcodes -vnc :1 (5901), so we
    // cannot pick alternate ports for v0.0.1; surface a clear, actionable error
    // instead of letting the fresh qemu die on the cryptic "address already in use".
    const [rfb, ws] = await Promise.all([
      checkPortOpen("127.0.0.1", VNC_RFB_PORT),
      checkPortOpen("127.0.0.1", WS_PORT),
    ]);
    if (!rfb && !ws) return;
    const which = [rfb ? String(VNC_RFB_PORT) : null, ws ? String(WS_PORT) : null].filter(Boolean).join(" and ");
    throw new Error(
      `Emulator port ${which} is already in use by another process — likely a WSL Pebble emulator or a second Pebble Studio instance. Close it, then try again.`,
    );
  };

  const ensureKeymap = async (): Promise<void> => {
    // No-op: keymaps are seeded ONCE at first-run provisioning
    // (winSdkProvision.provisionWinSdk), which copies the qemu bundle's
    // pc-bios\keymaps into the WRITABLE persist dir (XDG_DATA_HOME) that
    // pebble-tool resolves SDKs\current against — the correct location. The old
    // per-boot stub targeted winHostPaths().sdkRoot (%LOCALAPPDATA%), which the
    // invocation contract does not use, so it never seeded the keymaps qemu reads.
  };

  return {
    bootControl: (id: PlatformId) => {
      // Stamp the launch time so readBootLog can reject a log left over from a
      // prior run (see readBootLog).
      lastBootAt = Date.now();
      const c = pebble(["emu-control", "--emulator", id, "--vnc"]);
      return detachSpawn(c.cmd, c.args, c.env);
    },
    ensureKeymap,
    preflight,
    diagnose,
    waitForPort,
    waitForEmuInfo,
    killAll,
    reap,
    wipe: async () => { const c = pebble(["wipe"]); await run(c.cmd, c.args, c.env).catch(() => {}); },
    readBootLog: async () => {
      // Guard against mining a STALE error: on windows-native the detached
      // supervisor is spawned with stdio "ignore", so NOTHING currently writes
      // %TEMP%\pebble-emu.log — the file, if present, is left over from an earlier
      // run and its errors don't belong to this boot. Return "" unless the log was
      // written AFTER this attempt's emu-control launch. (If createDriver is later
      // changed to pipe the supervisor's stdio here, a fresh write dates past
      // lastBootAt and surfaces normally.)
      if ((await statMtimeMs(paths.emuLog)) < lastBootAt) return "";
      return readFile(paths.emuLog);
    },
  };
}
