import { describe, it, expect } from "vitest";
import {
  installCmd, buttonCmd, accelTapCmd, setTimeCmd, btCmd, batteryCmd, screenshotCmd, bootCmd, wipeCmd,
} from "../../src/main/backend/pebbleCli.js";

describe("pebbleCli argv builders", () => {
  it("builds an install command for a pbw path", () => {
    expect(installCmd("/apps/face.pbw")).toEqual({
      cmd: "pebble",
      args: ["install", "--emulator", "basalt", "/apps/face.pbw"],
      env: { PEBBLE_EMULATOR: "basalt" },
    });
  });
  it("builds a button press command", () => {
    // Real CLI: pebble emu-button {click,push,release} [BUTTON ...]
    // action first, then button; "press" ButtonAction maps to "click"
    expect(buttonCmd("select", "press").args).toEqual(["emu-button", "--emulator", "basalt", "click", "select"]);
  });
  it("builds an accelerometer tap command", () => {
    // Real CLI: pebble emu-tap (separate subcommand, not emu-accel tap)
    expect(accelTapCmd().args).toEqual(["emu-tap", "--emulator", "basalt"]);
  });
  it("sets a specific time (HH:MM:SS)", () => {
    // Real CLI: pebble emu-set-time accepts HH:MM:SS or Unix seconds, NOT ISO
    expect(setTimeCmd("09:30:00").args).toEqual(["emu-set-time", "--emulator", "basalt", "09:30:00"]);
  });
  it("toggles bluetooth", () => {
    // Real CLI: --connected {no,yes} (not connected/disconnected)
    expect(btCmd(false).args).toEqual(["emu-bt-connection", "--emulator", "basalt", "--connected", "no"]);
  });
  it("sets battery level + charging", () => {
    expect(batteryCmd(42, true).args).toEqual(["emu-battery", "--emulator", "basalt", "--percent", "42", "--charging"]);
  });
  it("builds a screenshot command with output path", () => {
    expect(screenshotCmd("/tmp/shot.png").args).toEqual(["screenshot", "--emulator", "basalt", "/tmp/shot.png"]);
  });
  it("builds an emulator boot command with vnc enabled", () => {
    expect(bootCmd("chalk").args).toEqual(["emu-control", "--emulator", "chalk", "--vnc"]);
  });
  it("builds a wipe command with no --emulator flag (wipes all platforms)", () => {
    // pebble wipe has no --emulator option; it always wipes all platform dirs
    // for the current SDK version. The emulator cannot survive a wipe.
    const c = wipeCmd();
    expect(c.cmd).toBe("pebble");
    expect(c.args).toEqual(["wipe"]);
    // Confirm no --emulator flag is present (would be a CLI error)
    expect(c.args).not.toContain("--emulator");
  });
});
