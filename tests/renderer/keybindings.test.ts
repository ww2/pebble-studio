import { describe, it, expect } from "vitest";
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  resolveAction,
  type Bindings,
} from "../../src/renderer/keybindings.js";

describe("keybindings defaults", () => {
  it("binds the four buttons to the arrow keys (qemu-pebble layout)", () => {
    expect(DEFAULT_BINDINGS.back).toBe("ArrowLeft");
    expect(DEFAULT_BINDINGS.up).toBe("ArrowUp");
    expect(DEFAULT_BINDINGS.select).toBe("ArrowRight");
    expect(DEFAULT_BINDINGS.down).toBe("ArrowDown");
  });
  it("leaves tap, shake and light unbound by default", () => {
    expect(DEFAULT_BINDINGS.tap).toBeNull();
    expect(DEFAULT_BINDINGS.shake).toBeNull();
    expect(DEFAULT_BINDINGS.light).toBeNull();
  });
  it("exposes all actions in order", () => {
    expect(ACTIONS).toEqual(["back", "up", "select", "down", "tap", "shake", "light"]);
  });
});

describe("resolveAction", () => {
  it("resolves each default arrow key to its action", () => {
    expect(resolveAction("ArrowLeft", DEFAULT_BINDINGS)).toBe("back");
    expect(resolveAction("ArrowUp", DEFAULT_BINDINGS)).toBe("up");
    expect(resolveAction("ArrowRight", DEFAULT_BINDINGS)).toBe("select");
    expect(resolveAction("ArrowDown", DEFAULT_BINDINGS)).toBe("down");
  });
  it("returns null for an unbound key", () => {
    expect(resolveAction("a", DEFAULT_BINDINGS)).toBeNull();
    expect(resolveAction("Enter", DEFAULT_BINDINGS)).toBeNull();
  });
  it("never resolves to an action whose binding is null", () => {
    // tap/shake are null in defaults; a literal null key must not match them.
    expect(resolveAction(null as unknown as string, DEFAULT_BINDINGS)).toBeNull();
  });
  it("resolves custom tap/shake bindings", () => {
    const b: Bindings = { ...DEFAULT_BINDINGS, tap: "t", shake: "s" };
    expect(resolveAction("t", b)).toBe("tap");
    expect(resolveAction("s", b)).toBe("shake");
  });
  it("first action in order wins when a key is bound twice", () => {
    const b: Bindings = { ...DEFAULT_BINDINGS, tap: "ArrowLeft" };
    // back precedes tap in ACTIONS order.
    expect(resolveAction("ArrowLeft", b)).toBe("back");
  });
});
