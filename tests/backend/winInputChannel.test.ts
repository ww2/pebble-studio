import { describe, it, expect, vi } from "vitest";
import { WinInputChannel, readPypkjsPort, type InputChild } from "../../src/main/backend/winInputChannel.js";

/** A fake InputChild that records writes and can be "killed". */
function makeFakeChild() {
  const writes: string[] = [];
  let killed = false;
  let alive = true;
  const child: InputChild = {
    stdinWrite: (line) => { writes.push(line); },
    kill: () => { killed = true; alive = false; },
    alive: () => alive,
  };
  return { child, writes, isKilled: () => killed, die: () => { alive = false; } };
}

/** A fake InputChild that ALSO supports the stdout line reader (onLine), used by
 * the framebuffer screenshot path. `emit` feeds a line back as if the helper
 * printed it; `writes` records stdin commands. */
function makeShotChild() {
  const writes: string[] = [];
  let alive = true;
  let cb: ((line: string) => void) | null = null;
  const child: InputChild = {
    stdinWrite: (line) => { writes.push(line); },
    kill: () => { alive = false; },
    alive: () => alive,
    onLine: (fn) => { cb = fn; },
  };
  return { child, writes, emit: (line: string) => cb?.(line), die: () => { alive = false; } };
}

const HELPER = { pythonExe: "py.exe", helperPath: "C:/h/pb-input-helper.py" };

describe("WinInputChannel", () => {
  it("spawns the helper for the current port and writes a newline-terminated command", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn(() => fake.child);
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild });

    expect(ch.send("click select")).toBe(true);

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(spawnChild).toHaveBeenCalledWith("py.exe", ["C:/h/pb-input-helper.py", "5555"]);
    expect(fake.writes).toEqual(["click select\n"]);
  });

  it("reuses the same child across sends while the port is unchanged", () => {
    const fake = makeFakeChild();
    const spawnChild = vi.fn(() => fake.child);
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild });

    ch.send("click up");
    ch.send("click down");
    ch.send("tap x+");

    expect(spawnChild).toHaveBeenCalledTimes(1); // one helper, three sends
    expect(fake.writes).toEqual(["click up\n", "click down\n", "tap x+\n"]);
  });

  it("respawns against the new port when the emulator reboots (port changes)", () => {
    let port = 5555;
    const first = makeFakeChild();
    const second = makeFakeChild();
    const children = [first.child, second.child];
    let idx = 0;
    const spawnChild = vi.fn(() => children[idx++]);
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => port, spawnChild });

    ch.send("click select"); // spawns first @5555
    port = 6666; // reboot → new pypkjs port
    ch.send("click select"); // detects change → kills first, spawns second @6666

    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(spawnChild).toHaveBeenLastCalledWith("py.exe", ["C:/h/pb-input-helper.py", "6666"]);
    expect(first.isKilled()).toBe(true);
  });

  it("respawns when the helper has died", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const children = [first.child, second.child];
    let idx = 0;
    const spawnChild = vi.fn(() => children[idx++]);
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild });

    ch.send("click select"); // first
    first.die(); // helper process exited
    ch.send("click select"); // detects dead → spawns second

    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("returns false (caller falls back to CLI) when not booted (no port)", () => {
    const spawnChild = vi.fn();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => null, spawnChild });

    expect(ch.send("click select")).toBe(false);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("stop() kills the helper and a later send respawns", () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const children = [first.child, second.child];
    let idx = 0;
    const spawnChild = vi.fn(() => children[idx++]);
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild });

    ch.send("click select");
    ch.stop();
    expect(first.isKilled()).toBe(true);

    ch.send("click select"); // respawns after stop
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("falls back (returns false) when the stdin write throws (broken pipe)", () => {
    const throwingChild: InputChild = {
      stdinWrite: () => { throw new Error("EPIPE"); },
      kill: () => {},
      alive: () => true,
    };
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => throwingChild });

    expect(ch.send("click select")).toBe(false);
  });
});

describe("WinInputChannel.screenshot (framebuffer)", () => {
  it("writes the screenshot command and resolves true on an OK ack", async () => {
    const fake = makeShotChild();
    const spawnChild = vi.fn(() => fake.child);
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild });

    const p = ch.screenshot("C:/caps/shot.png");
    expect(fake.writes).toEqual(["screenshot C:/caps/shot.png\n"]);
    fake.emit("OK C:/caps/shot.png");
    expect(await p).toBe(true);
  });

  it("resolves false on an ERR ack (caller falls back to canvas)", async () => {
    const fake = makeShotChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });

    const p = ch.screenshot("C:/caps/shot.png");
    fake.emit("ERR screenshot failed");
    expect(await p).toBe(false);
  });

  it("ignores the helper's 'ready' line and other noise while waiting", async () => {
    const fake = makeShotChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });

    const p = ch.screenshot("C:/caps/shot.png");
    fake.emit("ready");
    fake.emit("input-helper noise");
    fake.emit("OK C:/caps/shot.png");
    expect(await p).toBe(true);
  });

  it("resolves false on timeout when the helper never acks", async () => {
    const fake = makeShotChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });

    const p = ch.screenshot("C:/caps/shot.png", 5);
    expect(await p).toBe(false);
  });

  it("returns false when not booted (no port)", async () => {
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => null, spawnChild: vi.fn() });
    expect(await ch.screenshot("C:/caps/shot.png")).toBe(false);
  });

  it("returns false when the child can't read stdout (no onLine)", async () => {
    // The bare input fake has no onLine, so acks can't arrive → fall back.
    const fake = makeFakeChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });
    expect(await ch.screenshot("C:/caps/shot.png")).toBe(false);
  });

  it("rejects a second concurrent screenshot while one is pending", async () => {
    const fake = makeShotChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });

    const p1 = ch.screenshot("C:/caps/a.png");
    const p2 = ch.screenshot("C:/caps/b.png"); // pending slot busy → immediate false
    expect(await p2).toBe(false);
    fake.emit("OK C:/caps/a.png");
    expect(await p1).toBe(true);
  });

  it("does not disturb the fire-and-forget input path", () => {
    const fake = makeShotChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });

    // Buttons still go through as plain stdin writes; the screenshot ack reader is
    // wired but only resolves OK/ERR (input emits nothing on stdout here).
    expect(ch.send("click select")).toBe(true);
    expect(fake.writes).toEqual(["click select\n"]);
  });

  it("stop() fails an in-flight screenshot so it can't hang", async () => {
    const fake = makeShotChild();
    const ch = new WinInputChannel({ helper: HELPER, readPort: () => 5555, spawnChild: () => fake.child });

    const p = ch.screenshot("C:/caps/shot.png");
    ch.stop();
    expect(await p).toBe(false);
  });
});

describe("readPypkjsPort", () => {
  const STATE = JSON.stringify({
    emery: { "4.9.169": { qemu: { pid: 1, port: 2 }, pypkjs: { pid: 3, port: 57749 }, websockify: { pid: 4 } } },
  });

  it("extracts the pypkjs port from the state file", () => {
    expect(readPypkjsPort("x", () => STATE)).toBe(57749);
  });

  it("returns null when the file is missing/unreadable", () => {
    expect(readPypkjsPort("x", () => { throw new Error("ENOENT"); })).toBeNull();
  });

  it("returns null when the JSON is malformed", () => {
    expect(readPypkjsPort("x", () => "{not json")).toBeNull();
  });

  it("returns null when no pypkjs port is present", () => {
    const noPort = JSON.stringify({ emery: { "4.9.169": { qemu: { pid: 1 } } } });
    expect(readPypkjsPort("x", () => noPort)).toBeNull();
  });
});
