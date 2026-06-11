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
        "--text-tertiary", "--accent-hover", "--border", "--hairline", "--control",
        "--elev-1", "--elev-2", "--elev-3", "--device-shadow",
      ]) {
        expect(t[key], `${mode} ${key}`).toBeTruthy();
      }
    }
  });

  it("provides legible menu/popup tokens for the custom combobox in both themes", () => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const t = resolveTheme(mode);
      for (const key of [
        "--menu-bg", "--menu-text", "--menu-text-secondary",
        "--menu-hover", "--menu-selected", "--menu-selected-text", "--menu-border",
      ]) {
        expect(t[key], `${mode} ${key}`).toBeTruthy();
      }
      // Menu surface and its text must never be the same colour (no white-on-white).
      expect(t["--menu-bg"]).not.toBe(t["--menu-text"]);
    }
  });

  it("defines a green --success and a --danger token that differ between themes", () => {
    expect(resolveTheme("light")["--success"]).toBe("#0f7b0f");
    expect(resolveTheme("dark")["--success"]).toBe("#3fb950");
    expect(resolveTheme("light")["--success"]).not.toBe(resolveTheme("dark")["--success"]);
    expect(resolveTheme("light")["--danger"]).toBeTruthy();
    expect(resolveTheme("dark")["--danger"]).toBeTruthy();
  });
});
