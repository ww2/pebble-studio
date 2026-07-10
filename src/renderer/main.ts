import { resolveTheme, applyTheme } from "./theme.js";
import { EmulatorView } from "./components/EmulatorView.js";
import { VersionSwitcher } from "./components/VersionSwitcher.js";
import { AppLibrary } from "./components/AppLibrary.js";
import { ChangelogModal } from "./components/ChangelogModal.js";
import { CaptureBar } from "./components/CaptureBar.js";
import { NavRail } from "./components/NavRail.js";
import { SettingsPane } from "./components/SettingsPane.js";
import type { PlatformId } from "../shared/types.js";
import { getPlatform, PLATFORMS } from "../main/backend/emulatorRegistry.js";
import { detectHostTimezone, type TimeConfig } from "../main/backend/timeController.js";

interface StudioApi {
  initBackend(opts?: { prebootBoard?: string }): Promise<{ kind: string }>;
  start(id: string): Promise<{ host: string; port: number; wsPath: string }>;
  stop(): Promise<unknown>;
  abort(): Promise<void>;
  install(pbwPath: string): Promise<unknown>;
  button(id: string, action?: string): Promise<unknown>;
  accelTap(): Promise<unknown>;
  // Backlight-free framebuffer screenshot. Resolves with the saved absolute path,
  // or null on ANY failure (renderer falls back to the canvas + backlight grab).
  screenshotFramebuffer(name: string): Promise<string | null>;
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
  // v0.0.13 (Task H4): bridge-dead notifications from the health monitor.
  onBridgeDead(cb: (reason: string) => void): () => void;
  // v3.0.2 (Issue 3): emulator app-log stream.
  onAppLog(cb: (line: string) => void): () => void;
  getAppLogHistory(): Promise<string[]>;
  setLogCapture(on: boolean): Promise<void>;
  nextCaptureName(base: string, ext: string): Promise<string>;
  backlightAlways(on: boolean): Promise<void>;
  backlightCaptureHold(on: boolean): Promise<void>;
  backlightMethod(m: string): Promise<void>;
  backlightPulse(): Promise<void>;
  // v0.0.7: time control (Task 5) and background-throttling toggle (Task 7).
  getTimeConfig(): Promise<TimeConfig>;
  setTimeConfig(cfg: TimeConfig): Promise<void>;
  // v0.0.13: time-shim readiness — false means the legacy offset fallback is active.
  timeStatus(): Promise<{ shim: boolean; checked: boolean }>;
  setBackgroundThrottling(throttle: boolean): Promise<void>;
  // v0.0.8: timeline quick-view (Task 1).
  timelineQuickView(on: boolean): Promise<void>;
  // battery control (feat/battery-and-health).
  setBattery(percent: number, charging: boolean): Promise<void>;
  // health activation (feat/battery-and-health).
  activateHealth(): Promise<{ ok: boolean; status: number | null; detail: string }>;
  // simulated environment (Task 8).
  simGet(): Promise<import("../shared/simEnv.js").SimEnvConfig>;
  simSet(cfg: import("../shared/simEnv.js").SimEnvConfig): Promise<{ rebooted: boolean }>;
  // v0.0.13: Clay / per-app config (Task B). clayOpenWindow resolves with the
  // RAW still-percent-encoded close fragment ("" = cancelled).
  clayPhonesimPort(): Promise<number | null>;
  clayOpenWindow(url: string): Promise<string>;
  // v3.0.3: Pebble SDK management. sdkInfo reports the active version + source;
  // sdkInstall opens a picker then installs ("Replace & persist", null = cancel);
  // sdkReset returns to the bundled SDK.
  sdkInfo(): Promise<{ version: string; source: "custom" | "bundled"; fullLauncher: boolean }>;
  sdkInstall(mode?: "file" | "folder"): Promise<{ version: string; source: "custom" | "bundled"; fullLauncher: boolean } | null>;
  sdkReset(): Promise<{ version: string; source: "custom" | "bundled"; fullLauncher: boolean }>;
  // v1.0.0: app version + application-menu action subscription.
  appVersion(): Promise<string>;
  onMenu(cb: (action: string) => void): () => void;
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

// Startup watch = an explicit, persistent preference (Settings → "Startup watch"),
// decoupled from the active watch: switching watches via the top combo no longer
// overwrites it, so the app always boots into the chosen startup watch. Migrate the
// pre-decoupling key (`pebble-studio:platform`, the last-used watch) as the initial
// default; fall back to Pebble Time 2 (emery) on first run / invalid value.
const storedStartup =
  localStorage.getItem("pebble-studio:startup-watch") ??
  localStorage.getItem("pebble-studio:platform");
const initialPlatform: PlatformId =
  PLATFORMS.some((p) => p.id === storedStartup) ? (storedStartup as PlatformId) : "emery";

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

// Switch the ACTIVE (live) watch via the top combo. This is session-only and
// intentionally does NOT persist as the startup watch — the next launch still
// opens the watch chosen in Settings → "Startup watch". In manual mode this only
// morphs to the new chrome; in auto mode it boots.
function selectPlatform(id: PlatformId): void {
  switcher.value = id; // no-op set when the combo originated the change
  void view.show(id, { boot: bootMode === "auto" });
}

const switcher = new VersionSwitcher((id: PlatformId) => selectPlatform(id), initialPlatform);
const library = new AppLibrary(
  () => switcher.value,
  (platformId: string) => view.reconnectAfterClear(platformId as PlatformId),
  () => view.isLive(),
);

// Application-menu wiring (v1.0.0): File → Install PBW / Clear Emulator reuse the
// AppLibrary flows; Help → What's New opens the changelog modal.
const changelogModal = new ChangelogModal(
  () => window.studio.appVersion(),
  () => window.studio.sdkInfo(), // re-queried each open → reflects the latest SDK upload/reset
);
// Disposer kept for the app lifetime (renderer is a singleton); stored rather
// than discarded so the subscription is explicit and test-cleanable.
const disposeMenu = window.studio.onMenu((action) => {
  if (action === "install-pbw") void library.pickAndInstall();
  else if (action === "clear-emulator") void library.clearEmulator();
  else if (action === "changelog") void changelogModal.open();
});
window.addEventListener("beforeunload", () => disposeMenu());
const captureBar = new CaptureBar(
  () => document.querySelector<HTMLElement>("#emu-screen"),
  () => getPlatform(switcher.value as PlatformId).round,
  () => switcher.value, // platform id (codename, e.g. "emery") for capture names
);
const settings = new SettingsPane(themeMode, initialPlatform, (id: PlatformId) => {
  // Settings → "Startup watch": persist the explicit startup preference only.
  // It does NOT switch the live watch (use the top combo for that).
  localStorage.setItem("pebble-studio:startup-watch", id);
}, {
  initialBootMode: bootMode,
  onBootModeChange: (mode: BootMode) => {
    bootMode = mode;
    localStorage.setItem("pebble-studio:boot-mode", mode);
  },
  // Diagnostics toggle (J): flip EmulatorView's overlay live when Settings changes.
  onDiagnosticsChange: (on: boolean) => view.setDiagnostics(on),
  // Applying sim weather reboots the emulator (to clear watchface fetch caches);
  // reconnect VNC afterwards, same as "Clear emulator". switcher is the live board.
  onWeatherRefreshReconnect: () => view.reconnectAfterClear(switcher.value as PlatformId),
  // Suppress the bridge-dead/auto-relaunch path while that backend reboot runs,
  // so the expected restart isn't mistaken for a crash (begin) and is re-armed if
  // no reboot occurred or the apply failed (end).
  onWeatherRefreshBegin: () => view.beginExternalReboot(),
  onWeatherRefreshEnd: () => view.endExternalReboot(),
  // SDK upload/reset swaps the active SDK; if the emulator is live the backend
  // tears it down, so relaunch it here to pick up the new SDK automatically.
  isEmuLive: () => view.isLive(),
  onSdkRelaunch: () => view.relaunch(),
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
    // Warm-standby pre-boot (Task 5): when enabled (default on), ask main to boot
    // the startup watch in the background right after provisioning so the first
    // Launch attaches near-instantly. `switcher.value` is the resolved startup
    // watch here. Passing no board leaves main cold (setting off).
    const prebootEnabled = localStorage.getItem("pebble-studio:preboot-startup") !== "false";
    const { kind } = await window.studio.initBackend(
      prebootEnabled ? { prebootBoard: switcher.value } : {},
    );
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
