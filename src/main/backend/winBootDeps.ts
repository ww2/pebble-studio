import type { PlatformId } from "../../shared/types.js";
import type { BootToken, SpawnDeps, BootProbe } from "./bootEmulator.js";
import { BootAborted } from "./bootEmulator.js";
import { winHostPaths } from "./hostPaths.js";
import { tasklistArgs, parseTasklistAlive, taskkillByImageArgs } from "./winProc.js";
import { connect as netConnect } from "node:net";
import { readFile as fsReadFile, rm as fsRm, mkdir, copyFile } from "node:fs/promises";

const VNC_RFB_PORT = 5901;
const WS_PORT = 6080;

/** Argv runner (shell:false). Injected so tests don't spawn real processes. */
export type WinRunner = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WinBootDepsImpl {
  run: WinRunner;
  /** Read a file as utf8; resolves "" if missing. Injected for tests. */
  readFile?: (path: string) => Promise<string>;
  /** Remove a file (ignore-missing). Injected for tests. */
  rm?: (path: string) => Promise<void>;
  /** Launch a long-running detached process (Job Object assignment lives here in
   * production). Resolves once launched. Injected for tests. */
  detachSpawn?: (cmd: string, args: string[]) => Promise<void>;
  /** Override host paths (tests). Defaults to winHostPaths(). */
  paths?: { emuInfo: string; emuLog: string; sdkRoot: string };
  /**
   * Probe whether a TCP port is open; resolve true if open.
   * Injected for tests so the killAll settle loop doesn't touch real sockets.
   * Defaults to portOpen() which uses net.connect with a 1s timeout.
   */
  portOpen?: (host: string, port: number) => Promise<boolean>;
}

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

function stateHasLivePid(json: string, id: PlatformId): boolean {
  try {
    const o = JSON.parse(json) as Record<string, Record<string, { qemu?: { pid?: number } }>>;
    const vers = o[id];
    if (!vers) return false;
    for (const v of Object.values(vers)) if (v?.qemu?.pid) return true;
    return false;
  } catch { return false; }
}

export function makeWinBootDeps(impl: WinBootDepsImpl): SpawnDeps {
  const run = impl.run;
  const readFile = impl.readFile ?? (async (p: string) => fsReadFile(p, "utf8").catch(() => ""));
  const rm = impl.rm ?? (async (p: string) => { await fsRm(p, { force: true }).catch(() => {}); });
  const detachSpawn = impl.detachSpawn ?? (async () => { throw new Error("detachSpawn not provided"); });
  const paths = impl.paths ?? winHostPaths();
  const checkPortOpen = impl.portOpen ?? portOpen;

  const diagnose = async (): Promise<BootProbe> => {
    const tl = await run("tasklist", tasklistArgs("qemu-pebble.exe")).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const stateRaw = await readFile(paths.emuInfo);
    return {
      qemuAlive: parseTasklistAlive(tl.stdout),
      stateFile: stateRaw.trim().length > 0,
      rfbOpen: await checkPortOpen("127.0.0.1", VNC_RFB_PORT),
      wsOpen: await checkPortOpen("127.0.0.1", WS_PORT),
    };
  };

  const waitForEmuInfo = async (id: PlatformId, timeoutMs: number, token?: BootToken): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token?.cancelled) throw new BootAborted();
      const raw = await readFile(paths.emuInfo);
      if (raw.trim() && stateHasLivePid(raw, id)) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for emulator info for ${id}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const waitForPort = (host: string, port: number, timeoutMs: number, token?: BootToken): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = async () => {
        if (token?.cancelled) return reject(new BootAborted());
        if (await checkPortOpen(host, port)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${host}:${port}`));
        setTimeout(attempt, 300);
      };
      void attempt();
    });
  };

  const killAll = async (): Promise<void> => {
    await run("taskkill", taskkillByImageArgs("qemu-pebble.exe")).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    await run("taskkill", taskkillByImageArgs("websockify.exe")).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    await rm(paths.emuInfo);
    // Settle: poll the ports free (best-effort; never hang).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await checkPortOpen("127.0.0.1", VNC_RFB_PORT)) && !(await checkPortOpen("127.0.0.1", WS_PORT))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const ensureKeymap = async (): Promise<void> => {
    const dir = `${paths.sdkRoot}\\toolchain\\lib\\pc-bios\\keymaps`;
    await mkdir(dir, { recursive: true }).catch(() => {});
    // Best-effort: a stub en-us keymap; the real qemu build ships its own.
    await copyFile(`${dir}\\..\\en-us`, `${dir}\\en-us`).catch(() => {});
  };

  return {
    bootControl: (id: PlatformId) => detachSpawn("pebble", ["emu-control", "--emulator", id, "--vnc"]),
    ensureKeymap,
    diagnose,
    waitForPort,
    waitForEmuInfo,
    killAll,
    wipe: async () => { await run("pebble", ["wipe"]).catch(() => {}); },
    readBootLog: async () => readFile(paths.emuLog),
  };
}
