import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Drive a module-level mock of the `spawn` named import. Each test sets
 * `spawnImpl` to a fake that records calls and returns a fake child. No real
 * processes are ever spawned.
 */
const calls: { cmd: string; args: string[] }[] = [];
let stdoutFor: (cmd: string, args: string[]) => string = () => "";
let exitCode = 0;

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; unref: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    // The verify-dead gate (waitUntilDead) shells out `pgrep -x qemu-pebble`.
    // For these construction tests there is no real qemu, so report "dead"
    // (non-zero exit, empty stdout) so the gate resolves immediately instead of
    // polling to its timeout. Other commands use the shared exitCode/stdoutFor.
    const isPgrep = args.some((a) => typeof a === "string" && a.includes("pgrep"));
    queueMicrotask(() => {
      if (isPgrep) {
        child.emit("close", 1);
        return;
      }
      const out = stdoutFor(cmd, args);
      if (out) child.stdout.emit("data", Buffer.from(out));
      child.emit("close", exitCode);
    });
    return child;
  },
}));

// Import AFTER the mock is registered (vi.mock is hoisted, so this is fine).
const { bootEmulator, BootAborted, makeWslBootDeps, makeNativeBootDeps, waitUntilDead } = await import(
  "../../src/main/backend/bootEmulator.js"
);

/** Build a fake Shell whose `pgrep -x qemu-pebble` returns a scripted sequence
 * of {code,stdout} (one per poll); `run` for anything else is a no-op success. */
function makePgrepShell(seq: { code: number; stdout: string }[]) {
  let i = 0;
  const pgrepCalls: string[] = [];
  const shell = {
    run: async (cmdline: string) => {
      if (cmdline.includes("pgrep")) {
        pgrepCalls.push(cmdline);
        const r = seq[Math.min(i, seq.length - 1)];
        i += 1;
        return { code: r.code, stdout: r.stdout, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnDetached: async () => {},
  };
  return { shell, pgrepCalls };
}

describe("waitUntilDead", () => {
  it("waits while qemu is alive, then resolves once pgrep reports dead AND port is free", async () => {
    // First poll: qemu still alive (pgrep exit 0). Second poll: gone (exit 1, empty).
    const { shell, pgrepCalls } = makePgrepShell([
      { code: 0, stdout: "4242\n" },
      { code: 1, stdout: "" },
    ]);
    const portFree = vi.fn(async () => true);
    await waitUntilDead(shell, 5000, { portFree, pollIntervalMs: 0 });
    // It polled at least twice (waited out the "alive" poll before resolving).
    expect(pgrepCalls.length).toBeGreaterThanOrEqual(2);
    // Port is only probed once qemu is gone — never while it's still alive.
    expect(portFree).toHaveBeenCalledTimes(1);
    expect(portFree).toHaveBeenCalledWith("127.0.0.1", 5901);
  });

  it("keeps waiting if qemu is gone but the RFB port is still bound", async () => {
    const { shell } = makePgrepShell([{ code: 1, stdout: "" }]);
    // Port stays bound for the first two probes, then frees up.
    const portFree = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await waitUntilDead(shell, 5000, { portFree, pollIntervalMs: 0 });
    expect(portFree.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("resolves (does not throw) when the timeout elapses with qemu still alive", async () => {
    // pgrep always reports alive ⇒ the gate can only end via timeout.
    const { shell } = makePgrepShell([{ code: 0, stdout: "4242\n" }]);
    const portFree = vi.fn(async () => true);
    const start = Date.now();
    await expect(
      waitUntilDead(shell, 60, { portFree, pollIntervalMs: 10 }),
    ).resolves.toBeUndefined();
    // It honored the (short) timeout rather than hanging forever.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("bootEmulator WSL shell construction", () => {
  beforeEach(() => {
    calls.length = 0;
    stdoutFor = () => "";
    exitCode = 0;
  });

  it("makeWslBootDeps routes killAll through wsl.exe -- bash -lc with pkill", async () => {
    const deps = makeWslBootDeps();
    await deps.killAll();
    const call = calls.find((c) => c.cmd === "wsl.exe");
    expect(call).toBeDefined();
    expect(call!.args.slice(0, 3)).toEqual(["--", "bash", "-lc"]);
    const cmdline = call!.args[3];
    expect(cmdline).toContain("pebble kill");
    // qemu is matched by EXACT process name (avoids the shell self-match hazard).
    expect(cmdline).toContain("pkill -9 -x qemu-pebble");
    // websockify/emu-control use the [c]haracter-class self-exclusion trick.
    expect(cmdline).toContain("[w]ebsockify");
    expect(cmdline).toContain("[e]mu-control");
  });

  it("makeWslBootDeps bootControl detaches emu-control via setsid nohup inside wsl.exe", async () => {
    const deps = makeWslBootDeps();
    await deps.bootControl("basalt");
    const call = calls.find((c) => c.cmd === "wsl.exe");
    expect(call).toBeDefined();
    expect(call!.args.slice(0, 3)).toEqual(["--", "bash", "-lc"]);
    const inner = call!.args[3];
    // The emulator must survive wsl.exe returning: setsid + nohup + background + exit 0.
    expect(inner).toMatch(/setsid nohup/);
    expect(inner).toContain("pebble emu-control --emulator basalt --vnc");
    expect(inner).toContain("exit 0");
  });

  it("makeWslBootDeps waitForEmuInfo reads /tmp/pb-emulator.json via wsl.exe cat (not Node fs)", async () => {
    stdoutFor = () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 4242 } } } });
    const deps = makeWslBootDeps();
    await deps.waitForEmuInfo("basalt", 2000);
    const call = calls.find((c) => c.cmd === "wsl.exe" && String(c.args[3]).includes("cat"));
    expect(call).toBeDefined();
    expect(call!.args[3]).toContain("/tmp/pb-emulator.json");
  });

  it("makeNativeBootDeps routes through bash -lc (no wsl.exe)", async () => {
    const deps = makeNativeBootDeps();
    await deps.killAll();
    expect(calls.some((c) => c.cmd === "wsl.exe")).toBe(false);
    const call = calls.find((c) => c.cmd === "bash");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("-lc");
  });

  it("bootEmulator runs the lifecycle in order using injected fake deps (no spawning)", async () => {
    const order: string[] = [];
    const endpoint = await bootEmulator("basalt", {
      killAll: async () => { order.push("killAll"); },
      ensureKeymap: async () => { order.push("ensureKeymap"); },
      bootControl: async () => { order.push("bootControl"); },
      waitForEmuInfo: async () => { order.push("waitForEmuInfo"); },
      waitForPort: async () => { order.push("waitForPort"); },
    });
    expect(order).toEqual([
      "killAll", "ensureKeymap", "bootControl", "waitForEmuInfo", "waitForPort", "waitForPort",
    ]);
    expect(endpoint).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
  });
});

describe("bootEmulator cancellation", () => {
  /**
   * A waitForEmuInfo that polls a token like the real one: it loops with a short
   * delay and throws BootAborted as soon as the token flips. We assert the boot
   * rejects PROMPTLY (after a few polls), not after the full 60s timeout.
   */
  function makeTokenAwareWait(intervalMs = 50) {
    return async (_id: string, _timeoutMs: number, token?: { cancelled: boolean }) => {
      for (;;) {
        if (token?.cancelled) throw new BootAborted();
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    };
  }

  it("rejects with BootAborted promptly when the token flips mid-wait", async () => {
    const token = { cancelled: false };
    // Flip the token shortly after the boot enters its (never-resolving) wait.
    setTimeout(() => { token.cancelled = true; }, 120);

    const start = Date.now();
    await expect(
      bootEmulator("basalt", {
        killAll: async () => {},
        ensureKeymap: async () => {},
        bootControl: async () => {},
        // This wait never succeeds on its own; only the token can end it.
        waitForEmuInfo: makeTokenAwareWait(),
        waitForPort: makeTokenAwareWait(),
      }, token),
    ).rejects.toBeInstanceOf(BootAborted);
    const elapsed = Date.now() - start;
    // Promptly: well under the real 60s readiness timeout (and the per-call ~300ms
    // poll cadence). A generous ceiling keeps this robust on slow CI.
    expect(elapsed).toBeLessThan(2000);
  });

  it("throws BootAborted immediately if the token is already cancelled at entry", async () => {
    const killAll = vi.fn(async () => {});
    await expect(
      bootEmulator("basalt", {
        killAll,
        ensureKeymap: async () => {},
        bootControl: async () => {},
        waitForEmuInfo: async () => {},
        waitForPort: async () => {},
      }, { cancelled: true }),
    ).rejects.toBeInstanceOf(BootAborted);
    // Bails before doing any teardown work.
    expect(killAll).not.toHaveBeenCalled();
  });
});
