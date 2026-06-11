import { contextBridge, ipcRenderer, webUtils } from "electron";

const studio = {
  initBackend: (): Promise<{ kind: string }> => ipcRenderer.invoke("backend:init"),
  start: (id: string) => ipcRenderer.invoke("emu:start", id),
  stop: () => ipcRenderer.invoke("emu:stop"),
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
  saveCapture: (name: string, bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke("capture:save", name, bytes),
};

contextBridge.exposeInMainWorld("studio", studio);

export type StudioApi = typeof studio;
