import { ipcMain, app, dialog } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import type { BootToken } from "./backend/bootEmulator.js";
import type { DriverKind } from "./backend/driverFactory.js";
import { createBacklightController } from "./backend/backlight.js";
import { makeTimeController, type TimeConfig } from "./backend/timeController.js";
import type { PlatformId, ButtonId } from "../shared/types.js";
import { LibraryStore } from "./library.js";

let driver: BackendDriver | null = null;

/**
 * The active driver kind (native | wsl), recorded at `backend:init`. The backlight
 * controller uses it to pick the matching Shell (native vs wsl) for reading the
 * emulator state file, mirroring how createDriver decides.
 */
let driverKind: DriverKind | null = null;

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
 * The set of .pbw paths currently installed on the emulator's on-disk data dir.
 * Populated when install succeeds; cleared ONLY on a real wipe (loaded:clear).
 * A plain stop/kill preserves installed apps on disk, so it must NOT clear this.
 * Known limitation: a fresh app process starts with an empty set even if apps
 * persist on disk from a previous run (no cross-process persistence by design).
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

/**
 * Find the highest existing capture index for a base (Task G).
 *
 * Pure (no fs) so it is unit-testable. Scans `existingNames` for files matching
 * `^<base>-(\d+)\.<ext>$` (ext + base matched case-insensitively, base regex-
 * escaped) and returns the highest index found, or -1 when none match. The next
 * filename is then `<base>-<nextIndexedName(...) + 1>.<ext>` (so it starts at 1).
 */
export function nextIndexedName(existingNames: string[], base: string, ext: string): number {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-(\\d+)\\.${ext}$`, "i");
  let max = -1;
  for (const name of existingNames) {
    const m = re.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

export function registerIpc(): void {
  const library = new LibraryStore(path.join(app.getPath("userData"), "library.json"));
  // Default capture target is the user's Downloads; settings:setCaptureDir can
  // repoint it. Resolved here (not at module load) so app paths are ready.
  captureDir = path.resolve(app.getPath("downloads"));

  // Backlight keepalive (Task K). It reads the qemu monitor port through the
  // Shell matching the active driver kind (recorded at backend:init), so it works
  // on a Windows+WSL host too.
  const backlight = createBacklightController(() => driverKind, () => driver!.accelTap());

  // Time controller (Task 5). Uses a getter so it always references the current driver.
  const time = makeTimeController(() => driver);

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
    void time.applyAll(); // re-assert time settings on the clear-rebooted emulator (fire-and-forget)
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
    driverKind = kind;
    console.log(`[backend] initialized kind=${kind}`);
    return { kind };
  });
  ipcMain.handle("emu:start", async (e, id: PlatformId) => {
    // Fresh token per boot, stored as current so abort/stop can cancel it.
    const token: BootToken = { cancelled: false };
    currentBootToken = token;
    // Forward each boot step to the renderer (diagnostic boot notes, Task J).
    const onStep = (msg: string): void => { e.sender.send("emu:boot-progress", msg); };
    const ep = await driver!.start(id, token, onStep);
    void time.applyAll(); // re-assert time settings on the fresh emulator (fire-and-forget)
    return ep;
  });
  ipcMain.handle("emu:abort", async () => {
    // Cancel any in-flight boot so its wait loops bail promptly. No-op (no throw)
    // if nothing is booting.
    if (currentBootToken) currentBootToken.cancelled = true;
  });
  ipcMain.handle("emu:stop", async () => {
    // Stop the backlight keepalive and time controller first so we don't tap a dead emulator.
    backlight.stop();
    time.stop();
    // Cancel the in-flight boot BEFORE teardown so a mid-boot wait aborts and the
    // killAll sweep reliably reaps qemu/websockify/emu-control/pypkjs.
    if (currentBootToken) currentBootToken.cancelled = true;
    await driver!.stop();
    // NOTE: do NOT clear `loaded` here. A stop/kill (killAll) only reaps the
    // qemu/websockify/pypkjs/emu-control processes + the state file — it does NOT
    // delete installed apps, which persist on disk and are removed ONLY by
    // `pebble wipe` (driver.wipe(), called from loaded:clear). Clearing the set on
    // stop desynced it from disk: after a relaunch/force-close/model-switch the
    // apps were still installed but `loaded` was empty, so loaded:list returned []
    // and the renderer's "Clear emulator" button stayed disabled. The set now
    // mirrors on-disk install state and is cleared only on a real wipe.
  });

  // Backlight keepalive toggles (Task K). "Always on" is independent of captures;
  // "capture hold" is held only for a capture's duration. The interval runs while
  // either is set and stops when both clear (or on emu:stop above).
  ipcMain.handle("emu:backlightAlways", async (_e, on: boolean) => { backlight.setAlways(on); });
  ipcMain.handle("emu:backlightCaptureHold", async (_e, on: boolean) => { backlight.setCaptureHold(on); });
  // Selectable keepalive method (back | motion | off) + a manual one-shot pulse.
  ipcMain.handle("emu:backlightMethod", async (_e, m: "back" | "motion" | "off") => { backlight.setMethod(m); });
  ipcMain.handle("emu:backlightPulse", async () => { backlight.pulseOnce(); });

  // Time control (Task 5): get/set persisted time config and re-apply on boot.
  ipcMain.handle("time:get", async () => time.getConfig());
  ipcMain.handle("time:set", async (_e, cfg: TimeConfig) => { await time.setConfig(cfg); });
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

  ipcMain.handle("capture:nextName", async (_e, base: string, ext: "png" | "gif") => {
    // Sanitize the base (allow [\w.\-] only) so the filename + scan regex are safe.
    const safeBase = String(base).replace(/[^\w.\-]/g, "");
    const safeExt = ext === "gif" ? "gif" : "png";
    const dir = captureDir ?? path.resolve(app.getPath("downloads"));
    // Scan the configured capture dir; an unreadable dir just means "start at 1".
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const max = nextIndexedName(names, safeBase, safeExt);
    return `${safeBase}-${max + 1}.${safeExt}`;
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
