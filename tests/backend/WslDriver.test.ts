import { describe, it, expect, vi, beforeEach } from "vitest";
import { WslDriver } from "../../src/main/backend/WslDriver.js";
import { _resetShimState } from "../../src/main/backend/timeShim.js";

describe("WslDriver", () => {
  it("runs discrete commands via a wsl.exe login shell so PATH finds pebble", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WslDriver({ run });
    d.setPlatform("chalk");
    await d.button("up", "press");
    expect(calls[0].cmd).toBe("wsl.exe");
    expect(calls[0].args.slice(0, 3)).toEqual(["--", "bash", "-lc"]);
    // The pebble invocation is the quoted command line passed to `bash -lc`.
    const cmdline = calls[0].args[3];
    expect(cmdline).toContain("pebble");
    expect(cmdline).toContain("emu-button");
    expect(cmdline).toContain("up");
  });

  it("injects --vnc into emulator commands (so the WSL emulator isn't torn down)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WslDriver({ run });
    d.setPlatform("basalt");
    await d.button("select", "press");
    // --vnc lives inside the `bash -lc` command line (args[3]).
    expect(calls[0][3]).toContain("--vnc");
  });

  it("threads injected boot/stop into the inner driver (used on a Windows host)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const boot = vi.fn(async (_id: string) => ({ host: "ignored", port: 6080, wsPath: "/" }));
    const stop = vi.fn(async () => {});
    const d = new WslDriver({ run, boot, stop });
    const token = { cancelled: false };
    const ep = await d.start("basalt", token);
    // The cancellation token threads through to the inner boot fn unchanged;
    // onStep is undefined here.
    expect(boot).toHaveBeenCalledWith("basalt", token, undefined);
    // WslDriver forces host back to localhost (WSL2 forwards to the Windows host).
    expect(ep.host).toBe("localhost");
    await d.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("translates a Windows .pbw path to /mnt/... before it crosses into WSL", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WslDriver({ run });
    d.setPlatform("basalt");
    await d.install("C:\\Users\\Jane Doe\\My Watch.pbw");
    // The translated path lives inside the `bash -lc` command line (args[3]).
    const cmdline = calls[0][3];
    expect(cmdline).toContain("/mnt/c/Users/Jane Doe/My Watch.pbw");
    expect(cmdline).not.toContain("C:");
  });

  it("rejects on non-zero exit", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "wsl boom" }));
    const d = new WslDriver({ run });
    d.setPlatform("basalt");
    await expect(d.install("/x.pbw")).rejects.toThrow(/wsl boom/);
  });

  describe("setFakeTime", () => {
    it("crosses as wsl.exe -- bash -lc with a quote-free inner cmdline", async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
      const d = new WslDriver({ run });
      await d.setFakeTime(123456, 0);
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("wsl.exe");
      expect(calls[0].args.slice(0, 3)).toEqual(["--", "bash", "-lc"]);
      // The outer cmdline passed to bash -lc (the wsl wrapper)
      const outerCmdline = calls[0].args[3];
      // Must contain the inner bash -lc invocation
      expect(outerCmdline).toContain("bash");
      expect(outerCmdline).toContain("-lc");
      // Must reference the ctl path and the target/rate values
      expect(outerCmdline).toContain("123456");
      expect(outerCmdline).toContain("pb-faketime.ctl");
      // Quote-free inner cmdline: the only quotes are the wrapper's own shQuote
      // layer ('token' …). An inner quote would show up as the '\'' escape
      // sequence — exactly what mangled setTzOffset on Windows before v0.0.12.
      expect(outerCmdline).not.toContain(`'\\''`);
      expect(outerCmdline).not.toContain('"');
    });

    it("does NOT throw on nonzero exit", async () => {
      const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "error" }));
      const d = new WslDriver({ run });
      await expect(d.setFakeTime(123456, 0)).resolves.toBeUndefined();
    });
  });

  describe("ensureTimeShim", () => {
    beforeEach(() => {
      _resetShimState();
    });

    it("delegates ensureTimeShim to the inner driver (crosses wsl.exe)", async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      const nowSec = Math.floor(Date.now() / 1000);
      const run = vi.fn(async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        // The wsl runner receives wsl.exe -- bash -lc <cmdline>
        // We need to satisfy the self-test inside
        if (cmd === "wsl.exe" && args[3]?.includes("date +%s")) {
          return { code: 0, stdout: String(nowSec + 86400), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const d = new WslDriver({ run });
      const result = await d.ensureTimeShim();
      expect(typeof result).toBe("boolean");
      // All calls must go through wsl.exe
      const wslCalls = calls.filter(c => c.cmd === "wsl.exe");
      expect(wslCalls.length).toBeGreaterThan(0);
      // Each wsl.exe call uses bash -lc
      for (const c of wslCalls) {
        expect(c.args.slice(0, 3)).toEqual(["--", "bash", "-lc"]);
      }
    });
  });
});
