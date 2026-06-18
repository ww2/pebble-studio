import { describe, it, expect } from "vitest";
import { buildBatteryCall } from "../../src/renderer/components/SettingsPane.js";

describe("buildBatteryCall (Battery section)", () => {
  it("passes the slider value + charging through", () => {
    expect(buildBatteryCall("37", null)).toEqual([37, false]);
    expect(buildBatteryCall("60", "true")).toEqual([60, true]);
  });
  it("clamps percent to 0..100", () => {
    expect(buildBatteryCall("250", null)[0]).toBe(100);
    expect(buildBatteryCall("-5", null)[0]).toBe(0);
    expect(buildBatteryCall("abc", null)[0]).toBe(0);
  });
});
