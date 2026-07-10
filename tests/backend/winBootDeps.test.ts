import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { makeWinBootDeps, tasklistPids, anythingAlive } from "../../src/main/backend/winBootDeps.js";

/** Minimal stand-in for a spawned child process (stdout + close/error + kill). */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.kill = () => {};
  return child;
}

function deps(over = {}) {
  const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const readFile = vi.fn(async () => "");
  const detachSpawn = vi.fn(async () => {});
  // Inject safe spies so tests NEVER call the real process.kill / tasklist.
  const killPid = vi.fn(async (_pid: number) => {});
  const pidsByImage = vi.fn(async (_image: string) => [] as number[]);
  // Default: every state-file pid resolves to one of OUR images (verified), so the
  // legacy tests that expect state pids to be killed keep passing. The identity
  // regression tests below override this to return a NON-ours image.
  const imageOfPid = vi.fn(async (_pid: number) => "qemu-pebble.exe");
  return { run, readFile, detachSpawn, killPid, pidsByImage, imageOfPid, ...over };
}

describe("makeWinBootDeps", () => {
  it("bootControl detach-spawns bare pebble (PATH default) with no extra env", async () => {
    const d = deps();
    const b = makeWinBootDeps(d);
    await b.bootControl("basalt");
    expect(d.detachSpawn).toHaveBeenCalledWith("pebble", ["emu-control", "--emulator", "basalt", "--vnc"], undefined);
  });

  it("bootControl routes through the injected bundled-pebble builder, threading its env to the detached spawn", async () => {
    const pebble = (args: string[]) => ({
      cmd: "C:\\py\\python.exe",
      args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
      env: { PEBBLE_QEMU_PATH: "C:\\q\\qemu-pebble.exe", XDG_DATA_HOME: "C:\\data\\pebble-data" },
    });
    const d = deps({ pebble });
    const b = makeWinBootDeps(d);
    await b.bootControl("emery");
    expect(d.detachSpawn).toHaveBeenCalledWith(
      "C:\\py\\python.exe",
      ["-c", "from pebble_tool import run_tool; run_tool()", "emu-control", "--emulator", "emery", "--vnc"],
      { PEBBLE_QEMU_PATH: "C:\\q\\qemu-pebble.exe", XDG_DATA_HOME: "C:\\data\\pebble-data" },
    );
  });

  it("wipe routes through the injected bundled-pebble builder with its env", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const pebble = (args: string[]) => ({
      cmd: "C:\\py\\python.exe",
      args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
      env: { XDG_DATA_HOME: "C:\\data\\pebble-data" },
    });
    const d = deps({
      pebble,
      run: vi.fn(async (cmd: string, args: string[], env?: Record<string, string>) => { calls.push({ cmd, args, env }); return { code: 0, stdout: "", stderr: "" }; }),
    });
    const b = makeWinBootDeps(d);
    await b.wipe!();
    const wipeCall = calls.find((c) => c.args.includes("wipe"));
    expect(wipeCall?.cmd).toBe("C:\\py\\python.exe");
    expect(wipeCall?.env).toEqual({ XDG_DATA_HOME: "C:\\data\\pebble-data" });
  });

  it("diagnose reports qemuAlive from the bounded image enumeration (not the unbounded runner)", async () => {
    const d = deps({
      // Liveness now comes from pidsByImage (bounded), NOT run("tasklist", …).
      pidsByImage: vi.fn(async (img: string) => (img === "qemu-pebble.exe" ? [999] : [])),
      readFile: vi.fn(async () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 999 } } } })),
      portOpen: vi.fn(async () => false),
    });
    const b = makeWinBootDeps(d);
    const probe = await b.diagnose();
    expect(probe.qemuAlive).toBe(true);
    expect(probe.stateFile).toBe(true);
    // The unbounded runner is NOT used for the liveness probe (no tasklist spawn).
    expect(d.run.mock.calls.some(([cmd]: [string]) => cmd === "tasklist")).toBe(false);
  });

  it("waitForEmuInfo resolves once the state file has a live pid for the platform", async () => {
    const d = deps({ readFile: vi.fn(async () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 42 } } } })) });
    const b = makeWinBootDeps(d);
    await expect(b.waitForEmuInfo("basalt", 1000)).resolves.toBeUndefined();
  });

  it("killAll kills image-enumerated pids DIRECTLY (no taskkill) and removes the state file", async () => {
    const d = deps({
      pidsByImage: vi.fn(async (img: string) =>
        img === "qemu-pebble.exe" ? [72480] : img === "PebbleStudioEmu.exe" ? [14952] : []),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    const b = makeWinBootDeps(d);
    await b.killAll();
    expect(d.killPid).toHaveBeenCalledWith(72480);
    expect(d.killPid).toHaveBeenCalledWith(14952);
    // The /T tree-walk that timed out under load is GONE: no taskkill is spawned.
    expect(d.run.mock.calls.some(([cmd]: [string]) => cmd === "taskkill")).toBe(false);
    expect(d.rm).toHaveBeenCalled();
  });

  it("waitForEmuInfo throws on timeout when the state file never has a live pid", async () => {
    const b = makeWinBootDeps(deps({ readFile: vi.fn(async () => "") }));
    await expect(b.waitForEmuInfo("basalt", 1)).rejects.toThrow(/timeout/i);
  });

  it("waitForEmuInfo aborts promptly when the token is cancelled", async () => {
    const token = { cancelled: true };
    const b = makeWinBootDeps(deps({ readFile: vi.fn(async () => "") }));
    await expect(b.waitForEmuInfo("basalt", 10_000, token)).rejects.toThrow(/abort/i);
  });

  it("waitForPort rejects on timeout when the port never opens", async () => {
    const b = makeWinBootDeps(deps({ portOpen: vi.fn(async () => false) }));
    await expect(b.waitForPort("127.0.0.1", 5901, 1)).rejects.toThrow(/timeout/i);
  });

  it("diagnose reports qemuAlive=false for the 'No tasks' tasklist banner", async () => {
    const b = makeWinBootDeps(deps({
      run: vi.fn(async () => ({ code: 0, stdout: "INFO: No tasks are running which match the specified criteria.\r\n", stderr: "" })),
      readFile: vi.fn(async () => ""),
      portOpen: vi.fn(async () => false),
    }));
    const probe = await b.diagnose();
    expect(probe.qemuAlive).toBe(false);
    expect(probe.stateFile).toBe(false);
  });
});

describe("makeWinBootDeps killAll — process-leak fix", () => {
  // State file with qemu + pypkjs + websockify pids; the latter two run as
  // python.exe, so they MUST be killed by PID (an image kill would leak them).
  const stateJson = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 1001, port: 63000, vnc: true },
        pypkjs: { pid: 1002, port: 63001 },
        websockify: { pid: 1003 },
      },
    },
  });

  it("force-kills every state-file pid AND every image pid directly (process.kill), then removes the state file", async () => {
    const d = deps({
      readFile: vi.fn(async () => stateJson),
      pidsByImage: vi.fn(async (img: string) =>
        img === "qemu-pebble.exe" ? [1001] : img === "PebbleStudioEmu.exe" ? [2001] : []),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    const b = makeWinBootDeps(d);
    await b.killAll();

    // Every state-file pid (qemu/pypkjs/websockify) AND the image-enumerated
    // supervisor pid are killed via the direct TerminateProcess primitive.
    for (const pid of [1001, 1002, 1003, 2001]) {
      expect(d.killPid).toHaveBeenCalledWith(pid);
    }
    expect(d.rm).toHaveBeenCalled();
  });

  it("only enumerates OUR images (never python.exe, which would hit unrelated user Python)", async () => {
    const d = deps({
      readFile: vi.fn(async () => stateJson),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    await makeWinBootDeps(d).killAll();
    const queried = d.pidsByImage.mock.calls.map(([img]: [string]) => img);
    expect(queried).not.toContain("python.exe");
    expect(queried).toEqual(expect.arrayContaining(["qemu-pebble.exe", "PebbleStudioEmu.exe"]));
  });

  it("re-sweeps while a port stays held, instead of silently giving up", async () => {
    // Ports report busy for the first settle poll, then free — so killAll must
    // run the kill sweep MORE THAN ONCE (the old code killed once and returned).
    let poll = 0;
    const d = deps({
      readFile: vi.fn(async () => stateJson),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => { poll++; return poll <= 2; }),
    });
    await makeWinBootDeps(d).killAll();
    const killed1001 = d.killPid.mock.calls.filter(([p]: [number]) => p === 1001).length;
    expect(killed1001).toBeGreaterThan(1);
  });

  it("does NOT kill a stale state-file pid whose image is NOT ours (post-reboot pid reuse)", async () => {
    // The state file survives crashes AND reboots; Windows recycles pids, so 5555
    // may now belong to an unrelated same-user process. It must NEVER be killed.
    const staleState = JSON.stringify({ emery: { "4.9": { qemu: { pid: 5555 } } } });
    const rm = vi.fn(async () => {});
    const d = deps({
      readFile: vi.fn(async () => staleState),
      pidsByImage: vi.fn(async () => [] as number[]), // none of OUR images are running
      imageOfPid: vi.fn(async (_pid: number) => "notepad.exe"), // 5555 is a stranger
      rm,
      portOpen: vi.fn(async () => false),
    });
    await makeWinBootDeps(d).killAll();
    expect(d.killPid).not.toHaveBeenCalledWith(5555);
    // ALL state pids failed verification → the stale file is dropped.
    expect(rm).toHaveBeenCalled();
  });

  it("DOES kill a state-file pid whose image IS ours (verified)", async () => {
    const state = JSON.stringify({ emery: { "4.9": { pypkjs: { pid: 6001 } } } });
    const d = deps({
      readFile: vi.fn(async () => state),
      pidsByImage: vi.fn(async () => [] as number[]),
      imageOfPid: vi.fn(async (_pid: number) => "PebbleStudioEmu.exe"),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    await makeWinBootDeps(d).killAll();
    expect(d.killPid).toHaveBeenCalledWith(6001);
  });

  it("calls pebble kill first (supervisor shutdown) through the bundled builder", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const pebble = (args: string[]) => ({ cmd: "C:\\py\\python.exe", args: ["-c", "run", ...args], env: { X: "1" } });
    const d = deps({
      pebble,
      run: vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; }),
      readFile: vi.fn(async () => ""),
      // A live image makes the fast-path gate report "alive", so the graceful
      // `pebble kill` still fires (this test asserts the graceful-first ordering).
      pidsByImage: vi.fn(async (img: string) => (img === "qemu-pebble.exe" ? [4242] : [])),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    await makeWinBootDeps(d).killAll();
    expect(calls.some((c) => c.cmd === "C:\\py\\python.exe" && c.args.includes("kill"))).toBe(true);
  });

  it("FAST PATH: skips the graceful pebble kill spawn when nothing is alive", async () => {
    // No state file, no images running, both ports free → nothing to gracefully
    // kill, so we must NOT pay the bundled-interpreter spawn cost for `pebble kill`.
    const d = deps({
      readFile: vi.fn(async () => ""),
      pidsByImage: vi.fn(async () => [] as number[]),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    await makeWinBootDeps(d).killAll();
    // Graceful kill (any argv containing "kill" through the runner) never spawned.
    expect(d.run.mock.calls.some(([, args]: [string, string[]]) => args?.includes("kill"))).toBe(false);
    // The unconditional force-reap still ran (state file cleared).
    expect(d.rm).toHaveBeenCalled();
  });

  it("still force-reaps (sweep + settle) when a port is occupied but no pids are found", async () => {
    // A foreign owner (e.g. WSL emulator) holds the port with none of OUR pids.
    // The gate reads "alive" (port busy), so graceful kill fires, AND the reap
    // sweep + settle still run unconditionally.
    const d = deps({
      readFile: vi.fn(async () => ""),
      pidsByImage: vi.fn(async () => [] as number[]),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => true),
    });
    await makeWinBootDeps(d).killAll();
    expect(d.run.mock.calls.some(([, args]: [string, string[]]) => args?.includes("kill"))).toBe(true);
    expect(d.pidsByImage).toHaveBeenCalled(); // sweep enumerated our images
    expect(d.rm).toHaveBeenCalled();
  });
});

describe("anythingAlive — killAll fast-path gate", () => {
  const base = {
    readState: async () => "",
    pidsByImage: async (_img: string) => [] as number[],
    portOpen: async (_h: string, _p: number) => false,
  };
  it("false when there are no state pids, no image pids, and both ports are free", async () => {
    expect(await anythingAlive({ ...base })).toBe(false);
  });
  it("true when the state file names a pid", async () => {
    const readState = async () => JSON.stringify({ emery: { "4.9": { qemu: { pid: 1001 } } } });
    expect(await anythingAlive({ ...base, readState })).toBe(true);
  });
  it("true when one of our images is running", async () => {
    const pidsByImage = async (img: string) => (img === "qemu-pebble.exe" ? [123] : []);
    expect(await anythingAlive({ ...base, pidsByImage })).toBe(true);
  });
  it("true when the ws port (6080) is occupied", async () => {
    const portOpen = async (_h: string, p: number) => p === 6080;
    expect(await anythingAlive({ ...base, portOpen })).toBe(true);
  });
  it("true when the RFB port (5901) is occupied", async () => {
    const portOpen = async (_h: string, p: number) => p === 5901;
    expect(await anythingAlive({ ...base, portOpen })).toBe(true);
  });
});

describe("tasklistPids — bounded process enumeration (tasklist can hang)", () => {
  it("resolves the parsed pids when the child closes with CSV output", async () => {
    const child = fakeChild();
    const p = tasklistPids("qemu-pebble.exe", { spawn: () => child, timeoutMs: 1000 });
    child.stdout.emit("data", Buffer.from(`"qemu-pebble.exe","1234","Console","1","10 K"\r\n`));
    child.emit("close", 0);
    expect(await p).toEqual([1234]);
  });

  it("resolves [] AND kills the child when tasklist hangs past the timeout", async () => {
    const child = fakeChild();
    const kill = vi.fn();
    child.kill = kill;
    // never emit "close" → only the timeout can settle it
    const p = tasklistPids("anything.exe", { spawn: () => child, timeoutMs: 10 });
    expect(await p).toEqual([]);
    expect(kill).toHaveBeenCalled();
  });

  it("resolves [] when the spawn errors (tasklist missing / failed)", async () => {
    const child = fakeChild();
    const p = tasklistPids("x.exe", { spawn: () => child, timeoutMs: 1000 });
    child.emit("error", new Error("ENOENT"));
    expect(await p).toEqual([]);
  });
});

describe("makeWinBootDeps reap — startup orphan reaper", () => {
  it("force-kills state + image pids directly and removes the state file", async () => {
    const d = deps({
      readFile: vi.fn(async () => JSON.stringify({ emery: { "4.9": { qemu: { pid: 1001 } } } })),
      pidsByImage: vi.fn(async (img: string) => (img === "qemu-pebble.exe" ? [72480] : [])),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    const b = makeWinBootDeps(d);
    await b.reap();
    expect(d.killPid).toHaveBeenCalledWith(1001);
    expect(d.killPid).toHaveBeenCalledWith(72480);
    expect(d.rm).toHaveBeenCalled();
  });

  it("does NOT spawn the graceful 'pebble kill' (no bundled-interpreter startup cost)", async () => {
    const pebble = vi.fn((args: string[]) => ({ cmd: "C:\\py\\PebbleStudioEmu.exe", args, env: {} }));
    const d = deps({ pebble, readFile: vi.fn(async () => ""), rm: vi.fn(async () => {}), portOpen: vi.fn(async () => false) });
    await makeWinBootDeps(d).reap();
    expect(pebble).not.toHaveBeenCalled();
  });
});

describe("makeWinBootDeps preflight — foreign port-collision guard", () => {
  it("resolves when both VNC and ws ports are free", async () => {
    const b = makeWinBootDeps(deps({ portOpen: vi.fn(async () => false) }));
    await expect(b.preflight!()).resolves.toBeUndefined();
  });

  it("throws a clear, actionable error when a port is still held after teardown", async () => {
    const b = makeWinBootDeps(deps({ portOpen: vi.fn(async () => true) }));
    await expect(b.preflight!()).rejects.toThrow(/already in use.*(WSL|Pebble Studio instance)/i);
  });

  it("names the specific port(s) in use", async () => {
    // Only the RFB port (5901) is held.
    const portOpen = vi.fn(async (_h: string, p: number) => p === 5901);
    const b = makeWinBootDeps(deps({ portOpen }));
    await expect(b.preflight!()).rejects.toThrow(/5901/);
  });
});
