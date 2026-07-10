import { describe, it, expect, vi } from "vitest";

// VersionSwitcher's module only pulls in the pure emulator registry, but keep the
// import DOM-free by not constructing the class — we exercise the exported helper.
vi.mock("@novnc/novnc", () => ({ default: class {} }));

import { nextTypeAheadIndex } from "../../src/renderer/components/VersionSwitcher.js";

const LABELS = ["Aplite", "Basalt", "Chalk", "Diorite", "Emery"];

describe("nextTypeAheadIndex", () => {
  it("jumps to the option starting with the typed letter", () => {
    expect(nextTypeAheadIndex(LABELS, 0, "c")).toBe(2); // Chalk
    expect(nextTypeAheadIndex(LABELS, 0, "e")).toBe(4); // Emery
  });
  it("is case-insensitive", () => {
    expect(nextTypeAheadIndex(LABELS, 0, "B")).toBe(1); // Basalt
  });
  it("searches cyclically AFTER the current index", () => {
    // From Emery (4), 'a' wraps around to Aplite (0).
    expect(nextTypeAheadIndex(LABELS, 4, "a")).toBe(0);
  });
  it("returns the current index when nothing matches", () => {
    expect(nextTypeAheadIndex(LABELS, 2, "z")).toBe(2);
  });
  it("advances to the NEXT match when the current already matches", () => {
    const labels = ["Chalk", "Cobble", "Diorite"];
    // Current is Chalk (0); typing 'c' again should move to Cobble (1).
    expect(nextTypeAheadIndex(labels, 0, "c")).toBe(1);
  });
});
