import { contextBridge, ipcRenderer, webUtils } from "electron";
// Type-only import — erased at compile time, so the standalone esbuild preload
// bundle never pulls timeController code in at runtime.
import type { TimeConfig } from "./backend/timeController.js";
import type { SimEnvConfig } from "../shared/simEnv.js";
// Type-only — erased by esbuild, so the preload bundle never pulls the language
// controller / shared validate code in at runtime (mirrors the TimeConfig import).
import type { PackRef, Selection } from "./backend/languageController.js";
import type {
  LangCatalogResult,
  LangInstallResult,
  LangSideloadResult,
  LangActiveResult,
} from "./langIpc.js";

const studio = {
  // Task 5: `prebootBoard` (when passed) asks main to warm-boot that board right
  // after provisioning so the first Launch attaches near-instantly. The renderer
  // passes it only when the "Pre-boot emulator on app start" setting is on.
  initBackend: (opts?: { prebootBoard?: string }): Promise<{ kind: string }> =>
    ipcRenderer.invoke("backend:init", opts),
  start: (id: string) => ipcRenderer.invoke("emu:start", id),
  stop: () => ipcRenderer.invoke("emu:stop"),
  abort: (): Promise<void> => ipcRenderer.invoke("emu:abort"),
  install: (pbwPath: string) => ipcRenderer.invoke("emu:install", pbwPath),
  button: (id: string, action?: string) => ipcRenderer.invoke("emu:button", id, action),
  accelTap: () => ipcRenderer.invoke("emu:accelTap"),
  // Backlight-free framebuffer screenshot. Pass a capture filename; resolves with
  // the saved absolute path, or null on ANY failure (renderer then falls back to
  // the VNC-canvas + backlight grab).
  screenshotFramebuffer: (name: string): Promise<string | null> =>
    ipcRenderer.invoke("emu:screenshotFramebuffer", name),
  libAdd: (pbwPath: string) => ipcRenderer.invoke("lib:add", pbwPath),
  libList: () => ipcRenderer.invoke("lib:list"),
  libRemove: (p: string) => ipcRenderer.invoke("lib:remove", p),
  libInstallAll: () => ipcRenderer.invoke("lib:installAll"),
  loadedList: (): Promise<string[]> => ipcRenderer.invoke("loaded:list"),
  loadedClear: (platformId: string) => ipcRenderer.invoke("loaded:clear", platformId),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  pickPbw: (): Promise<string[]> => ipcRenderer.invoke("dialog:pickPbw"),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickDirectory"),
  setCaptureDir: (dir: string): Promise<void> => ipcRenderer.invoke("settings:setCaptureDir", dir),
  saveCapture: (name: string, bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke("capture:save", name, bytes),
  nextCaptureName: (base: string, ext: string): Promise<string> =>
    ipcRenderer.invoke("capture:nextName", base, ext),
  // Backlight keepalive toggles (Task K).
  backlightAlways: (on: boolean): Promise<void> =>
    ipcRenderer.invoke("emu:backlightAlways", on),
  backlightCaptureHold: (on: boolean): Promise<void> =>
    ipcRenderer.invoke("emu:backlightCaptureHold", on),
  backlightMethod: (m: string): Promise<void> =>
    ipcRenderer.invoke("emu:backlightMethod", m),
  backlightPulse: (): Promise<void> => ipcRenderer.invoke("emu:backlightPulse"),
  // Time control (Task 5).
  getTimeConfig: (): Promise<TimeConfig> => ipcRenderer.invoke("time:get"),
  setTimeConfig: (cfg: TimeConfig): Promise<void> => ipcRenderer.invoke("time:set", cfg),
  // Time-shim readiness (v0.0.13): false → legacy offset fallback limits apply.
  timeStatus: (): Promise<{ shim: boolean; checked: boolean }> => ipcRenderer.invoke("time:status"),
  timelineQuickView: (on: boolean): Promise<void> => ipcRenderer.invoke("emu:timelineQuickView", on),
  setBattery: (percent: number, charging: boolean): Promise<void> =>
    ipcRenderer.invoke("emu:battery", percent, charging),
  // Simulated location & weather (sim-env control file).
  simGet: (): Promise<SimEnvConfig> => ipcRenderer.invoke("sim:get"),
  simSet: (cfg: SimEnvConfig): Promise<{ rebooted: boolean }> => ipcRenderer.invoke("sim:set", cfg),
  activateHealth: (): Promise<{ ok: boolean; status: number | null; detail: string }> =>
    ipcRenderer.invoke("emu:activateHealth"),
  // Clay / AppConfig (Task B2). clayOpenWindow resolves with the RAW
  // still-percent-encoded close fragment ("" = cancelled).
  clayPhonesimPort: (): Promise<number | null> => ipcRenderer.invoke("clay:phonesimPort"),
  clayOpenWindow: (url: string): Promise<string> => ipcRenderer.invoke("clay:openWindow", url),
  // Background-throttling toggle (Task 7). Pass false to keep full-speed when
  // unfocused (the default); pass true to allow Electron's normal throttling.
  setBackgroundThrottling: (throttle: boolean): Promise<void> =>
    ipcRenderer.invoke("app:setBackgroundThrottling", throttle),
  // Pebble SDK management (native-Windows). sdkInfo reports the active version +
  // source; sdkInstall opens a picker then installs the chosen SDK ("Replace &
  // persist"); sdkReset returns to the bundled SDK. install/reset resolve null
  // only when the user cancels the picker.
  sdkInfo: (): Promise<{ version: string; source: "custom" | "bundled"; fullLauncher: boolean }> =>
    ipcRenderer.invoke("sdk:info"),
  sdkInstall: (mode?: "file" | "folder"): Promise<{ version: string; source: "custom" | "bundled"; fullLauncher: boolean } | null> =>
    ipcRenderer.invoke("sdk:install", mode),
  sdkReset: (): Promise<{ version: string; source: "custom" | "bundled"; fullLauncher: boolean }> =>
    ipcRenderer.invoke("sdk:reset"),
  // Toggle the full PebbleOS launcher on the active custom SDK (opt-in overlay).
  // apply returns a per-board report; revert returns the reverted boards. Both
  // return the refreshed SDK info.
  sdkApplyFullLauncher: (): Promise<{
    report: { applied: string[]; skippedNewer: string[]; skippedMissing: string[] };
    info: { version: string; source: "custom" | "bundled"; fullLauncher: boolean };
    changed: boolean;
  }> => ipcRenderer.invoke("sdk:applyFullLauncher"),
  sdkRevertFullLauncher: (): Promise<{
    reverted: string[];
    info: { version: string; source: "custom" | "bundled"; fullLauncher: boolean };
    changed: boolean;
  }> => ipcRenderer.invoke("sdk:revertFullLauncher"),
  // Language packs (Task 10, native-Windows). catalog lists Rebble packs for the
  // active firmware; install/sideload apply a pack (resolving { language }/{ pack }
  // or a surfaced { error } string); active reports the watch's current language;
  // getSelection/setSelection persist the per-board choice re-asserted on boot. On
  // a non-native backend the handlers resolve a clear not-supported payload.
  lang: {
    catalog: (board: string): Promise<LangCatalogResult> =>
      ipcRenderer.invoke("lang:catalog", board),
    install: (board: string, ref: PackRef): Promise<LangInstallResult> =>
      ipcRenderer.invoke("lang:install", board, ref),
    sideload: (): Promise<LangSideloadResult> => ipcRenderer.invoke("lang:sideload"),
    active: (board: string): Promise<LangActiveResult> =>
      ipcRenderer.invoke("lang:active", board),
    getSelection: (board: string): Promise<Selection | null> =>
      ipcRenderer.invoke("lang:selection", board),
    setSelection: (board: string, sel: Selection | null): Promise<void> =>
      ipcRenderer.invoke("lang:setSelection", board, sel),
  },
  // App version (v1.0.0) — for the Help → What's New modal header.
  appVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  // Subscribe to application-menu actions (v1.0.0). Returns a disposer.
  onMenu: (cb: (action: string) => void): (() => void) => {
    const handler = (_e: unknown, action: string): void => cb(action);
    ipcRenderer.on("menu:action", handler);
    return () => ipcRenderer.removeListener("menu:action", handler);
  },
  // Subscribe to boot-progress notes (Task J). Returns a disposer that removes
  // the listener.
  onBootProgress: (cb: (msg: string) => void): (() => void) => {
    const handler = (_e: unknown, msg: string): void => cb(msg);
    ipcRenderer.on("emu:boot-progress", handler);
    return () => ipcRenderer.removeListener("emu:boot-progress", handler);
  },
  // Subscribe to bridge-death notifications (Task H4). Returns a disposer that
  // removes the listener.
  onBridgeDead: (cb: (reason: string) => void): (() => void) => {
    const handler = (_e: unknown, reason: string): void => cb(reason);
    ipcRenderer.on("emu:bridge-dead", handler);
    return () => ipcRenderer.removeListener("emu:bridge-dead", handler);
  },
  // Issue 3: emulator app-log stream. onAppLog subscribes to live lines (returns a
  // disposer); getAppLogHistory back-fills the panel when first opened.
  onAppLog: (cb: (line: string) => void): (() => void) => {
    const handler = (_e: unknown, line: string): void => cb(line);
    ipcRenderer.on("emu:app-log", handler);
    return () => ipcRenderer.removeListener("emu:app-log", handler);
  },
  getAppLogHistory: (): Promise<string[]> => ipcRenderer.invoke("emu:appLogHistory"),
  // Enable/disable the emulator app-log stream (driven by the Settings toggle). Off
  // by default so the stream never contends for the pypkjs bridge unless requested.
  setLogCapture: (on: boolean): Promise<void> => ipcRenderer.invoke("emu:logCapture", on),
};

contextBridge.exposeInMainWorld("studio", studio);

export type StudioApi = typeof studio;
