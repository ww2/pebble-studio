import { describe, it, expect, vi } from "vitest";
import { WslDriver } from "../../src/main/backend/WslDriver.js";

describe("WslDriver", () => {
  it("prefixes discrete commands with wsl.exe --", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WslDriver({ run });
    d.setPlatform("chalk");
    await d.button("up", "press");
    expect(calls[0].cmd).toBe("wsl.exe");
    expect(calls[0].args.slice(0, 2)).toEqual(["--", "pebble"]);
    expect(calls[0].args).toContain("emu-button");
    expect(calls[0].args).toContain("up");
  });

  it("injects --vnc into emulator commands (so the WSL emulator isn't torn down)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WslDriver({ run });
    d.setPlatform("basalt");
    await d.button("select", "press");
    expect(calls[0]).toContain("--vnc");
  });

  it("threads injected boot/stop into the inner driver (used on a Windows host)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const boot = vi.fn(async (id: string) => ({ host: "ignored", port: 6080, wsPath: "/" }));
    const stop = vi.fn(async () => {});
    const d = new WslDriver({ run, boot, stop });
    const ep = await d.start("basalt");
    expect(boot).toHaveBeenCalledWith("basalt");
    // WslDriver forces host back to localhost (WSL2 forwards to the Windows host).
    expect(ep.host).toBe("localhost");
    await d.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects on non-zero exit", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "wsl boom" }));
    const d = new WslDriver({ run });
    d.setPlatform("basalt");
    await expect(d.install("/x.pbw")).rejects.toThrow(/wsl boom/);
  });
});
