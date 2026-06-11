import { ipcMain, app, dialog } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import type { PlatformId, ButtonId } from "../shared/types.js";
import { LibraryStore } from "./library.js";

let driver: BackendDriver | null = null;

/**
 * The set of .pbw paths currently installed on the running emulator.
 * Populated when install succeeds; cleared when the emulator is stopped or wiped.
 */
const loaded = new Set<string>();

export function registerIpc(): void {
  const library = new LibraryStore(path.join(app.getPath("userData"), "library.json"));

  ipcMain.handle("lib:add", async (_e, pbwPath: string) => { library.add(pbwPath); return library.list(); });
  ipcMain.handle("lib:list", async () => library.list());
  ipcMain.handle("lib:remove", async (_e, p: string) => { library.remove(p); return library.list(); });
  ipcMain.handle("lib:installAll", async () => {
    for (const p of library.list()) {
      await driver!.install(p);
      loaded.add(p);
    }
  });

  ipcMain.handle("loaded:list", async () => Array.from(loaded));
  ipcMain.handle("loaded:clear", async (_e, platformId: PlatformId) => {
    // 1. Stop the running emulator so wipe can safely delete its files.
    try { await driver!.stop(); } catch { /* ignore — may already be stopped */ }
    loaded.clear();
    // 2. Wipe all emulator data (all platforms for the current SDK version).
    await driver!.wipe();
    // 3. Reboot the current platform clean — WITHOUT reinstalling library apps
    //    (that's what "clear" means: the watch starts fresh with no user apps).
    await driver!.start(platformId);
    // loaded remains empty after the clear reboot.
  });

  ipcMain.handle("dialog:pickPbw", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Select .pbw file(s)",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Pebble apps", extensions: ["pbw"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("backend:init", async () => {
    const { driver: d, kind } = await createDriver();
    driver = d;
    console.log(`[backend] initialized kind=${kind}`);
    return { kind };
  });
  ipcMain.handle("emu:start", async (_e, id: PlatformId) => driver!.start(id));
  ipcMain.handle("emu:stop", async () => {
    await driver!.stop();
    loaded.clear();
  });
  ipcMain.handle("emu:install", async (_e, pbwPath: string) => {
    await driver!.install(pbwPath);
    loaded.add(pbwPath);
  });
  ipcMain.handle("emu:button", async (_e, id: ButtonId) => driver!.button(id, "press"));
  ipcMain.handle("emu:accelTap", async () => driver!.accelTap());
  ipcMain.handle("emu:screenshot", async (_e, out: string) => driver!.screenshot(out));

  ipcMain.handle("capture:save", async (_e, name: string, bytes: Uint8Array) => {
    // Sanitize the filename: strip any directory component and confirm the
    // resolved path stays inside Downloads (defense-in-depth against traversal).
    const safeName = path.basename(name);
    if (!/^[\w.\- ]+\.(png|gif)$/i.test(safeName)) {
      throw new Error(`invalid capture filename: ${name}`);
    }
    const downloads = path.resolve(app.getPath("downloads"));
    const out = path.resolve(downloads, safeName);
    if (out !== path.join(downloads, safeName) || !out.startsWith(downloads + path.sep)) {
      throw new Error("capture path escapes downloads directory");
    }
    await fs.writeFile(out, Buffer.from(bytes));
    console.log(`[capture] saved ${out}`);
    return out;
  });
}
