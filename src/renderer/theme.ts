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
  // Mica base + card/layer per Fluent spec. Base #202020, card #2B2B2B.
  "--bg": "#202020",
  // Subtle neutral tint layered into the opaque Mica backdrop.
  "--bg-tint": "rgba(255,255,255,0.03)",
  "--surface": "#2b2b2b",
  "--surface-2": "#272727",
  "--raised": "#2f2f2f",
  "--text": "rgba(255,255,255,0.89)",
  "--text-secondary": "rgba(255,255,255,0.6)",
  "--text-tertiary": "rgba(255,255,255,0.45)",
  "--accent": "#60cdff",
  "--accent-hover": "#7ad6ff",
  "--accent-press": "#4cc2f5",
  "--accent-fg": "#003e5c",
  "--accent-soft": "rgba(96,205,255,0.14)",
  "--accent-soft-hover": "rgba(96,205,255,0.22)",
  // Fluent stroke at 7% in dark.
  "--border": "rgba(255,255,255,0.07)",
  "--border-strong": "rgba(255,255,255,0.12)",
  "--hairline": "rgba(255,255,255,0.07)",
  // Subtle darker hairline for the bottom edge of controls (Fluent control stroke).
  "--control-bottom": "rgba(0,0,0,0.30)",
  "--control": "rgba(255,255,255,0.06)",
  "--control-hover": "rgba(255,255,255,0.09)",
  "--control-press": "rgba(255,255,255,0.04)",
  // Acrylic fill for transient surfaces (semi-transparent; paired with blur).
  "--acrylic": "rgba(44,44,44,0.78)",
  // Menu / popup surface (dropdowns, listboxes) — Acrylic-tinted, blurred in CSS.
  "--menu-bg": "rgba(44,44,44,0.82)",
  "--menu-text": "rgba(255,255,255,0.89)",
  "--menu-text-secondary": "rgba(255,255,255,0.55)",
  "--menu-hover": "rgba(255,255,255,0.08)",
  "--menu-selected": "rgba(96,205,255,0.20)",
  "--menu-selected-text": "rgba(255,255,255,0.92)",
  "--menu-border": "rgba(255,255,255,0.10)",
  "--danger": "#ff99a4",
  "--danger-soft": "rgba(255,153,164,0.18)",
  "--success": "#3fb950",
  "--warn": "#ca5010",
  // Soft elevation — depth comes mostly from layered materials, so shadows are light.
  "--elev-1": "0 1px 2px rgba(0,0,0,0.28)",
  "--elev-2": "0 2px 6px rgba(0,0,0,0.32)",
  "--elev-3": "0 8px 20px rgba(0,0,0,0.40)",
  "--device-shadow": "0 16px 40px rgba(0,0,0,0.45)",
};

const LIGHT: ThemeTokens = {
  // Mica base + card/layer per Fluent spec. Base #F3F3F3, card #FFFFFF.
  "--bg": "#f3f3f3",
  // Subtle neutral tint layered into the opaque Mica backdrop.
  "--bg-tint": "rgba(0,0,0,0.02)",
  "--surface": "#ffffff",
  "--surface-2": "#fbfbfb",
  "--raised": "#ffffff",
  "--text": "rgba(0,0,0,0.89)",
  "--text-secondary": "rgba(0,0,0,0.6)",
  "--text-tertiary": "rgba(0,0,0,0.45)",
  "--accent": "#005fb8",
  "--accent-hover": "#0a6cc9",
  "--accent-press": "#005299",
  "--accent-fg": "#ffffff",
  "--accent-soft": "rgba(0,95,184,0.10)",
  "--accent-soft-hover": "rgba(0,95,184,0.16)",
  // Fluent stroke at 6% in light.
  "--border": "rgba(0,0,0,0.06)",
  "--border-strong": "rgba(0,0,0,0.12)",
  "--hairline": "rgba(0,0,0,0.06)",
  // Subtle darker hairline for the bottom edge of controls (Fluent control stroke).
  "--control-bottom": "rgba(0,0,0,0.16)",
  "--control": "rgba(0,0,0,0.03)",
  "--control-hover": "rgba(0,0,0,0.06)",
  "--control-press": "rgba(0,0,0,0.02)",
  // Acrylic fill for transient surfaces (semi-transparent; paired with blur).
  "--acrylic": "rgba(252,252,252,0.78)",
  // Menu / popup surface (dropdowns, listboxes) — Acrylic-tinted, blurred in CSS.
  "--menu-bg": "rgba(252,252,252,0.85)",
  "--menu-text": "rgba(0,0,0,0.89)",
  "--menu-text-secondary": "rgba(0,0,0,0.50)",
  "--menu-hover": "rgba(0,0,0,0.05)",
  "--menu-selected": "rgba(0,95,184,0.12)",
  "--menu-selected-text": "#003c75",
  "--menu-border": "rgba(0,0,0,0.08)",
  "--danger": "#c42b1c",
  "--danger-soft": "rgba(196,43,28,0.10)",
  "--success": "#0f7b0f",
  "--warn": "#8b3a00",
  // Soft elevation — depth comes mostly from layered materials, so shadows are light.
  "--elev-1": "0 1px 2px rgba(0,0,0,0.06)",
  "--elev-2": "0 2px 6px rgba(0,0,0,0.08)",
  "--elev-3": "0 8px 20px rgba(0,0,0,0.12)",
  "--device-shadow": "0 16px 40px rgba(0,0,0,0.18)",
};

export function resolveTheme(mode: ThemeMode, prefersDark = false): ThemeTokens {
  if (mode === "dark") return DARK;
  if (mode === "light") return LIGHT;
  return prefersDark ? DARK : LIGHT;
}

export function applyTheme(tokens: ThemeTokens, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
}
