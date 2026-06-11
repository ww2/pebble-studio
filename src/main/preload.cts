import { contextBridge, ipcRenderer } from "electron";

const studio = {
  initBackend: (): Promise<{ kind: string }> => ipcRenderer.invoke("backend:init"),
  start: (id: string) => ipcRenderer.invoke("emu:start", id),
  stop: () => ipcRenderer.invoke("emu:stop"),
  install: (pbwPath: string) => ipcRenderer.invoke("emu:install", pbwPath),
  button: (id: string) => ipcRenderer.invoke("emu:button", id),
  accelTap: () => ipcRenderer.invoke("emu:accelTap"),
  screenshot: (out: string) => ipcRenderer.invoke("emu:screenshot", out),
};

contextBridge.exposeInMainWorld("studio", studio);

export type StudioApi = typeof studio;
