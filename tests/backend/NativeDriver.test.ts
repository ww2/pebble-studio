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
    expect(boot).toHaveBeenCalledWith("basalt");
    expect(ep).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
    await d.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("converts setTime('system') to an HH:MM:SS string (not ISO)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.setTime("system");
    const timeArg = calls[0][calls[0].length - 1];
    expect(timeArg).toMatch(/^\d{2}:\d{2}:\d{2}$/);  // HH:MM:SS, never an ISO 'T'
  });
});
