import { describe, it, expect } from "vitest";
import { getChrome, hitTestButton } from "../../src/renderer/chrome/chromeRegistry.js";

describe("chromeRegistry", () => {
  it("provides screen offset + button regions for basalt", () => {
    const c = getChrome("basalt");
    // v0.0.5: screen bezel shrunk ~60% (offsets x24→10, y30→12).
    expect(c.screen).toEqual({ x: 10, y: 12, width: 144, height: 168 });
    expect(c.buttons.map((b) => b.id).sort()).toEqual(["back", "down", "select", "up"]);
  });

  it("hit-tests a click inside the select button region", () => {
    const c = getChrome("basalt");
    const sel = c.buttons.find((b) => b.id === "select")!;
    const cx = sel.x + sel.width / 2, cy = sel.y + sel.height / 2;
    expect(hitTestButton("basalt", cx, cy)).toBe("select");
  });

  it("returns null when clicking outside any button", () => {
    expect(hitTestButton("basalt", -100, -100)).toBeNull();
  });

  it("uses the correct 260x260 screen for gabbro (logical panel size; display stays centered)", () => {
    // The screen container is kept at the LOGICAL panel size so the watchface
    // stays centered in the bezel. Touch alignment is corrected qemu-side, not by
    // resizing the screen to the padded framebuffer (that de-centered the face).
    expect(getChrome("gabbro").screen).toEqual({ x: 14, y: 14, width: 260, height: 260 });
  });
});
