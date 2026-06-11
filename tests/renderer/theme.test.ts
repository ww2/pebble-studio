import { describe, it, expect } from "vitest";
import { resolveTheme, type ThemeMode } from "../../src/renderer/theme.js";

describe("resolveTheme", () => {
  it("returns dark tokens for dark mode", () => {
    const t = resolveTheme("dark");
    expect(t["--bg"]).toBe("#202020");
    expect(t["--text"]).toBe("#ffffff");
  });
  it("returns light tokens for light mode", () => {
    const t = resolveTheme("light");
    expect(t["--bg"]).toBe("#f3f3f3");
    expect(t["--text"]).toBe("#1b1b1b");
  });
  it("resolves 'system' using the provided prefersDark flag", () => {
    expect(resolveTheme("system", true)["--bg"]).toBe("#202020");
    expect(resolveTheme("system", false)["--bg"]).toBe("#f3f3f3");
  });
});
