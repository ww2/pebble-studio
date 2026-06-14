import { describe, it, expect } from "vitest";
import { CHANGELOG } from "../../src/shared/changelog.js";

describe("CHANGELOG", () => {
  it("is non-empty and newest-first (1.0.0 leads)", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(CHANGELOG[0].version).toBe("1.0.0");
  });
  it("every entry has a version, a date, and at least one change", () => {
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/\d/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.changes.length).toBeGreaterThan(0);
      for (const c of e.changes) expect(c.trim().length).toBeGreaterThan(0);
    }
  });
  it("has no duplicate versions", () => {
    const v = CHANGELOG.map((e) => e.version);
    expect(new Set(v).size).toBe(v.length);
  });
});
