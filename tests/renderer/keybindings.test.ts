import { describe, it, expect } from "vitest";
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  resolveAction,
  isBareModifierKey,
  applyRebind,
  type Bindings,
} from "../../src/renderer/keybindings.js";

describe("keybindings defaults", () => {
  it("binds the four buttons to the arrow keys (qemu-pebble layout)", () => {
    expect(DEFAULT_BINDINGS.back).toBe("ArrowLeft");
    expect(DEFAULT_BINDINGS.up).toBe("ArrowUp");
    expect(DEFAULT_BINDINGS.select).toBe("ArrowRight");
    expect(DEFAULT_BINDINGS.down).toBe("ArrowDown");
  });
  it("leaves tap, shake, light, screenshot and record unbound by default", () => {
    expect(DEFAULT_BINDINGS.tap).toBeNull();
    expect(DEFAULT_BINDINGS.shake).toBeNull();
    expect(DEFAULT_BINDINGS.light).toBeNull();
    expect(DEFAULT_BINDINGS.screenshot).toBeNull();
    expect(DEFAULT_BINDINGS.record).toBeNull();
  });
  it("exposes all actions in order", () => {
    expect(ACTIONS).toEqual(
      ["back", "up", "select", "down", "tap", "shake", "light", "screenshot", "record"],
    );
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

describe("isBareModifierKey", () => {
  it("flags lone modifier keys (never a usable binding)", () => {
    for (const k of ["Control", "Alt", "Meta", "Shift", "AltGraph"]) {
      expect(isBareModifierKey(k)).toBe(true);
    }
  });
  it("passes real keys through", () => {
    for (const k of ["a", "ArrowUp", " ", "Enter", "Escape", "F1"]) {
      expect(isBareModifierKey(k)).toBe(false);
    }
  });
});

describe("applyRebind (conflict resolution)", () => {
  it("assigns the key to the action", () => {
    const out = applyRebind(DEFAULT_BINDINGS, "tap", "t");
    expect(out.tap).toBe("t");
  });
  it("clears the key from any other action so it maps to exactly one", () => {
    // ArrowUp is 'up' by default; rebinding it to 'tap' must free 'up'.
    const out = applyRebind(DEFAULT_BINDINGS, "tap", "ArrowUp");
    expect(out.tap).toBe("ArrowUp");
    expect(out.up).toBeNull();
    // And it now resolves to the new owner, not the old first-in-order one.
    expect(resolveAction("ArrowUp", out)).toBe("tap");
  });
  it("does not mutate the input bindings", () => {
    const base: Bindings = { ...DEFAULT_BINDINGS };
    applyRebind(base, "tap", "ArrowUp");
    expect(base.up).toBe("ArrowUp");
    expect(base.tap).toBeNull();
  });
  it("re-binding an action to a fresh key leaves others intact", () => {
    const out = applyRebind(DEFAULT_BINDINGS, "back", "b");
    expect(out.back).toBe("b");
    expect(out.up).toBe("ArrowUp");
    expect(out.select).toBe("ArrowRight");
  });
});
