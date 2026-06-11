import { describe, it, expect } from "vitest";
import { resolveTheme, type ThemeMode } from "../../src/renderer/theme.js";

describe("resolveTheme", () => {
  it("returns dark tokens for dark mode", () => {
    const t = resolveTheme("dark");
    expect(t["--bg"]).toBe("#202020");
    expect(t["--text"]).toBe("#ffffff");
    expect(t["--accent"]).toBe("#60cdff");
    expect(t["--surface"]).toBe("#2b2b2b");
  });
  it("returns light tokens for light mode", () => {
    const t = resolveTheme("light");
    expect(t["--bg"]).toBe("#f3f3f3");
    expect(t["--text"]).toBe("#1b1b1b");
    expect(t["--accent"]).toBe("#005fb8");
    expect(t["--surface"]).toBe("#ffffff");
  });
  it("resolves 'system' using the provided prefersDark flag", () => {
    expect(resolveTheme("system", true)["--bg"]).toBe("#202020");
    expect(resolveTheme("system", false)["--bg"]).toBe("#f3f3f3");
  });
  it("provides the extended Fluent token set (surface layering + elevation)", () => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const t = resolveTheme(mode);
      for (const key of [
        "--surface", "--surface-2", "--raised", "--text-secondary",
        "--accent-hover", "--border", "--hairline", "--control",
        "--elev-1", "--elev-2", "--elev-3", "--device-shadow",
      ]) {
        expect(t[key], `${mode} ${key}`).toBeTruthy();
      }
    }
  });
});
