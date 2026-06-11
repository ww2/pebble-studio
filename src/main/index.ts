import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerIpc } from "./ipc.js";

// This file is bundled to CommonJS (dist/main/index.cjs) by esbuild, where
// `__dirname` is a native global. The ambient declare keeps it typechecking
// under the ESM (nodenext) tsconfig used for `npm run typecheck`.
declare const __dirname: string;

// Under WSLg the chromium sandbox typically cannot initialize; disable it so
// the app actually starts. Harmless on platforms where the sandbox works.
app.commandLine.appendSwitch("no-sandbox");

function createWindow(): void {
  const win = new BrowserWindow({
    title: "Pebble Studio",
    width: 1100,
    height: 760,
    backgroundColor: "#202020",
    webPreferences: {
      // Emitted by the esbuild bundle alongside index.cjs.
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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
            if (process.env.PEBBLE_UISHOT_LIGHT) {
              await win.webContents.executeJavaScript(
                "document.querySelector('.theme-toggle')?.click()",
              );
              await new Promise((r) => setTimeout(r, 600));
            }
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

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Quit on Windows/Linux; on macOS apps typically stay active.
  if (process.platform !== "darwin") app.quit();
});
