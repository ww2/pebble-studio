import { describe, it, expect, vi } from "vitest";
import { makeWinBootDeps } from "../../src/main/backend/winBootDeps.js";

function deps(over = {}) {
  const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const readFile = vi.fn(async () => "");
  const detachSpawn = vi.fn(async () => {});
  return { run, readFile, detachSpawn, ...over };
}

describe("makeWinBootDeps", () => {
  it("bootControl detach-spawns pebble.exe emu-control --vnc for the platform", async () => {
    const d = deps();
    const b = makeWinBootDeps(d);
    await b.bootControl("basalt");
    expect(d.detachSpawn).toHaveBeenCalledWith("pebble", ["emu-control", "--emulator", "basalt", "--vnc"]);
  });

  it("diagnose reports qemuAlive from a live tasklist row", async () => {
    const d = deps({
      run: vi.fn(async (_c: string, args: string[]) =>
        args.includes("IMAGENAME eq qemu-pebble.exe")
          ? { code: 0, stdout: `"qemu-pebble.exe","999","Console","1","10 K"\r\n`, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }),
      readFile: vi.fn(async () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 999 } } } })),
    });
    const b = makeWinBootDeps(d);
    const probe = await b.diagnose();
    expect(probe.qemuAlive).toBe(true);
    expect(probe.stateFile).toBe(true);
  });

  it("waitForEmuInfo resolves once the state file has a live pid for the platform", async () => {
    const d = deps({ readFile: vi.fn(async () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 42 } } } })) });
    const b = makeWinBootDeps(d);
    await expect(b.waitForEmuInfo("basalt", 1000)).resolves.toBeUndefined();
  });

  it("killAll force-kills qemu by image and removes the state file", async () => {
    const calls: string[][] = [];
    const d = deps({
      run: vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    const b = makeWinBootDeps(d);
    await b.killAll();
    expect(calls.some((a) => a.includes("qemu-pebble.exe") && a.includes("/F"))).toBe(true);
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
