import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerIpc } from "./ipc.js";
import { createQuitHandler } from "./quitHandler.js";
import { buildMenuTemplate } from "./menu.js";

// This file is bundled to CommonJS (dist/main/index.cjs) by esbuild, where
// `__dirname` is a native global. The ambient declare keeps it typechecking
// under the ESM (nodenext) tsconfig used for `npm run typecheck`.
declare const __dirname: string;

// Under WSLg the chromium sandbox typically cannot initialize; disable it so
// the app actually starts. Harmless on platforms where the sandbox works.
app.commandLine.appendSwitch("no-sandbox");

// Single-instance lock (Task H). A second app instance would launch a second
// competing emulator (the cause of the inconsistent-FPS report), so we refuse it
// and instead surface the existing window. Must run before any window is created.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Module ref to the main window so `second-instance` can restore + focus it.
let mainWindow: BrowserWindow | null = null;

// When a second instance is launched, Electron fires this in the FIRST (primary)
// instance instead. Restore the existing main window (un-minimize) and focus it.
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Show a frameless splash window immediately so the first visible window isn't
// a blank frame while the (heavier) renderer bundle loads. Closed once the main
// window fires `did-finish-load`. The version is injected via a query param so
// the static splash.html needs no build-time substitution.
function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    show: true,
    resizable: false,
    maximizable: false,
    center: true,
    backgroundColor: "#202020",
    // Frameless + matching dark base => no white flash before paint.
    transparent: false,
  });
  splash.setMenu(null);
  // dist/main/index.cjs -> dist/main/splash.html (copied by build:main).
  void splash.loadFile(join(__dirname, "splash.html"), {
    query: { v: app.getVersion() },
  });
  return splash;
}

function createWindow(): void {
  const splash = createSplashWindow();

  const win = new BrowserWindow({
    title: "Pebble Studio",
    width: 1100,
    height: 760,
    // dist/main/index.cjs -> <repo>/build/icon.png (dev/taskbar parity; the
    // packaged .exe icon comes from electron-builder win.icon).
    icon: join(__dirname, "..", "..", "build", "icon.png"),
    // Hidden until the renderer has finished loading; we then swap from the
    // splash to this fully-painted window in one step.
    show: false,
    backgroundColor: "#202020",
    webPreferences: {
      // Emitted by the esbuild bundle alongside index.cjs.
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep the renderer running at full rate even when the window loses focus.
      // A runtime toggle (app:setBackgroundThrottling) lets the user re-enable
      // throttling from Settings if they want to conserve CPU when unfocused.
      backgroundThrottling: false,
    },
  });

  // Defense-in-depth: the renderer loads only local content and never opens
  // popups, so lock both down. A stray link or future XSS therefore cannot
  // navigate this (preload-bearing) window to a remote origin or spawn a new
  // window. The Clay child window has its own equivalent guards.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    const allowed = process.env.VITE_DEV_SERVER_URL;
    if (!(allowed && url.startsWith(allowed))) e.preventDefault();
  });

  // Track as the main window so `second-instance` can restore + focus it; clear
  // the ref on close so we never poke a destroyed window.
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Runtime background-throttling toggle. Guard against duplicate registration
  // if createWindow is ever called more than once (e.g. macOS re-activate).
  ipcMain.removeHandler("app:setBackgroundThrottling");
  ipcMain.handle("app:setBackgroundThrottling", (_e, throttle: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(throttle);
    }
  });

  // Swap splash -> main once the renderer is ready. Guard against the splash
  // already being destroyed (e.g. closed by the user) before calling into it.
  win.webContents.once("did-finish-load", () => {
    if (!splash.isDestroyed()) splash.close();
    if (!win.isDestroyed()) win.show();
  });

  // Forward renderer console output to the terminal (useful for headless dev).
  win.webContents.on("console-message", (_e, _lvl, message) =>
    console.log(`[renderer] ${message}`),
  );

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // dist/main/index.cjs -> dist/renderer/index.html
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // TEMP, env-gated UI-screenshot hook. Inert unless PEBBLE_UISHOT is set.
  // After the window loads + a delay (to let the watch boot), capture the full
  // window to the given path. PEBBLE_UISHOT_LIGHT (truthy) toggles the theme
  // first so both themes can be captured in separate runs.
  const shotPath = process.env.PEBBLE_UISHOT;
  if (shotPath) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void (async () => {
          try {
            // Optionally switch platform (e.g. to a round device) before capture
            // by selecting the matching combobox option, then wait for it to boot.
            const wantPlatform = process.env.PEBBLE_UISHOT_PLATFORM;
            if (wantPlatform) {
              await win.webContents.executeJavaScript(
                `(() => {
                  const btn = document.querySelector('.version-combo .version-combo-btn');
                  if (btn) btn.click();
                  const opt = document.querySelector('.version-combo-option[data-id="${wantPlatform}"]');
                  if (opt) opt.click();
                })()`,
              );
              await new Promise((r) => setTimeout(r, 16000));
            }
            // Force the desired theme deterministically (independent of any
            // persisted localStorage choice): the toggle label reads "Dark" when
            // currently light and "Light" when currently dark, so click only if
            // we are not already in the target theme.
            const wantLight = Boolean(process.env.PEBBLE_UISHOT_LIGHT);
            await win.webContents.executeJavaScript(
              `(() => {
                const b = document.querySelector('.theme-toggle');
                if (!b) return;
                const isDark = /Light/.test(b.textContent || '');
                const want = ${wantLight ? "false" : "true"};
                if (isDark !== want) b.click();
              })()`,
            );
            await new Promise((r) => setTimeout(r, 600));
            // Open the custom model dropdown so its legibility is captured.
            await win.webContents.executeJavaScript(
              "document.querySelector('.version-combo .version-combo-btn')?.click()",
            );
            await new Promise((r) => setTimeout(r, 400));
            const img = await win.webContents.capturePage();
            await writeFile(shotPath, img.toPNG());
            console.log(`[uishot] wrote ${shotPath}`);
          } catch (err) {
            console.error("[uishot] capture failed", err);
          }
        })();
      }, 20000);
    });
  }
}

// Build + install the application menu (File/Edit/Window/Help). Menu actions are
// forwarded to the renderer as `menu:action` events; Clear Emulator confirms via
// a native dialog first. Reuses the existing install/clear IPC flows downstream.
function setupApplicationMenu(): void {
  const send = (action: string): void => {
    mainWindow?.webContents.send("menu:action", action);
  };
  const menu = Menu.buildFromTemplate(
    buildMenuTemplate(
      {
        installPbw: () => send("install-pbw"),
        clearEmulator: () => {
          if (!mainWindow) return;
          const choice = dialog.showMessageBoxSync(mainWindow, {
            type: "warning",
            buttons: ["Cancel", "Clear"],
            defaultId: 0,
            cancelId: 0,
            title: "Clear Emulator",
            message: "Clear the emulator?",
            detail:
              "This wipes all installed apps from the running watch and reboots it. Your PBW library is kept.",
          });
          if (choice === 1) send("clear-emulator");
        },
        showChangelog: () => send("changelog"),
      },
      app.getVersion(),
    ),
  );
  Menu.setApplicationMenu(menu);
}

// Only stand up the app when we hold the single-instance lock. Without it the
// second instance has already called app.quit() above.
if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    const { shutdown } = registerIpc(() => mainWindow);
    // before-quit fires for the X button, app.quit(), and Task Manager "End
    // task" (all WM_CLOSE). Bounded so "End task"'s short grace window doesn't
    // escalate to a hard kill mid-cleanup. "End process" (TerminateProcess)
    // can't be intercepted — the backend:init startup reap covers its aftermath.
    app.on("before-quit", createQuitHandler(shutdown, () => app.exit(0)));
    createWindow();
    setupApplicationMenu();

    app.on("activate", () => {
      // macOS: re-create a window when the dock icon is clicked and none are open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // Quit on Windows/Linux; on macOS apps typically stay active.
  if (process.platform !== "darwin") app.quit();
});
