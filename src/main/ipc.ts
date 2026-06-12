import { ipcMain, app, dialog, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import { makeNativeShell, makeWslShell, type BootToken } from "./backend/bootEmulator.js";
import type { DriverKind } from "./backend/driverFactory.js";
import { EMU_INFO_PATH } from "./backend/hostPaths.js";
import { openClayWindow, parsePhonesimPort } from "./clayWindow.js";
import { createBacklightController } from "./backend/backlight.js";
import { makeTimeController, isNonSystemTime, detectHostTimezone, type TimeConfig } from "./backend/timeController.js";
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
 * The platform booted by the most recent `emu:start`. clay:phonesimPort uses it
 * to pick the right entry in the emulator state file (which is keyed by
 * platform, then SDK version).
 */
let currentPlatform: PlatformId | null = null;

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

  // Every `pebble` command re-syncs HOST time to the watch on connect (pebble-tool
  // commands/base.py post_connect). Since v0.0.13 that clobber only matters for
  // Timezone mode and the legacy offset fallback — shim-backed custom keeps
  // utc_offset at the host offset, so the re-push is already a no-op. The
  // controller decides internally what (if anything) to re-push; fire-and-forget,
  // skipped when showing plain host/system time so we don't spawn needlessly.
  const reassertTime = (): void => {
    if (isNonSystemTime(time.getConfig(), detectHostTimezone())) void time.reassert();
  };

  ipcMain.handle("lib:add", async (_e, pbwPath: string) => { library.add(pbwPath); return library.list(); });
  ipcMain.handle("lib:list", async () => library.list());
  ipcMain.handle("lib:remove", async (_e, p: string) => {
    library.remove(p);
    // Also drop it from the loaded set. There is no per-app uninstall command
    // (only `pebble wipe`), so the app stays on disk until a wipe — but from the
    // user's point of view a removed app is no longer one of "their" loaded apps.
    // Pruning here keeps the "N loaded" count from drifting ABOVE the visible
    // library list (the "removed 2, added 1 → 3 loaded" bug).
    loaded.delete(p);
    return library.list();
  });
  ipcMain.handle("lib:installAll", async () => {
    for (const p of library.list()) {
      await driver!.install(p);
      loaded.add(p);
    }
    // Each `pebble install` re-syncs host time on connect (post_connect),
    // clobbering any custom/timezone offset. installAll runs AFTER emu:start's
    // applyAll() (the renderer reinstalls once VNC is up), so without this the
    // watch reverts to host time on every boot with a non-system time set.
    reassertTime();
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
    currentPlatform = id; // remembered for clay:phonesimPort's state-file lookup
    // Fresh token per boot, stored as current so abort/stop can cancel it.
    const token: BootToken = { cancelled: false };
    currentBootToken = token;
    // Forward each boot step to the renderer (diagnostic boot notes, Task J).
    const onStep = (msg: string): void => { e.sender.send("emu:boot-progress", msg); };
    // Deploy the LD_PRELOAD time shim BEFORE the emulator boots: bootEmulator's
    // bootControl consults the shim-ready cache when spawning emu-control, so the
    // wrapper must already exist on disk. Failure is fine — the time controller
    // falls back to the legacy offset path. (Optional chaining: a null driver is
    // handled by the start() call below, same as before.)
    await driver?.ensureTimeShim().catch(() => false);
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
    // Deliberately NOT resetting the time-shim control file here: the next
    // emu:start's applyAll() rewrites it, and the controller starts every app run
    // at the System default anyway.
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
  // Time-shim readiness ({shim:boolean}) — the Settings note shows the legacy
  // offset-fallback limits when false.
  ipcMain.handle("time:status", async () => time.getStatus());
  ipcMain.handle("emu:install", async (_e, pbwPath: string) => {
    await driver!.install(pbwPath);
    loaded.add(pbwPath);
    reassertTime();
  });
  ipcMain.handle("emu:button", async (_e, id: ButtonId) => {
    await driver!.button(id, "press");
    reassertTime();
  });
  ipcMain.handle("emu:accelTap", async () => {
    await driver!.accelTap();
    reassertTime();
  });
  ipcMain.handle("emu:screenshot", async (_e, out: string) => driver!.screenshot(out));
  ipcMain.handle("emu:timelineQuickView", async (_e, on: boolean) => {
    await driver!.timelineQuickView(on);
    reassertTime();
  });

  // Clay / AppConfig (Task B2). The renderer drives the pypkjs websocket
  // round-trip (src/shared/clayProtocol.ts); main supplies the port and hosts
  // the config page in a locked-down child window.
  ipcMain.handle("clay:phonesimPort", async (): Promise<number | null> => {
    if (currentPlatform == null) return null; // nothing booted yet
    // Read the emulator state file through the Shell matching the active driver
    // kind (same pattern as the backlight controller's monitor-port read), so it
    // works on a Windows+WSL host where Node can't read the POSIX path directly.
    const shell = driverKind === "wsl" ? makeWslShell() : makeNativeShell();
    const { code, stdout } = await shell.run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
    if (code !== 0 || !stdout.trim()) return null;
    return parsePhonesimPort(stdout, currentPlatform);
  });
  ipcMain.handle("clay:openWindow", async (e, url: string): Promise<string> => {
    // Defense against arbitrary URL loads: only config-page-shaped URLs.
    if (
      typeof url !== "string" ||
      !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:"))
    ) {
      throw new Error(`clay:openWindow: refusing to load non-http(s)/data URL`);
    }
    // Resolves with the RAW STILL-PERCENT-ENCODED close fragment ("" = cancel).
    // It must stay encoded: the renderer forwards it verbatim to pypkjs, and the
    // watchapp's JS decodeURIComponent()s it itself (see clayWindow.ts).
    const rawFragment = await new Promise<string>((resolve) => {
      openClayWindow(url, resolve, BrowserWindow.fromWebContents(e.sender) ?? undefined);
    });
    // The config round-trip's websocket connects can clobber a timezone/custom
    // offset (post_connect re-syncs host time); re-assert it after a real save.
    if (rawFragment !== "") reassertTime();
    return rawFragment;
  });

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
