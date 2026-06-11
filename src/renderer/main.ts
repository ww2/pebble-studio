import { resolveTheme, applyTheme } from "./theme.js";
import { EmulatorView } from "./components/EmulatorView.js";
import { VersionSwitcher } from "./components/VersionSwitcher.js";
import { AppLibrary } from "./components/AppLibrary.js";
import { CaptureBar } from "./components/CaptureBar.js";
import type { PlatformId } from "../shared/types.js";
import { getPlatform } from "../main/backend/emulatorRegistry.js";

interface StudioApi {
  initBackend(): Promise<{ kind: string }>;
  start(id: string): Promise<{ host: string; port: number; wsPath: string }>;
  stop(): Promise<unknown>;
  install(pbwPath: string): Promise<unknown>;
  button(id: string): Promise<unknown>;
  accelTap(): Promise<unknown>;
  screenshot(out: string): Promise<unknown>;
  libAdd(pbwPath: string): Promise<string[]>;
  libList(): Promise<string[]>;
  libRemove(p: string): Promise<string[]>;
  libInstallAll(): Promise<void>;
  loadedList(): Promise<string[]>;
  loadedClear(platformId: string): Promise<unknown>;
  pathForFile(file: File): string;
  saveCapture(name: string, bytes: Uint8Array): Promise<string>;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

type ThemeChoice = "light" | "dark";
let themeMode: ThemeChoice =
  localStorage.getItem("pebble-studio:theme") === "light" ? "light" : "dark";
applyTheme(resolveTheme(themeMode));

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="app-backdrop" aria-hidden="true"></div>
  <div class="app-shell">
    <header class="cmdbar">
      <div class="cmdbar-brand">
        <span class="brand-mark" aria-hidden="true">P</span>
        <span class="brand-name">Pebble Studio</span>
        <span class="backend-pill" id="backend-pill" title="Active backend">
          <span class="backend-dot"></span><span id="backend-kind">…</span>
        </span>
      </div>
      <div class="cmdbar-actions" id="cmdbar-actions">
        <label class="combo" id="version-combo">
          <span class="combo-caption">Model</span>
        </label>
      </div>
    </header>
    <div class="workspace">
      <section class="stage-col" id="stage-col"></section>
      <aside class="inspector" id="inspector"></aside>
    </div>
  </div>
`;

const view = new EmulatorView();
const switcher = new VersionSwitcher((id: PlatformId) => void view.show(id), "basalt");
const library = new AppLibrary(
  () => switcher.value,
  (platformId: string) => view.reconnectAfterClear(platformId as PlatformId),
);
const captureBar = new CaptureBar(
  () => document.querySelector<HTMLElement>("#emu-screen"),
  () => getPlatform(switcher.value as PlatformId).round,
);

// Command bar: version switcher (styled as a Fluent combobox) + theme toggle.
const combo = document.getElementById("version-combo")!;
combo.appendChild(switcher.el);

const themeToggle = document.createElement("button");
themeToggle.className = "theme-toggle";
themeToggle.type = "button";
themeToggle.setAttribute("aria-label", "Toggle color theme");
const renderThemeLabel = (): void => {
  themeToggle.textContent = themeMode === "dark" ? "☀  Light" : "🌙  Dark";
  themeToggle.title = themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme";
};
renderThemeLabel();
themeToggle.addEventListener("click", () => {
  themeMode = themeMode === "dark" ? "light" : "dark";
  applyTheme(resolveTheme(themeMode));
  localStorage.setItem("pebble-studio:theme", themeMode);
  renderThemeLabel();
});
document.getElementById("cmdbar-actions")!.appendChild(themeToggle);

// Stage column = the live device (hero).
document.getElementById("stage-col")!.appendChild(view.el);

// Inspector column = stacked cards (Apps, Capture).
const inspector = document.getElementById("inspector")!;

const appsCard = document.createElement("section");
appsCard.className = "card";
appsCard.innerHTML = `<h2 class="card-title">Apps</h2>`;
appsCard.appendChild(library.el);

const captureCard = document.createElement("section");
captureCard.className = "card";
captureCard.innerHTML = `<h2 class="card-title">Capture</h2>`;
captureCard.appendChild(captureBar.el);

inspector.appendChild(appsCard);
inspector.appendChild(captureCard);

async function init(): Promise<void> {
  const kindEl = document.getElementById("backend-kind")!;
  try {
    const { kind } = await window.studio.initBackend();
    kindEl.textContent = kind;
    await library.refresh();
    await view.show(switcher.value);
  } catch (err) {
    kindEl.textContent = "error";
    document.getElementById("backend-pill")?.classList.add("backend-pill--error");
    console.error("backend init failed", err);
  }
}

void init();
