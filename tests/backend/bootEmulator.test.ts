import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

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
    queueMicrotask(() => {
      const out = stdoutFor(cmd, args);
      if (out) child.stdout.emit("data", Buffer.from(out));
      child.emit("close", exitCode);
    });
    return child;
  },
}));

// Import AFTER the mock is registered (vi.mock is hoisted, so this is fine).
const { bootEmulator, makeWslBootDeps, makeNativeBootDeps } = await import(
  "../../src/main/backend/bootEmulator.js"
);

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
    // qemu is matched by EXACT process name (avoids the shell self-match hazard).
    expect(cmdline).toContain("pkill -9 -x qemu-pebble");
    // websockify/emu-control use the [c]haracter-class self-exclusion trick.
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

  it("bootEmulator runs the lifecycle in order using injected fake deps (no spawning)", async () => {
    const order: string[] = [];
    const endpoint = await bootEmulator("basalt", {
      killAll: async () => { order.push("killAll"); },
      ensureKeymap: async () => { order.push("ensureKeymap"); },
      bootControl: async () => { order.push("bootControl"); },
      waitForEmuInfo: async () => { order.push("waitForEmuInfo"); },
      waitForPort: async () => { order.push("waitForPort"); },
    });
    expect(order).toEqual([
      "killAll", "ensureKeymap", "bootControl", "waitForEmuInfo", "waitForPort", "waitForPort",
    ]);
    expect(endpoint).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
  });
});
