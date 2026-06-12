import { ipcMain, app, dialog } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import type { BootToken } from "./backend/bootEmulator.js";
import type { PlatformId, ButtonId } from "../shared/types.js";
import { LibraryStore } from "./library.js";

let driver: BackendDriver | null = null;

/**
 * The cancellation token for the current/most-recent boot. `emu:start` creates a
 * fresh one; `emu:abort` and `emu:stop` flip `cancelled` so an in-flight boot's
 * wait loops bail promptly instead of blocking up to the full readiness timeout.
 */
let currentBootToken: BootToken | null = null;

/**
 * The directory captures are written to. Defaults to the user's Downloads; the
 * renderer can repoint it via `settings:setCaptureDir`.
 */
let captureDir: string | null = null;

/**
 * The set of .pbw paths currently installed on the running emulator.
 * Populated when install succeeds; cleared when the emulator is stopped or wiped.
 */
const loaded = new Set<string>();

/**
 * Resolve + validate a capture filename against a configured directory.
 *
 * Pure (no fs) so it is unit-testable. Strips any directory component, enforces
 * a png/gif filename whitelist, and confirms the resolved path stays INSIDE the
 * configured dir (defense-in-depth against traversal). Throws on any violation.
 */
export function resolveCapturePath(dir: string, name: string): string {
  const safeName = path.basename(name);
  if (!/^[\w.\- ]+\.(png|gif)$/i.test(safeName)) {
    throw new Error(`invalid capture filename: ${name}`);
  }
  const base = path.resolve(dir);
  const out = path.resolve(base, safeName);
  if (out !== path.join(base, safeName) || !out.startsWith(base + path.sep)) {
    throw new Error("capture path escapes capture directory");
  }
  return out;
}

export function registerIpc(): void {
  const library = new LibraryStore(path.join(app.getPath("userData"), "library.json"));
  // Default capture target is the user's Downloads; settings:setCaptureDir can
  // repoint it. Resolved here (not at module load) so app paths are ready.
  captureDir = path.resolve(app.getPath("downloads"));

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
  ipcMain.handle("emu:start", async (_e, id: PlatformId) => {
    // Fresh token per boot, stored as current so abort/stop can cancel it.
    const token: BootToken = { cancelled: false };
    currentBootToken = token;
    return driver!.start(id, token);
  });
  ipcMain.handle("emu:abort", async () => {
    // Cancel any in-flight boot so its wait loops bail promptly. No-op (no throw)
    // if nothing is booting.
    if (currentBootToken) currentBootToken.cancelled = true;
  });
  ipcMain.handle("emu:stop", async () => {
    // Cancel the in-flight boot BEFORE teardown so a mid-boot wait aborts and the
    // killAll sweep reliably reaps qemu/websockify/emu-control/pypkjs.
    if (currentBootToken) currentBootToken.cancelled = true;
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

  ipcMain.handle("dialog:pickDirectory", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Select capture folder",
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("settings:setCaptureDir", async (_e, dir: string) => {
    // Validate: must be an absolute path that exists and is a directory.
    if (typeof dir !== "string" || !path.isAbsolute(dir)) {
      throw new Error(`capture dir must be an absolute path: ${dir}`);
    }
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`capture dir does not exist or is not a directory: ${dir}`);
    }
    captureDir = path.resolve(dir);
  });

  ipcMain.handle("capture:save", async (_e, name: string, bytes: Uint8Array) => {
    // Resolve + sanitize against the configured capture dir (filename whitelist +
    // path stays inside the dir). Falls back to Downloads if unset.
    const dir = captureDir ?? path.resolve(app.getPath("downloads"));
    const out = resolveCapturePath(dir, name);
    await fs.writeFile(out, Buffer.from(bytes));
    console.log(`[capture] saved ${out}`);
    return out;
  });
}
