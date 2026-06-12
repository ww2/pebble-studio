import { resolveTheme, applyTheme } from "./theme.js";
import { EmulatorView } from "./components/EmulatorView.js";
import { VersionSwitcher } from "./components/VersionSwitcher.js";
import { AppLibrary } from "./components/AppLibrary.js";
import { CaptureBar } from "./components/CaptureBar.js";
import { NavRail } from "./components/NavRail.js";
import { SettingsPane } from "./components/SettingsPane.js";
import type { PlatformId } from "../shared/types.js";
import { getPlatform, PLATFORMS } from "../main/backend/emulatorRegistry.js";
import { detectHostTimezone, type TimeConfig } from "../main/backend/timeController.js";

interface StudioApi {
  initBackend(): Promise<{ kind: string }>;
  start(id: string): Promise<{ host: string; port: number; wsPath: string }>;
  stop(): Promise<unknown>;
  abort(): Promise<void>;
  install(pbwPath: string): Promise<unknown>;
  button(id: string): Promise<unknown>;
  accelTap(): Promise<unknown>;
  screenshot(out: string): Promise<unknown>;
  pickDirectory(): Promise<string | null>;
  setCaptureDir(dir: string): Promise<void>;
  libAdd(pbwPath: string): Promise<string[]>;
  libList(): Promise<string[]>;
  libRemove(p: string): Promise<string[]>;
  libInstallAll(): Promise<void>;
  loadedList(): Promise<string[]>;
  loadedClear(platformId: string): Promise<unknown>;
  pathForFile(file: File): string;
  pickPbw(): Promise<string[]>;
  saveCapture(name: string, bytes: Uint8Array): Promise<string>;
  // v0.0.6 (Wave 1 preload): boot-progress notes, capture naming, backlight.
  onBootProgress(cb: (msg: string) => void): () => void;
  nextCaptureName(base: string, ext: string): Promise<string>;
  backlightAlways(on: boolean): Promise<void>;
  backlightCaptureHold(on: boolean): Promise<void>;
  backlightMethod(m: string): Promise<void>;
  backlightPulse(): Promise<void>;
  // v0.0.7: time control (Task 5) and background-throttling toggle (Task 7).
  getTimeConfig(): Promise<TimeConfig>;
  setTimeConfig(cfg: TimeConfig): Promise<void>;
  // v0.0.13: time-shim readiness — false means the legacy offset fallback is active.
  timeStatus(): Promise<{ shim: boolean }>;
  setBackgroundThrottling(throttle: boolean): Promise<void>;
  // v0.0.8: timeline quick-view (Task 1).
  timelineQuickView(on: boolean): Promise<void>;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

type ThemeChoice = "light" | "dark";
const themeMode: ThemeChoice =
  localStorage.getItem("pebble-studio:theme") === "light" ? "light" : "dark";
applyTheme(resolveTheme(themeMode));

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="app-backdrop" aria-hidden="true"></div>
  <div class="app-shell">
    <header class="cmdbar">
      <div class="cmdbar-brand">
        <span class="brand-mark" aria-hidden="true">P</span>
        <span class="brand-name type-body-strong">Pebble Studio</span>
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
      <div class="nav-rail-host" id="nav-rail-host"></div>
      <section class="stage-col" id="stage-col"></section>
      <aside class="inspector" id="inspector">
        <div class="inspector-pane" id="inspector-pane"></div>
      </aside>
    </div>
  </div>
`;

// Default watch = Pebble Time 2 (emery); restore the last-used watch, falling
// back to emery on first run / invalid persisted value.
const storedPlatform = localStorage.getItem("pebble-studio:platform");
const initialPlatform: PlatformId =
  PLATFORMS.some((p) => p.id === storedPlatform) ? (storedPlatform as PlatformId) : "emery";

// Boot mode: "manual" (default) loads a model's chrome idle with a Launch button;
// "auto" boots on selection. main.ts owns the live value so selectPlatform() and
// startup both consult it; the Settings toggle updates it via setBootMode().
type BootMode = "auto" | "manual";
let bootMode: BootMode =
  localStorage.getItem("pebble-studio:boot-mode") === "auto" ? "auto" : "manual";

const view = new EmulatorView();

// Non-system-time badge: keep it in sync with the time config. Registered BEFORE
// SettingsPane is constructed so we catch its startup dispatch (pushTimeConfig
// fires `pebble-studio:time-changed` once on construction).
const hostTz = detectHostTimezone();
window.addEventListener("pebble-studio:time-changed", (e) => {
  const cfg = (e as CustomEvent).detail as TimeConfig | null;
  view.setTimeBadge(cfg, hostTz);
});

// Persist the active platform and keep both the top combo and the Settings
// "Startup watch" dropdown in sync, regardless of which control changed it.
// In manual mode this only morphs to the new chrome; in auto mode it boots.
function selectPlatform(id: PlatformId): void {
  localStorage.setItem("pebble-studio:platform", id);
  switcher.value = id;        // no-op set when the combo originated the change
  settings.setPlatform(id);   // no-op set when Settings originated the change
  void view.show(id, { boot: bootMode === "auto" });
}

const switcher = new VersionSwitcher((id: PlatformId) => selectPlatform(id), initialPlatform);
const library = new AppLibrary(
  () => switcher.value,
  (platformId: string) => view.reconnectAfterClear(platformId as PlatformId),
  () => view.isLive(),
);
const captureBar = new CaptureBar(
  () => document.querySelector<HTMLElement>("#emu-screen"),
  () => getPlatform(switcher.value as PlatformId).round,
  () => switcher.value, // platform id (codename, e.g. "emery") for capture names
);
const settings = new SettingsPane(themeMode, initialPlatform, (id: PlatformId) => selectPlatform(id), {
  initialBootMode: bootMode,
  onBootModeChange: (mode: BootMode) => {
    bootMode = mode;
    localStorage.setItem("pebble-studio:boot-mode", mode);
  },
  // Diagnostics toggle (J): flip EmulatorView's overlay live when Settings changes.
  onDiagnosticsChange: (on: boolean) => view.setDiagnostics(on),
});

// Command bar: version switcher (Fluent combobox) controls the persistent
// live preview, so it stays in the top command bar. The theme toggle now lives
// in the Settings pane.
const combo = document.getElementById("version-combo")!;
combo.appendChild(switcher.el);

// Stage column = the persistent live device (primary content).
document.getElementById("stage-col")!.appendChild(view.el);

// ── Right inspector: a single swappable pane driven by the nav rail ─────────
const pane = document.getElementById("inspector-pane")!;

function buildCard(title: string, body: HTMLElement): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  const heading = document.createElement("h2");
  heading.className = "card-title type-body-strong";
  heading.textContent = title;
  card.append(heading, body);
  return card;
}

const panes: Record<string, HTMLElement> = {
  apps: buildCard("Apps", library.el),
  capture: buildCard("Capture", captureBar.el),
  settings: buildCard("Settings", settings.el),
};

function showPane(id: string): void {
  const next = panes[id];
  if (!next) return;
  pane.replaceChildren(next);
}

const navRail = new NavRail(
  [
    { id: "apps", label: "Apps", glyph: "▦" },
    { id: "capture", label: "Capture", glyph: "◉" },
    { id: "settings", label: "Settings", glyph: "⚙" },
  ],
  showPane,
  "apps",
);
document.getElementById("nav-rail-host")!.appendChild(navRail.el);
showPane(navRail.value);

// D (v0.0.6): one-shot entrance treatment — the nav rail, stage, and inspector
// fade/slide in with a small stagger on first paint so the UI never looks frozen.
// The `app-enter` class drives staggered CSS keyframes (per-column delays);
// `prefers-reduced-motion` keeps everything instant (see app.css). The class is
// dropped once the animation finishes so it stays a first-paint-only effect.
const shell = document.querySelector<HTMLElement>(".app-shell");
if (shell) {
  shell.classList.add("app-enter");
  shell.addEventListener(
    "animationend",
    () => shell.classList.remove("app-enter"),
    { once: true },
  );
}

async function init(): Promise<void> {
  const kindEl = document.getElementById("backend-kind")!;

  // J (v0.0.6): restore the diagnostics flag into EmulatorView. Canonical truthy
  // value is the string "on" (matches EmulatorView's own startup reader).
  view.setDiagnostics(localStorage.getItem("pebble-studio:diagnostics") === "on");

  // Sync the persisted capture directory into main once (CaptureBar then saves
  // through it). Unset = main keeps its Downloads default.
  const storedCaptureDir = localStorage.getItem("pebble-studio:capture-dir");
  if (storedCaptureDir) {
    try {
      await window.studio.setCaptureDir(storedCaptureDir);
    } catch (err) {
      console.warn("[main] setCaptureDir on startup failed (ignored):", err);
    }
  }

  try {
    const { kind } = await window.studio.initBackend();
    kindEl.textContent = kind;
    await library.refresh();
    // Manual (default): load the chrome idle with a Launch button — do NOT boot.
    // Auto: boot the resolved startup watch.
    await view.show(switcher.value, { boot: bootMode === "auto" });
  } catch (err) {
    kindEl.textContent = "error";
    document.getElementById("backend-pill")?.classList.add("backend-pill--error");
    console.error("backend init failed", err);
  }
}

void init();
