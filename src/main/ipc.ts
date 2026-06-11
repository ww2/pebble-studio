import { ipcMain } from "electron";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import type { PlatformId, ButtonId } from "../shared/types.js";

let driver: BackendDriver | null = null;

export function registerIpc(): void {
  ipcMain.handle("backend:init", async () => {
    const { driver: d, kind } = await createDriver();
    driver = d;
    console.log(`[backend] initialized kind=${kind}`);
    return { kind };
  });
  ipcMain.handle("emu:start", async (_e, id: PlatformId) => driver!.start(id));
  ipcMain.handle("emu:stop", async () => driver!.stop());
  ipcMain.handle("emu:install", async (_e, pbwPath: string) => driver!.install(pbwPath));
  ipcMain.handle("emu:button", async (_e, id: ButtonId) => driver!.button(id, "press"));
  ipcMain.handle("emu:accelTap", async () => driver!.accelTap());
  ipcMain.handle("emu:screenshot", async (_e, out: string) => driver!.screenshot(out));
}
