import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WindowsNativeDriver,
  healthRetryDecision,
  HEALTH_ACTIVATE_MAX_ATTEMPTS,
  HEALTH_ACTIVATE_READY_MS,
  BATTERY_PUSH_MAX_ATTEMPTS,
} from "../../src/main/backend/WindowsNativeDriver.js";

const ep = { host: "localhost", port: 6080, wsPath: "/" };

const healthHelper = { pythonExe: "C:\\py\\python.exe", helperPath: join(tmpdir(), "pb-set-tz.py") };

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

  it("streamLogs builds the bundled `pebble logs` command WITH --vnc (without it the tool SIGKILLs the live VNC qemu → boot-crash loop)", () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const logSpawn = vi.fn((cmd: string, args: string[]) => { spawned.push({ cmd, args }); return { kill: () => {} }; });
    const pebble = (args: string[]) => ({ cmd: "C:\\py\\PebbleStudioEmu.exe", args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args], env: {} });
    const d = new WindowsNativeDriver({ run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), pebble, logSpawn, boot: async () => ep, stop: async () => {} });
    d.streamLogs("emery", () => {});
    expect(spawned[0].args).toContain("logs");
    expect(spawned[0].args).toContain("--emulator");
    expect(spawned[0].args).toContain("emery");
    expect(spawned[0].args).toContain("--vnc");
  });

  it("streamLogs prefers the input channel (viaChannel, no CLI spawn) when available (#6)", () => {
    const kill = vi.fn();
    const streamAppLogs = vi.fn(() => ({ kill }));
    const inputChannel = { streamAppLogs } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const logSpawn = vi.fn(() => ({ kill: () => {} }));
    const d = new WindowsNativeDriver({ run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), logSpawn, boot: async () => ep, stop: async () => {}, inputChannel });

    const h = d.streamLogs("emery", () => {});
    expect(h?.viaChannel).toBe(true);
    expect(streamAppLogs).toHaveBeenCalledTimes(1);
    expect(logSpawn).not.toHaveBeenCalled();
    h!.kill();
    expect(kill).toHaveBeenCalled();
  });

  it("streamLogs falls back to the CLI stream when the channel is unavailable (#6)", () => {
    const streamAppLogs = vi.fn(() => null); // not booted / helper dead
    const inputChannel = { streamAppLogs } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const spawned: { cmd: string; args: string[] }[] = [];
    const logSpawn = vi.fn((cmd: string, args: string[]) => { spawned.push({ cmd, args }); return { kill: () => {} }; });
    const d = new WindowsNativeDriver({ run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), logSpawn, boot: async () => ep, stop: async () => {}, inputChannel });

    const h = d.streamLogs("emery", () => {});
    expect(h?.viaChannel).toBeUndefined();
    expect(spawned[0].args).toContain("logs");
  });

  it("routes discrete pebble commands through the injected bundled invocation (python + run_tool + env)", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const run = vi.fn(async (cmd: string, args: string[], env?: Record<string, string>) => { calls.push({ cmd, args, env }); return { code: 0, stdout: "", stderr: "" }; });
    const pebble = (args: string[]) => ({
      cmd: "C:\\py\\python.exe",
      args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
      env: { PEBBLE_QEMU_PATH: "C:\\q\\qemu-pebble.exe", XDG_DATA_HOME: "C:\\data\\pebble-data" },
    });
    const d = new WindowsNativeDriver({ run, pebble, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.button("up", "press");
    expect(calls[0].cmd).toBe("C:\\py\\python.exe");
    expect(calls[0].args.slice(0, 2)).toEqual(["-c", "from pebble_tool import run_tool; run_tool()"]);
    expect(calls[0].args).toContain("emu-button");
    expect(calls[0].args).toContain("--vnc");           // inner NativeDriver still injects --vnc
    expect(calls[0].env?.PEBBLE_QEMU_PATH).toBe("C:\\q\\qemu-pebble.exe");
  });

  it("normalizes a Windows .pbw path with winPath on install (no /mnt translation)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.install("C:/Users/Jane Doe/My Watch.pbw");
    expect(calls[0]).toContain("C:\\Users\\Jane Doe\\My Watch.pbw");
  });

  it("reports the time shim as unavailable when no timeShim dep is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    expect(await d.ensureTimeShim()).toBe(false);
  });

  describe("battery push — first-boot bridge-readiness retry", () => {
    it("retries emu-battery across the settling window, then succeeds (error never surfaces)", async () => {
      let batteryCalls = 0;
      const run = vi.fn(async (_c: string, args: string[]) => {
        if (args.includes("emu-battery")) {
          batteryCalls++;
          // Bridge not ready for the first two attempts (libpebble2 TimeoutError),
          // then settles and succeeds — exactly the first-boot race.
          return batteryCalls < 3
            ? { code: 1, stdout: "", stderr: "libpebble2.exceptions.TimeoutError" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const sleep = vi.fn(async () => {});
      const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, sleep });
      d.setPlatform("emery");
      await expect(d.battery(31, false)).resolves.toBeUndefined();
      expect(batteryCalls).toBe(3);
      expect(sleep).toHaveBeenCalledTimes(2); // one delay between each of the 3 attempts
    });

    it("after exhausting attempts throws a FRIENDLY message — never the raw libpebble2 traceback", async () => {
      const run = vi.fn(async (_c: string, args: string[]) =>
        args.includes("emu-battery")
          ? { code: 1, stdout: "", stderr: "Traceback (most recent call last): libpebble2.exceptions.TimeoutError" }
          : { code: 0, stdout: "", stderr: "" },
      );
      const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, sleep: async () => {} });
      d.setPlatform("emery");
      const err = await d.battery(31, false).then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toMatch(/Traceback|libpebble2/);
      expect(err!.message).toMatch(/starting up/i);
      const batteryCalls = run.mock.calls.filter((c) => (c[1] as string[]).includes("emu-battery")).length;
      expect(batteryCalls).toBe(BATTERY_PUSH_MAX_ATTEMPTS);
    });
  });

  it("setFakeTime is a no-op that resolves when no timeShim dep is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.setFakeTime(123, 0)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  describe("with the custom-time control file wired", () => {
    // Custom time is built into the bundled qemu-pebble.exe (the Pebble RTC reads
    // the control file directly), so it's ALWAYS available when a ctlPath is wired
    // — no DLL files to probe, no self-test, no AV-blockable injection.
    it("ensureTimeShim is true whenever a control file is wired", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new WindowsNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeShim: { ctlPath: join(tmpdir(), "pb-faketime-test.ctl") },
      });
      expect(await d.ensureTimeShim()).toBe(true);
    });

    it("resets the control file to '- 1' at BOOT (before qemu realizes) and truncates the diagnostic log", async () => {
      const ctlPath = join(tmpdir(), `pb-faketime-boot-${process.pid}.ctl`);
      const ftLogPath = join(tmpdir(), `pb-qemu-ft-boot-${process.pid}.log`);
      // Seed a stale custom target + a fat log from a prior session.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(ctlPath, "1577836800 0.001");
      await writeFile(ftLogPath, "x".repeat(5000));
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new WindowsNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeShim: { ctlPath, ftLogPath },
      });
      await d.start("basalt", { cancelled: false });
      // A fresh qemu anchors "-" to real time, so "- 1" reads as real time (the
      // stale custom target is gone) while keeping the f2xx boot-seed correct.
      expect(await readFile(ctlPath, "utf8")).toBe("- 1");
      expect(await readFile(ftLogPath, "utf8")).toBe(""); // truncated per boot
      await rm(ctlPath, { force: true });
      await rm(ftLogPath, { force: true });
    });

    it("setFakeTime writes the control file qemu reads ('<target> <rate>')", async () => {
      const ctlPath = join(tmpdir(), `pb-faketime-${process.pid}.ctl`);
      await rm(ctlPath, { force: true });
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new WindowsNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeShim: { ctlPath },
      });
      await d.setFakeTime(1577836800, 0); // freeze at 2020-01-01
      expect(await readFile(ctlPath, "utf8")).toBe("1577836800 0");
      await d.setFakeTime(null, 10); // rate-only
      expect(await readFile(ctlPath, "utf8")).toBe("- 10");
      await rm(ctlPath, { force: true });
    });
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

  describe("activateHealth (readiness-race retry)", () => {
    it("retries a fast not-ready miss, then reports the eventual success", async () => {
      let n = 0;
      const run = vi.fn(async () => {
        n++;
        // First two attempts: state file / pypkjs not ready yet (connection refused),
        // which the helper reports WITHOUT a numeric status. Then it succeeds.
        return n < 3
          ? { code: 1, stdout: "health-activate: error [WinError 10061] refused", stderr: "" }
          : { code: 0, stdout: "health-activate: status=1", stderr: "" };
      });
      const d = new WindowsNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeHelper: healthHelper, sleep: async () => {},
      });
      const r = await d.activateHealth();
      expect(r).toEqual({ ok: true, status: 1, detail: "health-activate: status=1" });
      expect(run).toHaveBeenCalledTimes(3);
    });

    it("returns immediately on a definitive (even non-success) status — no retry", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "health-activate: status=8", stderr: "" }));
      const d = new WindowsNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeHelper: healthHelper, sleep: async () => {},
      });
      const r = await d.activateHealth();
      expect(r.status).toBe(8);
      expect(r.ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("gives up after the attempt cap when the emulator never becomes ready", async () => {
      const run = vi.fn(async () => ({ code: 1, stdout: "health-activate: error refused", stderr: "" }));
      const d = new WindowsNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeHelper: healthHelper, sleep: async () => {},
      });
      const r = await d.activateHealth();
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
      expect(run).toHaveBeenCalledTimes(HEALTH_ACTIVATE_MAX_ATTEMPTS);
    });

    it("is a no-op result when no python helper is provisioned", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
      const r = await d.activateHealth();
      expect(r.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("healthRetryDecision", () => {
    it("is done on any numeric status (success or a real code)", () => {
      expect(healthRetryDecision(1, 5)).toBe("done");
      expect(healthRetryDecision(8, 5)).toBe("done");
    });
    it("retries a fast null (the not-ready race)", () => {
      expect(healthRetryDecision(null, 10)).toBe("retry");
    });
    it("is done on a slow null (connected but unanswered — don't hammer the boot)", () => {
      expect(healthRetryDecision(null, HEALTH_ACTIVATE_READY_MS)).toBe("done");
    });
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

  it("delegates screenshotFramebuffer to the input channel (winPath-normalized)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const screenshot = vi.fn(async () => true);
    const inputChannel = { screenshot } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel });
    expect(await d.screenshotFramebuffer("C:/caps/My Shot.png")).toBe(true);
    expect(screenshot).toHaveBeenCalledWith("C:\\caps\\My Shot.png");
  });

  it("screenshotFramebuffer returns false when no input channel is wired (canvas fallback)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    expect(await d.screenshotFramebuffer("C:/caps/shot.png")).toBe(false);
  });

  it("screenshotFramebuffer swallows an input-channel rejection and returns false", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const screenshot = vi.fn(async () => { throw new Error("boom"); });
    const inputChannel = { screenshot } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel });
    expect(await d.screenshotFramebuffer("C:/caps/shot.png")).toBe(false);
  });

  it("insertSamplePin sends the pin via the input channel", async () => {
    const insertPin = vi.fn(async () => true);
    const channel = { insertPin, deletePin: vi.fn(async () => true) } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel: channel });
    await d.insertSamplePin(1781452800, "Sample Pin");
    expect(insertPin).toHaveBeenCalledWith("studio-sample-pin", 1781452800, "Sample Pin");
  });

  it("insertSamplePin throws when the channel reports failure (so IPC can revert)", async () => {
    const channel = { insertPin: vi.fn(async () => false), deletePin: vi.fn(async () => true) } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel: channel });
    await expect(d.insertSamplePin(1781452800, "Sample Pin")).rejects.toThrow(/sample pin/i);
  });

  it("insertSamplePin throws when no input channel is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.insertSamplePin(1, "x")).rejects.toThrow();
  });

  it("deleteSamplePin removes the fixed pin via the channel", async () => {
    const deletePin = vi.fn(async () => true);
    const channel = { insertPin: vi.fn(async () => true), deletePin } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel: channel });
    await d.deleteSamplePin();
    expect(deletePin).toHaveBeenCalledWith("studio-sample-pin");
  });

  it("reap() delegates to the injected reap dep (startup orphan reaper)", async () => {
    const reap = vi.fn(async () => {});
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {}, reap });
    await d.reap();
    expect(reap).toHaveBeenCalledOnce();
  });

  it("reap() is a safe no-op when no reap dep is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.reap()).resolves.toBeUndefined();
  });

  it("stopFast() kills the input helper and reaps DIRECTLY — no graceful stop first (quit path)", async () => {
    // Quit runs under before-quit's bounded deadline: the graceful stop's
    // liveness probe + `pebble kill` could eat the whole window, so stopFast
    // must dispatch the force-kill sweep immediately instead.
    const reap = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const stopChannel = vi.fn();
    const channel = { stop: stopChannel } as unknown as import("../../src/main/backend/winInputChannel.js").WinInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop, reap, inputChannel: channel });
    await d.stopFast();
    expect(stopChannel).toHaveBeenCalledOnce(); // helper never outlives the app
    expect(reap).toHaveBeenCalledOnce();        // direct sweep dispatched
    expect(stop).not.toHaveBeenCalled();        // graceful path skipped
  });

  it("stopFast() falls back to the normal stop when no reaper is wired", async () => {
    const stop = vi.fn(async () => {});
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new WindowsNativeDriver({ run, boot: async () => ep, stop });
    await d.stopFast();
    expect(stop).toHaveBeenCalledOnce();
  });
});
