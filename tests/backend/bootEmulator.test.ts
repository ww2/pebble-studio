import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

/** Hermetic stub for the injected boot health probe (no real shell spawn). */
const NOPROBE = async () => ({ qemuAlive: true, stateFile: true, rfbOpen: true, wsOpen: true });

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
    // The verify-dead gate (waitUntilDead) shells out `pgrep -f '[q]emu-pebble'`.
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

// Mock node:net so the verify-dead gate's REAL RFB port probe (defaultPortFree →
// net.connect to 127.0.0.1:5901) never touches a real socket in unit tests. A
// connection that errors == "port free", so the killAll construction tests below
// resolve deterministically even if an actual emulator happens to be running on
// 5901 during the test run (otherwise those tests would block to the gate's 5s
// timeout). Tests that need port behavior inject their own portFree/waitForPort.
vi.mock("node:net", () => ({
  connect: () => {
    const sock = new EventEmitter() as EventEmitter & {
      setTimeout: () => void; destroy: () => void;
    };
    sock.setTimeout = () => {};
    sock.destroy = () => {};
    queueMicrotask(() => sock.emit("error", new Error("ECONNREFUSED (mocked)")));
    return sock;
  },
}));

// Import AFTER the mock is registered (vi.mock is hoisted, so this is fine).
const { bootEmulator, BootAborted, makeWslBootDeps, makeNativeBootDeps, waitUntilDead, makeDiagnose, fmtProbe, extractBootErrors, pollUntil } = await import(
  "../../src/main/backend/bootEmulator.js"
);
// timeShim holds the module-level shim-readiness cache that bootControl consults;
// the SAME module instance is shared with bootEmulator's import in this graph.
const { ensureTimeShim, _resetShimState, WRAPPER } = await import(
  "../../src/main/backend/timeShim.js"
);

/** Build a fake Shell whose `pgrep -f '[q]emu-pebble'` returns a scripted sequence
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
    // Ports are only probed once qemu is gone — never while it's still alive —
    // and BOTH the raw RFB port and the websockify ws port must be released.
    expect(portFree).toHaveBeenCalledTimes(2);
    expect(portFree).toHaveBeenNthCalledWith(1, "127.0.0.1", 5901);
    expect(portFree).toHaveBeenNthCalledWith(2, "127.0.0.1", 6080);
  });

  it("keeps waiting if qemu is gone and 5901 is free but websockify still holds 6080", async () => {
    const { shell } = makePgrepShell([{ code: 1, stdout: "" }]);
    let wsProbes = 0;
    const portFree = vi.fn(async (_host: string, port: number) => {
      if (port === 5901) return true;
      wsProbes += 1;
      return wsProbes >= 3; // 6080 stays bound for two polls, then frees
    });
    await waitUntilDead(shell, 5000, { portFree, pollIntervalMs: 0 });
    expect(wsProbes).toBe(3);
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
    // qemu is matched by argv path with the [c]haracter-class self-exclusion
    // trick (NOT -x: the time-shim wrapper's comm is sh/dash pre-exec).
    expect(cmdline).toContain("pkill -9 -f '[q]emu-pebble'");
    // It must NOT use the old comm-exact form that misses the wrapper.
    expect(cmdline).not.toContain("pkill -9 -x qemu-pebble");
    // websockify/emu-control use the same [c]haracter-class self-exclusion trick.
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

  it("makeNativeBootDeps bootControl detaches with nohup, dropping setsid on macOS", async () => {
    const deps = makeNativeBootDeps();
    await deps.bootControl("basalt");
    const call = calls.find(
      (c) => c.cmd === "bash" && String(c.args[1]).includes("emu-control"),
    );
    expect(call).toBeDefined();
    const wrapped = call!.args[1];
    expect(wrapped).toContain("nohup bash -lc");
    expect(wrapped).toContain("pebble emu-control --emulator basalt --vnc");
    // macOS has no `setsid`; Node's detached spawn already makes the outer bash a
    // session leader. Elsewhere (Linux/WSL) the explicit setsid is kept.
    if (process.platform === "darwin") {
      expect(wrapped).not.toContain("setsid");
    } else {
      expect(wrapped).toContain("setsid nohup");
    }
  });

  it("makeNativeBootDeps ensureKeymap is a no-op on macOS (SDK ships en-us)", async () => {
    const deps = makeNativeBootDeps();
    await deps.ensureKeymap();
    if (process.platform === "darwin") {
      expect(calls.length).toBe(0);
    } else {
      expect(calls.some((c) => c.cmd === "bash")).toBe(true);
    }
  });

  it("bootEmulator runs the lifecycle in order using injected fake deps (no spawning)", async () => {
    const order: string[] = [];
    const endpoint = await bootEmulator("basalt", {
      killAll: async () => { order.push("killAll"); },
      ensureKeymap: async () => { order.push("ensureKeymap"); },
      bootControl: async () => { order.push("bootControl"); },
      diagnose: NOPROBE,
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
        diagnose: NOPROBE,
        readBootLog: async () => "",
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

  it("does NOT retry when the first attempt aborts via BootAborted (cancel), but tears down the raced stack", async () => {
    const bootControl = vi.fn(async () => {});
    const killAll = vi.fn(async () => {});
    await expect(
      bootEmulator("basalt", {
        killAll,
        ensureKeymap: async () => {},
        bootControl,
        diagnose: NOPROBE,
        readBootLog: async () => "",
        // Simulates the real token-aware wait: cancel surfaces as BootAborted.
        waitForEmuInfo: async () => { throw new BootAborted(); },
        waitForPort: async () => {},
      }),
    ).rejects.toBeInstanceOf(BootAborted);
    expect(bootControl).toHaveBeenCalledTimes(1); // no retry launch
    // Initial teardown + a best-effort cleanup of the stack this attempt spawned
    // before the abort — so a cancelled boot never orphans qemu/pypkjs/websockify.
    expect(killAll).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry when the token is cancelled even if the failure is a plain Error", async () => {
    const token = { cancelled: false };
    const bootControl = vi.fn(async () => {});
    await expect(
      bootEmulator("basalt", {
        killAll: async () => {},
        ensureKeymap: async () => {},
        bootControl,
        diagnose: NOPROBE,
        readBootLog: async () => "",
        waitForEmuInfo: async () => {
          token.cancelled = true; // cancel lands mid-wait…
          throw new Error("socket torn down"); // …but surfaces as a generic error
        },
        waitForPort: async () => {},
      }, token),
    ).rejects.toThrow("socket torn down");
    expect(bootControl).toHaveBeenCalledTimes(1);
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

describe("pollUntil (adaptive readiness cadence)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects a condition true at t=150ms by ~200ms (hot 100ms cadence, not 300ms)", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const checkedAt: number[] = [];
    let ready = false;
    const p = pollUntil(
      () => { checkedAt.push(Date.now() - t0); return ready; },
      { timeoutMs: 60_000 },
    );
    // Hot phase: checks fire at t=0 and t=100 (both false).
    await vi.advanceTimersByTimeAsync(120);
    expect(checkedAt).toEqual([0, 100]);
    // Condition becomes true at ~t=150; the NEXT hot check (t=200) sees it — a
    // fixed 300ms cadence would not check until t=300, so this is ~100ms sooner.
    ready = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeUndefined();
    expect(checkedAt).toEqual([0, 100, 200]);
  });

  it("drops from the 100ms hot cadence to 300ms after 1.5s", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const checkedAt: number[] = [];
    const p = pollUntil(
      () => { checkedAt.push(Date.now() - t0); return false; },
      { timeoutMs: 2_000 },
    );
    const assertion = expect(p).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(2_150);
    await assertion;
    const diffs = checkedAt.slice(1).map((v, i) => v - checkedAt[i]);
    // Every gap taken while elapsed < 1500ms is the 100ms hot interval…
    for (let i = 0; i < checkedAt.length - 1; i++) {
      expect(diffs[i]).toBe(checkedAt[i] < 1500 ? 100 : 300);
    }
    // …and the cadence really did reach the 300ms steady state.
    expect(diffs.some((d) => d === 300)).toBe(true);
  });

  it("honors a custom timeoutMessage when the deadline elapses", async () => {
    vi.useFakeTimers();
    const p = pollUntil(() => false, { timeoutMs: 1_000, timeoutMessage: "no soup for you" });
    const assertion = expect(p).rejects.toThrow("no soup for you");
    await vi.advanceTimersByTimeAsync(1_200);
    await assertion;
  });

  it("evaluates fn at least once even when timeoutMs is already 0-ish", async () => {
    let calls = 0;
    // Real timers here: with timeoutMs≈0 the very first fn call satisfies it.
    await expect(pollUntil(() => { calls += 1; return true; }, { timeoutMs: 0 })).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("aborts within one interval with BootAborted when the token flips mid-wait", async () => {
    vi.useFakeTimers();
    const token = { cancelled: false };
    const p = pollUntil(() => false, { timeoutMs: 60_000, token });
    const assertion = expect(p).rejects.toBeInstanceOf(BootAborted);
    await vi.advanceTimersByTimeAsync(250); // a couple of hot polls, still running
    token.cancelled = true;
    await vi.advanceTimersByTimeAsync(150); // next poll observes the cancel
    await assertion;
  });

  it("throws BootAborted immediately if the token is already cancelled at entry", async () => {
    let calls = 0;
    await expect(
      pollUntil(() => { calls += 1; return true; }, { timeoutMs: 60_000, token: { cancelled: true } }),
    ).rejects.toBeInstanceOf(BootAborted);
    expect(calls).toBe(0); // bailed before evaluating fn
  });

  it("BootAborted wins over the timeout when both land during an in-flight probe", async () => {
    // Regression: the OLD gate loops checked the token BEFORE the deadline on
    // every failed probe. A probe that is still in flight when BOTH cancellation
    // and the deadline occur must therefore surface as BootAborted (a user stop),
    // never the generic timeout Error (a boot failure the caller would retry).
    vi.useFakeTimers();
    const token = { cancelled: false };
    const p = pollUntil(
      // Async probe that resolves false at t=150ms — past the 100ms deadline —
      // with the token having flipped while it was in flight.
      () => new Promise<boolean>((resolve) => {
        setTimeout(() => { token.cancelled = true; resolve(false); }, 150);
      }),
      { timeoutMs: 100, token },
    );
    const assertion = expect(p).rejects.toBeInstanceOf(BootAborted);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });
});

describe("makeDiagnose + fmtProbe (boot health probe)", () => {
  it("runs ONE quote-free one-liner (survives the WSL double-shell-hop)", async () => {
    let captured = "";
    const shell = {
      run: async (cmd: string) => { captured = cmd; return { code: 0, stdout: "q0 i0 r0 w0", stderr: "" }; },
      spawnDetached: async () => {},
    };
    await makeDiagnose(shell)();
    // The command crosses `wsl.exe -- bash -lc "'bash' '-lc' '<cmd>'"` on Windows,
    // so per the hard-won rule it MUST contain zero single/double quotes.
    expect(captured).not.toMatch(/['"]/);
    // qemu matched by argv path (catches the sh/dash time-shim wrapper that -x
    // misses), kept quote-free + glob-safe via `set -f` + a [q] character class.
    expect(captured).toContain("pgrep -f [q]emu-pebble");
    expect(captured).toContain("set -f");
    expect(captured).not.toContain("pgrep -x qemu-pebble");
  });

  it("parses the q/i/r/w flags into a BootProbe", async () => {
    const shell = {
      run: async () => ({ code: 0, stdout: "q1 i0 r1 w0\n", stderr: "" }),
      spawnDetached: async () => {},
    };
    expect(await makeDiagnose(shell)()).toEqual({
      qemuAlive: true, stateFile: false, rfbOpen: true, wsOpen: false,
    });
  });

  it("reports all-false when the probe shell errors (degraded but safe)", async () => {
    const shell = {
      run: async () => { throw new Error("shell gone"); },
      spawnDetached: async () => {},
    };
    expect(await makeDiagnose(shell)()).toEqual({
      qemuAlive: false, stateFile: false, rfbOpen: false, wsOpen: false,
    });
  });

  it("fmtProbe renders ✓/✗ per component", () => {
    expect(fmtProbe({ qemuAlive: true, stateFile: false, rfbOpen: true, wsOpen: false }))
      .toBe("qemu ✓ · state-file ✗ · RFB:5901 ✓ · ws:6080 ✗");
  });

  it("extractBootErrors pulls error lines out of an ANSI-art boot log", () => {
    const ESC = String.fromCharCode(27);
    const log = [
      `${ESC}[7m  ${ESC}[0m${ESC}[49m  ${ESC}[0m`, // screen block-art (noise)
      "Booting emery…",                              // informational (not an error)
      "qemu-pebble: -vnc :1: Failed to find an available port: Address already in use",
      `${ESC}[7m  ${ESC}[0m`,
    ].join("\n");
    const out = extractBootErrors(log);
    expect(out).toContain("Address already in use");
    expect(out).not.toContain("Booting"); // non-error lines are dropped
    expect(out).not.toMatch(/\x1b/); // ANSI stripped
  });

  it("extractBootErrors returns empty when the log has no error lines", () => {
    expect(extractBootErrors("Booting…\nrendering watch\n")).toBe("");
    expect(extractBootErrors("")).toBe("");
  });
});

describe("bootEmulator retry-once", () => {
  it("retries once after a readiness failure: clean kill, relaunch, resolves", async () => {
    const killAll = vi.fn(async () => {});
    const bootControl = vi.fn(async () => {});
    let emuInfoCalls = 0;
    const steps: string[] = [];
    const endpoint = await bootEmulator(
      "basalt",
      {
        killAll,
        ensureKeymap: async () => {},
        bootControl,
        diagnose: NOPROBE,
        readBootLog: async () => "",
        waitForEmuInfo: async () => {
          emuInfoCalls += 1;
          // The connect-after-marker race: first wait stalls out, second is fine.
          if (emuInfoCalls === 1) throw new Error("timeout waiting for emulator info for basalt");
        },
        waitForPort: async () => {},
      },
      undefined,
      (msg) => steps.push(msg),
    );
    expect(endpoint).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
    expect(bootControl).toHaveBeenCalledTimes(2); // initial launch + 1 retry launch
    expect(killAll).toHaveBeenCalledTimes(2); // initial teardown + pre-retry clean kill
    expect(steps.some((s) => /retry/i.test(s))).toBe(true);
    expect(steps[steps.length - 1]).toBe("Ready");
  });

  it("restore hook: attempt 1 threads the incoming URI to bootControl; a failed restore retries cold", async () => {
    // beforeAttempt returns a migration URI on attempt 1, null afterwards (the
    // real manager also invalidates the bundle there). The restore attempt "fails"
    // its readiness wait; the cold retry succeeds.
    const seenIncoming: (string | null | undefined)[] = [];
    const beforeAttempt = vi.fn(async (attempt: number, _board: string) =>
      attempt === 1 ? "file:C:/snap/vm.migr" : null,
    );
    const bootControl = vi.fn(async (_id: string, incoming?: string | null) => { seenIncoming.push(incoming); });
    let emuInfoCalls = 0;
    const endpoint = await bootEmulator(
      "basalt",
      {
        killAll: async () => {},
        ensureKeymap: async () => {},
        bootControl,
        restore: { beforeAttempt },
        diagnose: NOPROBE,
        readBootLog: async () => "",
        waitForEmuInfo: async () => {
          emuInfoCalls += 1;
          if (emuInfoCalls === 1) throw new Error("restore boot stalled"); // fail attempt 1
        },
        waitForPort: async () => {},
      },
      undefined,
      () => {},
    );
    expect(endpoint).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
    expect(beforeAttempt.mock.calls.map((c) => c[0])).toEqual([1, 2]); // per-attempt
    expect(seenIncoming).toEqual(["file:C:/snap/vm.migr", null]); // restore then cold
  });

  it("after MAX_BOOT_ATTEMPTS stalls, wipes and retries once — recovering", async () => {
    const bootControl = vi.fn(async () => {});
    const killAll = vi.fn(async () => {});
    const wipe = vi.fn(async () => {});
    let calls = 0;
    const steps: string[] = [];
    const endpoint = await bootEmulator(
      "basalt",
      {
        killAll,
        ensureKeymap: async () => {},
        bootControl,
        diagnose: NOPROBE,
        readBootLog: async () => "",
        wipe,
        // First 3 attempts stall (corrupt-flash signature); the post-wipe 4th is fine.
        waitForEmuInfo: async () => { calls += 1; if (calls <= 3) throw new Error("state file never appeared"); },
        waitForPort: async () => {},
      },
      undefined,
      (m) => steps.push(m),
    );
    expect(endpoint).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
    expect(bootControl).toHaveBeenCalledTimes(4); // 3 normal + 1 post-wipe
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledTimes(4); // initial + 2 inter-retry + 1 pre-wipe
    expect(steps.some((s) => /wiping/i.test(s))).toBe(true);
    expect(steps[steps.length - 1]).toBe("Ready (recovered after wipe)");
  });

  it("propagates the last failure when even the wipe recovery fails", async () => {
    const bootControl = vi.fn(async () => {});
    const wipe = vi.fn(async () => {});
    await expect(
      bootEmulator("basalt", {
        killAll: async () => {},
        ensureKeymap: async () => {},
        bootControl,
        diagnose: NOPROBE,
        readBootLog: async () => "",
        wipe,
        waitForEmuInfo: async () => { throw new Error("still stuck"); },
        waitForPort: async () => {},
      }),
    ).rejects.toThrow("still stuck");
    expect(bootControl).toHaveBeenCalledTimes(4); // 3 normal + 1 post-wipe recovery
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("does NOT wipe when no wipe dep is provided (propagates after 3 attempts)", async () => {
    const bootControl = vi.fn(async () => {});
    await expect(
      bootEmulator("basalt", {
        killAll: async () => {},
        ensureKeymap: async () => {},
        bootControl,
        diagnose: NOPROBE,
        readBootLog: async () => "",
        wipe: undefined, // explicitly no wipe dep → no recovery escalation
        waitForEmuInfo: async () => { throw new Error("still stuck"); },
        waitForPort: async () => {},
      }),
    ).rejects.toThrow("still stuck");
    expect(bootControl).toHaveBeenCalledTimes(3);
  });
});

describe("bootEmulator pre-spawn probes run concurrently", () => {
  /** Minimal external-resolvable deferred (no library) for overlap assertions. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const DEAD_PROBE = { qemuAlive: false, stateFile: false, rfbOpen: false, wsOpen: false };

  it("starts diagnose AND preflight before either resolves (overlap, not sequential)", async () => {
    let diagnoseStarted = false;
    let preflightStarted = false;
    const diagD = deferred<typeof DEAD_PROBE>();
    const preD = deferred<void>();

    const boot = bootEmulator("basalt", {
      killAll: async () => {},
      ensureKeymap: async () => {},
      bootControl: async () => {},
      waitForEmuInfo: async () => {},
      waitForPort: async () => {},
      diagnose: () => { diagnoseStarted = true; return diagD.promise; },
      preflight: () => { preflightStarted = true; return preD.promise; },
    });

    // Let the boot reach the probe stage and start BOTH probes. Neither deferred
    // has resolved yet, so a SEQUENTIAL impl (await diagnose, then preflight) would
    // still be blocked inside diagnose and never have started preflight.
    await new Promise((r) => setTimeout(r, 30));
    expect(diagnoseStarted).toBe(true);
    expect(preflightStarted).toBe(true);

    // Release both; the boot completes.
    diagD.resolve(DEAD_PROBE);
    preD.resolve();
    await expect(boot).resolves.toEqual({ host: "localhost", port: 6080, wsPath: "/" });
  });

  it("probe wall-clock ≈ max(diagnose, preflight), not their sum", async () => {
    const SLEEP = 120;
    const start = Date.now();
    await bootEmulator("basalt", {
      killAll: async () => {},
      ensureKeymap: async () => {},
      bootControl: async () => {},
      waitForEmuInfo: async () => {},
      waitForPort: async () => {},
      diagnose: async () => { await new Promise((r) => setTimeout(r, SLEEP)); return DEAD_PROBE; },
      preflight: async () => { await new Promise((r) => setTimeout(r, SLEEP)); },
    });
    const elapsed = Date.now() - start;
    // Parallel ⇒ ~one SLEEP; sequential ⇒ ~two. Ceiling well below the sum.
    expect(elapsed).toBeLessThan(SLEEP * 1.8);
  });

  it("still surfaces a foreign-port preflight error (propagates, not swallowed)", async () => {
    await expect(
      bootEmulator("basalt", {
        killAll: async () => {},
        ensureKeymap: async () => {},
        bootControl: async () => {},
        waitForEmuInfo: async () => {},
        waitForPort: async () => {},
        diagnose: async () => DEAD_PROBE,
        preflight: async () => { throw new Error("Emulator port 5901 is already in use by another process — likely a WSL Pebble emulator or a second Pebble Studio instance. Close it, then try again."); },
      }),
    ).rejects.toThrow(/already in use by another process/);
  });
});

describe("bootControl wrapper routing (PEBBLE_QEMU_PATH)", () => {
  beforeEach(() => {
    calls.length = 0;
    stdoutFor = () => "";
    exitCode = 0;
    _resetShimState();
  });

  afterEach(() => {
    _resetShimState(); // never leak shim readiness into other suites
  });

  it("prefixes the cmdline with PEBBLE_QEMU_PATH=<wrapper> when the shim is ready", async () => {
    // Flip the readiness cache true via the real ensureTimeShim path with a fake
    // runner whose self-test output is exactly now+86400 (a passing self-test).
    const nowMs = 1_750_000_000_000;
    const selfTestOut = String(Math.floor(nowMs / 1000) + 86400);
    const ok = await ensureTimeShim(
      async () => ({ code: 0, stdout: selfTestOut, stderr: "" }),
      {
        resources: async () => ({ so: Buffer.from("so"), src: Buffer.from("src") }),
        now: () => nowMs,
      },
    );
    expect(ok).toBe(true);

    calls.length = 0;
    const deps = makeNativeBootDeps();
    await deps.bootControl("basalt");
    const call = calls.find((c) => c.cmd === "bash" && String(c.args[1]).includes("emu-control"));
    expect(call).toBeDefined();
    const wrapped = String(call!.args[1]);
    expect(wrapped).toContain(
      `PEBBLE_QEMU_PATH=${WRAPPER} pebble emu-control --emulator basalt --vnc`,
    );
    expect(WRAPPER).toBe("$HOME/.pebble-studio/qemu-pebble");
  });

  it("resets the fake-clock control file to real time before launching qemu", async () => {
    // The shim anchors to real time at process start, so a relative "-" target
    // read at realize seeds the f2xx RTC correctly; without this reset a prior
    // session's absolute System write would be re-read one boot stale.
    const nowMs = 1_750_000_000_000;
    const selfTestOut = String(Math.floor(nowMs / 1000) + 86400);
    await ensureTimeShim(
      async () => ({ code: 0, stdout: selfTestOut, stderr: "" }),
      { resources: async () => ({ so: Buffer.from("so"), src: Buffer.from("src") }), now: () => nowMs },
    );

    calls.length = 0;
    const deps = makeNativeBootDeps();
    await deps.bootControl("basalt");

    const resetIdx = calls.findIndex((c) => String(c.args[1]).startsWith("echo - 1"));
    const bootIdx = calls.findIndex((c) => String(c.args[1]).includes("emu-control"));
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(bootIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeLessThan(bootIdx);
    // Never a bare "0" rate — that re-enters the firmware minute-tick loop.
    expect(String(calls[resetIdx].args[1])).toContain("1.000000");
  });

  it("does not touch the control file when the shim is not ready", async () => {
    calls.length = 0;
    const deps = makeNativeBootDeps();
    await deps.bootControl("basalt");
    expect(calls.some((c) => String(c.args[1]).startsWith("echo - 1"))).toBe(false);
  });

  it("uses no prefix when the shim is not ready", async () => {
    const deps = makeNativeBootDeps();
    await deps.bootControl("basalt");
    const call = calls.find((c) => c.cmd === "bash" && String(c.args[1]).includes("emu-control"));
    expect(call).toBeDefined();
    const wrapped = String(call!.args[1]);
    expect(wrapped).toContain("pebble emu-control --emulator basalt --vnc");
    expect(wrapped).not.toContain("PEBBLE_QEMU_PATH");
  });
});
