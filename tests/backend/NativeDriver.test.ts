import { describe, it, expect, vi } from "vitest";
import { NativeDriver } from "../../src/main/backend/NativeDriver.js";

describe("NativeDriver", () => {
  it("runs the install command via the injected runner", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.install("/apps/face.pbw");
    expect(calls[0].cmd).toBe("pebble");
    expect(calls[0].args).toContain("install");
    expect(calls[0].args).toContain("/apps/face.pbw");
  });

  it("rejects when the runner returns a non-zero code", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await expect(d.button("select", "press")).rejects.toThrow(/boom/);
  });

  it("start() and stop() use the injected boot/stop deps (no real spawning)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const boot = vi.fn(async () => ({ host: "localhost", port: 6080, wsPath: "/" }));
    const stop = vi.fn(async () => {});
    const d = new NativeDriver({ run, boot, stop });
    const ep = await d.start("basalt");
    // start now threads an optional cancellation token + onStep callback through
    // to boot (both undefined here).
    expect(boot).toHaveBeenCalledWith("basalt", undefined, undefined);
    expect(ep).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
    await d.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("setTime passes epoch + --utc through the runner", async () => {
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.setTime("1700000000", { utc: true });
    expect(calls[0]).toContain("--utc");
    expect(calls[0]).toContain("1700000000");
  });

  it("timeFormat sends --format 24h", async () => {
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.timeFormat(true);
    expect(calls[0]).toEqual(expect.arrayContaining(["emu-time-format", "--format", "24h"]));
  });

  it("wipe() runs pebble wipe with no --emulator flag", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.wipe();
    expect(calls[0].cmd).toBe("pebble");
    expect(calls[0].args).toEqual(["wipe"]);
    expect(calls[0].args).not.toContain("--emulator");
  });
});
