import { ipcMain, app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import type { PlatformId, ButtonId } from "../shared/types.js";
import { LibraryStore } from "./library.js";

let driver: BackendDriver | null = null;

export function registerIpc(): void {
  const library = new LibraryStore(path.join(app.getPath("userData"), "library.json"));

  ipcMain.handle("lib:add", async (_e, pbwPath: string) => { library.add(pbwPath); return library.list(); });
  ipcMain.handle("lib:list", async () => library.list());
  ipcMain.handle("lib:remove", async (_e, p: string) => { library.remove(p); return library.list(); });
  ipcMain.handle("lib:installAll", async () => { for (const p of library.list()) await driver!.install(p); });

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

  ipcMain.handle("capture:save", async (_e, name: string, bytes: Uint8Array) => {
    const out = path.join(app.getPath("downloads"), name);
    await fs.writeFile(out, Buffer.from(bytes));
    console.log(`[capture] saved ${out}`);
    return out;
  });
}
