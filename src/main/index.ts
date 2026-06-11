import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerIpc } from "./ipc.js";

// Under WSLg the chromium sandbox typically cannot initialize; disable it so
// the app actually starts. Harmless on platforms where the sandbox works.
app.commandLine.appendSwitch("no-sandbox");

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    title: "Pebble Studio",
    width: 1100,
    height: 760,
    backgroundColor: "#202020",
    webPreferences: {
      // Emitted by tsc from preload.cts (nodenext maps .cts -> .cjs).
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // dist/main/index.js -> dist/renderer/index.html
    void win.loadFile(join(__dirname, "../renderer/index.html"));
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
