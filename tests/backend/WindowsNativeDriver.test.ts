import { describe, it, expect, vi } from "vitest";
import { WindowsNativeDriver } from "../../src/main/backend/WindowsNativeDriver.js";

const ep = { host: "localhost", port: 6080, wsPath: "/" };

describe("WindowsNativeDriver", () => {
  it("runs discrete pebble commands via a plain runner (no bash wrapping)", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.button("up", "press");
    expect(calls[0].cmd).toBe("pebble");                 // resolves to pebble.exe at spawn time
    expect(calls[0].args).toContain("emu-button");
    expect(calls[0].args).toContain("up");
    expect(calls[0].args).toContain("--vnc");            // inner NativeDriver still injects --vnc
    expect(calls[0].args).not.toContain("-lc");          // NOT wrapped in bash -lc
  });

  it("normalizes a Windows .pbw path with winPath on install (no /mnt translation)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.install("C:/Users/Jane Doe/My Watch.pbw");
    expect(calls[0]).toContain("C:\\Users\\Jane Doe\\My Watch.pbw");
  });

  it("reports the time shim as unavailable (no LD_PRELOAD on Windows)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    expect(await d.ensureTimeShim()).toBe(false);
  });

  it("setFakeTime is a no-op that resolves (legacy utc_offset path drives time)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.setFakeTime(123, 0)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("setTzOffset runs the python helper argv when paths are configured", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WindowsNativeDriver({
      run, boot: async () => ep, stop: async () => {},
      timeHelper: { pythonExe: "C:\\py\\python.exe", helperPath: "C:\\h\\pb-set-tz.py" },
    });
    await d.setTzOffset(-240, "America/New_York");
    expect(calls[0].cmd).toBe("C:\\py\\python.exe");
    expect(calls[0].args).toEqual(["C:\\h\\pb-set-tz.py", "-240", "America/New_York"]);
  });

  it("setTzOffset is a no-op (no throw) when the helper paths are not configured", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.setTzOffset(540, "Asia/Tokyo")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("threads the cancellation token + onStep into the injected boot fn", async () => {
    const boot = vi.fn(async (_id: string) => ep);
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot, stop: async () => {} });
    const token = { cancelled: false };
    const step = () => {};
    await d.start("basalt", token, step);
    expect(boot).toHaveBeenCalledWith("basalt", token, step);
  });

  it("forces the VNC endpoint host to localhost regardless of the boot fn", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const boot = vi.fn(async () => ({ host: "192.168.1.50", port: 6080, wsPath: "/" }));
    const d = new WindowsNativeDriver({ run, boot, stop: async () => {} });
    const result = await d.start("basalt", { cancelled: false });
    expect(result.host).toBe("localhost");
    expect(result.port).toBe(6080);
  });
});
