import { describe, it, expect } from "vitest";
import { getChrome, hitTestButton, roundClipPath } from "../../src/renderer/chrome/chromeRegistry.js";

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

  it("sizes gabbro's screen to the padded framebuffer width (272x260) for 1:1 touch mapping", () => {
    // QEMU pads the 260px round panel width up to ROUND_UP(260,16)=272; matching
    // the container to the true fb makes noVNC scale 1:1 on both axes (fixes the
    // downward touch drift). Height (260) is not tile-padded. x stays 14 so the
    // 260px content circle remains centered in the 288 body.
    expect(getChrome("gabbro").screen).toEqual({ x: 14, y: 14, width: 272, height: 260 });
  });

  it("roundClipPath masks a true circle of radius height/2 aligned to the content", () => {
    // gabbro: content circle diameter = height 260 → r=130, centered at (130,130)
    // in the padded 272-wide host (NOT a border-radius:50% ellipse over 272×260).
    expect(roundClipPath({ x: 14, y: 14, width: 272, height: 260 })).toBe("circle(130px at 130px 130px)");
    // square round board (chalk-like) → a plain centered circle.
    expect(roundClipPath({ x: 0, y: 0, width: 180, height: 180 })).toBe("circle(90px at 90px 90px)");
  });
});
