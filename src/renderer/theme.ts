export type ThemeMode = "light" | "dark" | "system";
export type ThemeTokens = Record<string, string>;

const DARK: ThemeTokens = {
  "--bg": "#202020", "--surface": "#2b2b2b", "--text": "#ffffff",
  "--accent": "#60cdff", "--border": "#3a3a3a",
};
const LIGHT: ThemeTokens = {
  "--bg": "#f3f3f3", "--surface": "#ffffff", "--text": "#1b1b1b",
  "--accent": "#005fb8", "--border": "#e1e1e1",
};

export function resolveTheme(mode: ThemeMode, prefersDark = false): ThemeTokens {
  if (mode === "dark") return DARK;
  if (mode === "light") return LIGHT;
  return prefersDark ? DARK : LIGHT;
}

export function applyTheme(tokens: ThemeTokens, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
}
