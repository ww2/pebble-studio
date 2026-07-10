import { describe, it, expect, beforeEach } from "vitest";
import {
  chunkB64, deployFileCmds, wrapperScript, selfTestCmd, compileShimCmd,
  setFakeTimeCmd, parseSelfTest, STUDIO_DIR, CTL_PATH,
  isShimReady, _resetShimState, ensureTimeShim,
} from "../../src/main/backend/timeShim.js";
import { QEMU_FROZEN_RATE } from "../../src/main/backend/timeController.js";

const noQuotes = (s: string) => { expect(s).not.toMatch(/['"]/); };

describe("timeShim command builders", () => {
  it("chunks base64 into ≤4000-char shell-safe pieces", () => {
    const b64 = "A".repeat(9001);
    const chunks = chunkB64(b64);
    expect(chunks.join("")).toBe(b64);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
  });

  it("deployFileCmds emits quote-free append commands ending in decode", () => {
    const cmds = deployFileCmds("timeshim.so", Buffer.from("hello world"));
    for (const c of cmds) noQuotes(c);
    expect(cmds[0]).toContain(`mkdir -p ${STUDIO_DIR}`);
    expect(cmds[cmds.length - 1]).toContain("base64 -d");
  });

  it("deployFileCmds(executable=true) includes chmod +x in the final command", () => {
    const cmds = deployFileCmds("timeshim.so", Buffer.from("bytes"), true);
    const last = cmds[cmds.length - 1];
    expect(last).toContain("chmod +x");
  });

  it("deployFileCmds(executable=false) omits chmod from the final command", () => {
    const cmds = deployFileCmds("timeshim.c", Buffer.from("bytes"), false);
    const last = cmds[cmds.length - 1];
    expect(last).toContain("base64 -d");
    expect(last).not.toContain("chmod");
  });

  it("deployFileCmds defaults to executable=true (backward compat)", () => {
    const cmds = deployFileCmds("timeshim.so", Buffer.from("bytes"));
    expect(cmds[cmds.length - 1]).toContain("chmod +x");
  });

  it("wrapper script execs the current-symlink qemu and exports the control file", () => {
    const w = wrapperScript();
    expect(w).toContain("SDKs/current/toolchain/bin/qemu-pebble");
    expect(w).toContain("PEBBLE_FAKETIME_FILE=");
    expect(w).toMatch(/exec .*qemu-pebble \"\$@\"/);   // quotes OK INSIDE content (it's base64-deployed)
  });

  it("selfTestCmd + compileShimCmd + setFakeTimeCmd are quote-free", () => {
    noQuotes(selfTestCmd());
    noQuotes(compileShimCmd());
    noQuotes(setFakeTimeCmd(1577836800, 0).args[1]);
    noQuotes(setFakeTimeCmd(null, 10).args[1]);
  });

  it("setFakeTimeCmd formats an integer target and a fixed-decimal rate", () => {
    expect(setFakeTimeCmd(1577836800, 2).args[1]).toContain(`echo 1577836800 2.000000 > ${CTL_PATH}`);
    expect(setFakeTimeCmd(null, 1).args[1]).toContain(`echo - 1.000000 > ${CTL_PATH}`);
  });

  it("setFakeTimeCmd truncates a fractional target but preserves a fractional rate", () => {
    expect(setFakeTimeCmd(1577836800.9, 10).args[1]).toContain(`echo 1577836800 10.000000`);
  });

  it("does NOT collapse QEMU_FROZEN_RATE to 0 (Math.trunc would — the frozen-loop bug)", () => {
    // A rate-0 write re-triggers the firmware minute-tick loop; the frozen clock uses
    // the tiny QEMU_FROZEN_RATE (1e-3) instead, which must survive as a non-zero token.
    const arg = setFakeTimeCmd(1577836800, QEMU_FROZEN_RATE).args[1];
    expect(arg).toContain("echo 1577836800 0.001000");
    expect(arg).not.toMatch(/ 0 >/);   // never the bare rate-0 the fix avoids
    noQuotes(arg);                      // digits + "." only → still shell-safe
  });

  it("non-finite rate degrades to a shell-safe 0", () => {
    expect(setFakeTimeCmd(1, Number.NaN).args[1]).toContain("echo 1 0 >");
  });

  it("parseSelfTest accepts ±120s around the expected faked epoch", () => {
    const now = 1_700_000_000;
    expect(parseSelfTest(String(now + 86400), now)).toBe(true);
    expect(parseSelfTest(String(now), now)).toBe(false);
    expect(parseSelfTest("garbage", now)).toBe(false);
  });

  it("parseSelfTest boundary: +120s from expected → true; +121s → false; -121s → false", () => {
    const now = 1_700_000_000;
    const expected = now + 86400;
    expect(parseSelfTest(String(expected + 120), now)).toBe(true);
    expect(parseSelfTest(String(expected + 121), now)).toBe(false);
    expect(parseSelfTest(String(expected - 121), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureTimeShim integration paths (fake runner, no real filesystem access)
// ---------------------------------------------------------------------------

/** Fake runner factory: returns a runner that records cmdlines and plays back
 * canned { code, stdout, stderr } responses in order (last one repeats). */
function makeRunner(
  responses: Array<{ code: number; stdout: string; stderr: string }>,
): { run: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>; calls: string[] } {
  const calls: string[] = [];
  let idx = 0;
  const run = async (cmd: string) => {
    calls.push(cmd);
    const r = responses[Math.min(idx, responses.length - 1)];
    idx++;
    return r;
  };
  return { run, calls };
}

const fakeResources = async () => ({
  so: Buffer.from("fake-so-bytes"),
  src: Buffer.from("fake-src-bytes"),
});

const fakeNow = () => 1_700_000_000 * 1000; // ms → / 1000 = nowSec

describe("ensureTimeShim", () => {
  beforeEach(() => _resetShimState());

  it("success path: deploys so/src/wrapper then self-tests → isShimReady true", async () => {
    const now = fakeNow() / 1000;
    const selfTestOutput = String(now + 86400);
    // All deploy commands succeed; self-test returns the faked epoch
    const { run, calls } = makeRunner([
      { code: 0, stdout: "", stderr: "" },         // deploy commands (repeat)
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: selfTestOutput, stderr: "" }, // selfTest
    ]);
    const result = await ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() });
    expect(result).toBe(true);
    expect(isShimReady()).toBe(true);
    // Verify deploy commands were issued before self-test: so, src, wrapper must all appear
    const allCmds = calls.join("\n");
    expect(allCmds).toContain("timeshim.so");
    expect(allCmds).toContain("timeshim.c");
    expect(allCmds).toContain("qemu-pebble");
    // Last command is the self-test
    expect(calls[calls.length - 1]).toContain("date +%s");
  });

  it("first self-test fails → compileShimCmd issued → second self-test succeeds → true", async () => {
    const now = fakeNow() / 1000;
    const selfTestOutput = String(now + 86400);
    // We need to supply enough responses: many deploy no-ops then a failing selfTest,
    // a compile no-op, then a passing selfTest. Track self-test call count separately
    // so we can distinguish the first from the second.
    let selfTestCount = 0;
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("date +%s")) {
        selfTestCount++;
        if (selfTestCount === 1) {
          // first self-test call: fail (simulates pre-built .so glibc mismatch)
          return { code: 1, stdout: "bad", stderr: "error" };
        }
        // second self-test call (after recompile): succeed
        return { code: 0, stdout: selfTestOutput, stderr: "" };
      }
      // all other commands (deploy, compile): succeed silently
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() });
    expect(result).toBe(true);
    expect(isShimReady()).toBe(true);
    // compileShimCmd should have been called between the two self-tests
    const selfTestIdxs = calls.map((c, i) => (c.includes("date +%s") ? i : -1)).filter(i => i >= 0);
    expect(selfTestIdxs.length).toBe(2);
    const compiledBetween = calls
      .slice(selfTestIdxs[0] + 1, selfTestIdxs[1])
      .some(c => c.includes("timeshim.so") && (c.includes("cc ") || c.includes("gcc ")));
    expect(compiledBetween).toBe(true);
  });

  it("all-fail path: returns false, isShimReady false, no throw", async () => {
    const { run } = makeRunner([{ code: 1, stdout: "bad", stderr: "err" }]);
    let threw = false;
    let result = false;
    try {
      result = await ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe(false);
    expect(isShimReady()).toBe(false);
  });

  it("a FAILED deploy is retryable: next call re-runs and can succeed", async () => {
    // First call: resources loader throws (transient fs/WSL hiccup) → false.
    const badResources = async (): Promise<{ so: Buffer; src: Buffer }> => {
      throw new Error("transient failure");
    };
    expect(await ensureTimeShim(async () => ({ code: 0, stdout: "", stderr: "" }),
      { resources: badResources, now: () => fakeNow() })).toBe(false);
    expect(isShimReady()).toBe(false);
    // Second call (NO reset): must actually retry and succeed this time.
    const selfTestOutput = String(fakeNow() / 1000 + 86400);
    const run = async (cmd: string) =>
      cmd.includes("date +%s")
        ? { code: 0, stdout: selfTestOutput, stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    expect(await ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() })).toBe(true);
    expect(isShimReady()).toBe(true);
  });

  it("resources-throw: returns false, no throw", async () => {
    const badResources = async (): Promise<{ so: Buffer; src: Buffer }> => {
      throw new Error("disk read failure");
    };
    const { run, calls } = makeRunner([{ code: 0, stdout: "", stderr: "" }]);
    let threw = false;
    let result = false;
    try {
      result = await ensureTimeShim(run, { resources: badResources, now: () => fakeNow() });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe(false);
    expect(isShimReady()).toBe(false);
    // No deploy commands should have been issued
    expect(calls.length).toBe(0);
  });

  it("concurrent calls: deploy commands issued exactly once; both resolve to same value", async () => {
    const now = fakeNow() / 1000;
    const selfTestOutput = String(now + 86400);
    // The runner records every call; all commands succeed. Self-test returns valid output.
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("date +%s")) {
        return { code: 0, stdout: selfTestOutput, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // Fire both concurrently without awaiting the first — they must share one Promise.
    const [r1, r2] = await Promise.all([
      ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() }),
      ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() }),
    ]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // Exactly one self-test command should appear in the call log.
    const selfTestCalls = calls.filter(c => c.includes("date +%s"));
    expect(selfTestCalls.length).toBe(1);
    // .c file deploy must NOT contain chmod
    const cFileCmds = calls.filter(c => c.includes("timeshim.c"));
    for (const c of cFileCmds) expect(c).not.toContain("chmod");
    // .so file deploy must contain chmod
    const soDeployCmds = calls.filter(
      c => c.includes("timeshim.so") && c.includes("base64 -d"),
    );
    expect(soDeployCmds.length).toBeGreaterThan(0);
    for (const c of soDeployCmds) expect(c).toContain("chmod +x");
  });

  it("second call returns cached result without re-running the runner", async () => {
    const now = fakeNow() / 1000;
    const selfTestOutput = String(now + 86400);
    const { run, calls } = makeRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: selfTestOutput, stderr: "" },
    ]);
    await ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() });
    const callsAfterFirst = calls.length;
    // Second call — should be a cache hit
    await ensureTimeShim(run, { resources: fakeResources, now: () => fakeNow() });
    expect(calls.length).toBe(callsAfterFirst); // no new calls
    expect(isShimReady()).toBe(true);
  });
});
