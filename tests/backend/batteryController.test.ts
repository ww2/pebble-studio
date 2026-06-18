import { describe, it, expect, vi } from "vitest";
import {
  clampPercent,
  makeBatteryController,
  type BatteryDriver,
} from "../../src/main/backend/batteryController.js";

/** A driver whose battery() records every (percent, charging) it receives. */
function makeDriver(over: Partial<BatteryDriver> = {}): {
  driver: BatteryDriver;
  calls: Array<[number, boolean]>;
} {
  const calls: Array<[number, boolean]> = [];
  const driver: BatteryDriver = {
    battery: async (p, c) => { calls.push([p, c]); },
    ...over,
  };
  return { driver, calls };
}

describe("clampPercent", () => {
  it("rounds and clamps to [0,100]", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42.6)).toBe(43);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("makeBatteryController", () => {
  it("set() applies the clamped level to the driver and remembers it", async () => {
    const { driver, calls } = makeDriver();
    const battery = makeBatteryController(() => driver);
    await battery.set(150, true);
    expect(calls).toEqual([[100, true]]);
    expect(battery.get()).toEqual({ percent: 100, charging: true });
  });

  it("reassert() is a no-op until a level has been set this session", async () => {
    const { driver, calls } = makeDriver();
    const battery = makeBatteryController(() => driver);
    await battery.reassert();
    expect(calls).toEqual([]);
  });

  it("reassert() re-pushes the last applied level (the reboot fix)", async () => {
    const { driver, calls } = makeDriver();
    const battery = makeBatteryController(() => driver);
    await battery.set(37, false);
    calls.length = 0;            // ignore the initial apply
    await battery.reassert();    // simulates a fresh boot re-asserting state
    expect(calls).toEqual([[37, false]]);
  });

  it("reassert() swallows a driver error (bridge not ready)", async () => {
    const { driver } = makeDriver({ battery: async () => { throw new Error("bridge down"); } });
    const battery = makeBatteryController(() => driver);
    // set() stores even though the live push throws...
    await expect(battery.set(50, false)).rejects.toThrow();
    // ...and a later reassert() must never throw.
    await expect(battery.reassert()).resolves.toBeUndefined();
    expect(battery.get()).toEqual({ percent: 50, charging: false });
  });

  it("set() with no driver remembers the level without throwing", async () => {
    const battery = makeBatteryController(() => null);
    await expect(battery.set(80, false)).resolves.toBeUndefined();
    expect(battery.get()).toEqual({ percent: 80, charging: false });
  });

  it("reassert() with no driver is a no-op", async () => {
    let driver: BatteryDriver | null = null;
    const calls: Array<[number, boolean]> = [];
    const battery = makeBatteryController(() => driver);
    driver = { battery: async (p, c) => { calls.push([p, c]); } };
    await battery.set(60, true);
    driver = null;               // emulator stopped before the reboot completes
    await battery.reassert();
    expect(calls).toEqual([[60, true]]); // only the live set(), no reassert push
  });

  it("uses the current driver each call (getter, not captured)", async () => {
    const a = makeDriver();
    const b = makeDriver();
    let current: BatteryDriver = a.driver;
    const battery = makeBatteryController(() => current);
    await battery.set(25, false);
    current = b.driver;          // emulator rebooted → new driver instance
    await battery.reassert();
    expect(a.calls).toEqual([[25, false]]);
    expect(b.calls).toEqual([[25, false]]);
  });
});
