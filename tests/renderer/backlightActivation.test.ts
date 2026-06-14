import { describe, it, expect, vi } from "vitest";

// EmulatorView transitively imports vncClient -> @novnc/novnc, which touches
// `window` at module load. Stub it so we can import the pure, DOM-free helper.
vi.mock("@novnc/novnc", () => ({ default: class {} }));

import { backlightActivationFromSetting } from "../../src/renderer/components/EmulatorView.js";

describe("backlightActivationFromSetting", () => {
  it("maps the stored 'shake' value to shake", () => {
    expect(backlightActivationFromSetting("shake")).toBe("shake");
  });

  it("maps the stored 'back' value to back", () => {
    expect(backlightActivationFromSetting("back")).toBe("back");
  });

  it("defaults to back when the setting is unset (null)", () => {
    expect(backlightActivationFromSetting(null)).toBe("back");
  });

  it("defaults to back for an unknown/garbage value", () => {
    expect(backlightActivationFromSetting("motion")).toBe("back");
    expect(backlightActivationFromSetting("")).toBe("back");
  });
});
