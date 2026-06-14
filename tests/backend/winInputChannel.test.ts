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
