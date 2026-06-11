export type ThemeMode = "light" | "dark" | "system";
export type ThemeTokens = Record<string, string>;

/**
 * Windows 11 Fluent + Material design tokens.
 *
 * Surface layering: `--bg` (Mica base) < `--surface` (card) < `--raised`
 * (popovers / inputs sitting on a card). Accent follows Win11 conventions:
 * light ~#005FB8, dark ~#60CDFF. Elevation tokens hold ready-made box-shadow
 * values so components stay consistent. `--noise` carries a tiny atmospheric
 * gradient/texture layer used by the app backdrop.
 */
const DARK: ThemeTokens = {
  "--bg": "#202020",
  "--bg-tint": "#2a3138",
  "--surface": "#2b2b2b",
  "--surface-2": "#323232",
  "--raised": "#373737",
  "--text": "#ffffff",
  "--text-secondary": "rgba(255,255,255,0.72)",
  "--text-tertiary": "rgba(255,255,255,0.50)",
  "--accent": "#60cdff",
  "--accent-hover": "#7ad6ff",
  "--accent-press": "#4cc2f5",
  "--accent-fg": "#06131c",
  "--accent-soft": "rgba(96,205,255,0.14)",
  "--accent-soft-hover": "rgba(96,205,255,0.22)",
  "--border": "#3a3a3a",
  "--border-strong": "#484848",
  "--hairline": "rgba(255,255,255,0.08)",
  "--control": "rgba(255,255,255,0.05)",
  "--control-hover": "rgba(255,255,255,0.09)",
  "--control-press": "rgba(255,255,255,0.03)",
  // Menu / popup surface (dropdowns, listboxes) — opaque so text never bleeds
  // into the page behind it. Paired text + hover/selected states guarantee
  // legible contrast in dark mode.
  "--menu-bg": "#2c2c2c",
  "--menu-text": "#ffffff",
  "--menu-text-secondary": "rgba(255,255,255,0.55)",
  "--menu-hover": "rgba(255,255,255,0.08)",
  "--menu-selected": "rgba(96,205,255,0.20)",
  "--menu-selected-text": "#ffffff",
  "--menu-border": "#454545",
  "--danger": "#ff6b6b",
  "--danger-soft": "rgba(255,107,107,0.18)",
  "--success": "#3fb950",
  "--elev-1": "0 1px 2px rgba(0,0,0,0.40)",
  "--elev-2": "0 2px 8px rgba(0,0,0,0.45)",
  "--elev-3": "0 8px 24px rgba(0,0,0,0.55)",
  "--device-shadow": "0 24px 60px rgba(0,0,0,0.60)",
};

const LIGHT: ThemeTokens = {
  "--bg": "#f3f3f3",
  "--bg-tint": "#e7eef6",
  "--surface": "#ffffff",
  "--surface-2": "#fbfbfb",
  "--raised": "#ffffff",
  "--text": "#1b1b1b",
  "--text-secondary": "rgba(0,0,0,0.62)",
  "--text-tertiary": "rgba(0,0,0,0.45)",
  "--accent": "#005fb8",
  "--accent-hover": "#0a6cc9",
  "--accent-press": "#005299",
  "--accent-fg": "#ffffff",
  "--accent-soft": "rgba(0,95,184,0.10)",
  "--accent-soft-hover": "rgba(0,95,184,0.16)",
  "--border": "#e1e1e1",
  "--border-strong": "#d2d2d2",
  "--hairline": "rgba(0,0,0,0.07)",
  "--control": "rgba(0,0,0,0.03)",
  "--control-hover": "rgba(0,0,0,0.06)",
  "--control-press": "rgba(0,0,0,0.02)",
  // Menu / popup surface (dropdowns, listboxes) — opaque white with dark text
  // so the old white-on-white dropdown problem cannot recur in light mode.
  "--menu-bg": "#ffffff",
  "--menu-text": "#1b1b1b",
  "--menu-text-secondary": "rgba(0,0,0,0.50)",
  "--menu-hover": "rgba(0,0,0,0.05)",
  "--menu-selected": "rgba(0,95,184,0.12)",
  "--menu-selected-text": "#003c75",
  "--menu-border": "#d8d8d8",
  "--danger": "#c42b1c",
  "--danger-soft": "rgba(196,43,28,0.10)",
  "--success": "#0f7b0f",
  "--elev-1": "0 1px 2px rgba(0,0,0,0.08)",
  "--elev-2": "0 2px 8px rgba(0,0,0,0.10)",
  "--elev-3": "0 8px 24px rgba(0,0,0,0.14)",
  "--device-shadow": "0 24px 60px rgba(0,0,0,0.22)",
};

export function resolveTheme(mode: ThemeMode, prefersDark = false): ThemeTokens {
  if (mode === "dark") return DARK;
  if (mode === "light") return LIGHT;
  return prefersDark ? DARK : LIGHT;
}

export function applyTheme(tokens: ThemeTokens, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
}
