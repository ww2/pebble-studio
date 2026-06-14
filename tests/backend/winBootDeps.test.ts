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
});
