import { contextBridge, ipcRenderer, webUtils } from "electron";

const studio = {
  initBackend: (): Promise<{ kind: string }> => ipcRenderer.invoke("backend:init"),
  start: (id: string) => ipcRenderer.invoke("emu:start", id),
  stop: () => ipcRenderer.invoke("emu:stop"),
  abort: (): Promise<void> => ipcRenderer.invoke("emu:abort"),
  install: (pbwPath: string) => ipcRenderer.invoke("emu:install", pbwPath),
  button: (id: string) => ipcRenderer.invoke("emu:button", id),
  accelTap: () => ipcRenderer.invoke("emu:accelTap"),
  screenshot: (out: string) => ipcRenderer.invoke("emu:screenshot", out),
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
  getTimeConfig: () => ipcRenderer.invoke("time:get"),
  setTimeConfig: (cfg: unknown) => ipcRenderer.invoke("time:set", cfg),
  // Background-throttling toggle (Task 7). Pass false to keep full-speed when
  // unfocused (the default); pass true to allow Electron's normal throttling.
  setBackgroundThrottling: (throttle: boolean): Promise<void> =>
    ipcRenderer.invoke("app:setBackgroundThrottling", throttle),
  // Subscribe to boot-progress notes (Task J). Returns a disposer that removes
  // the listener.
  onBootProgress: (cb: (msg: string) => void): (() => void) => {
    const handler = (_e: unknown, msg: string): void => cb(msg);
    ipcRenderer.on("emu:boot-progress", handler);
    return () => ipcRenderer.removeListener("emu:boot-progress", handler);
  },
};

contextBridge.exposeInMainWorld("studio", studio);

export type StudioApi = typeof studio;
