import type { BrowserWindow } from "electron";

/**
 * Clay config child window + emulator state-file parsing (Task B2).
 *
 * The renderer drives the pypkjs AppConfig websocket round-trip (see
 * src/shared/clayProtocol.ts for the wire protocol); main's jobs here are:
 *   1. tell the renderer which port pypkjs listens on (parsePhonesimPort,
 *      read from /tmp/pb-emulator.json via the ipc handler), and
 *   2. host the config page in a locked-down child BrowserWindow and capture
 *      the "pebblejs://close#<data>" navigation the page finishes with
 *      (openClayWindow + extractCloseFragment).
 *
 * The two parse helpers are PURE and sit above any Electron usage so vitest
 * (plain node environment, no Electron binary) can import this module:
 * `import type` is erased at compile time, and the real `require("electron")`
 * happens lazily inside openClayWindow, which tests never call.
 */

/**
 * Extract the pypkjs phonesim websocket port for a platform from the emulator
 * state file's JSON text (pebble-tool's /tmp/pb-emulator.json).
 *
 * Pure (no fs / no shell) so it is unit-testable. The file shape is
 *   { "<platform>": { "<sdkVersion>": { "pypkjs": { "port": <port> }, "qemu": {...} } } }
 * We return the first version entry under `platform` that carries a pypkjs
 * port, or null if the json is missing/malformed or has no such entry.
 * (Same read pattern as parseMonitorPort in backend/backlight.ts.)
 */
export function parsePhonesimPort(json: string, platform: string): number | null {
  try {
    const parsed = JSON.parse(json) as Record<
      string,
      Record<string, { pypkjs?: { port?: number } }>
    >;
    const versions = parsed?.[platform];
    if (!versions || typeof versions !== "object") return null;
    for (const v of Object.values(versions)) {
      const port = v?.pypkjs?.port;
      if (typeof port === "number" && Number.isFinite(port)) return port;
    }
  } catch {
    /* missing / partial / malformed json → no port */
  }
  return null;
}

/** Matches a pebblejs://close URL: after "close" comes end-of-string, '#', '?'
 * or '/'. Case-insensitive; rejects lookalikes such as pebblejs://closer. */
const CLOSE_URL_RE = /^pebblejs:\/\/close([/?#]|$)/i;

/**
 * If `url` is a Clay close navigation ("pebblejs://close...#<data>"), return
 * the RAW — still percent-encoded — fragment after the FIRST '#' ("" when
 * there is no/an empty fragment, i.e. cancel). Returns null when the URL is
 * not a pebblejs://close URL at all.
 *
 * Deliberately NOT decoded (unlike clayProtocol's parseCloseFragment): the
 * bytes sent back to pypkjs must stay percent-encoded because the watchapp's
 * JS calls decodeURIComponent on e.response itself.
 */
export function extractCloseFragment(url: string): string | null {
  if (!CLOSE_URL_RE.test(url)) return null;
  const hash = url.indexOf("#");
  if (hash === -1) return "";
  return url.slice(hash + 1);
}

/**
 * Open a Clay/AppConfig page in a locked-down child BrowserWindow.
 *
 * The page's Save button navigates to "pebblejs://close#<urlencoded data>";
 * we intercept that on will-navigate / will-redirect / window.open, prevent
 * the navigation, and fire `onClosed` with the RAW STILL-PERCENT-ENCODED
 * fragment (the renderer forwards it verbatim to pypkjs — see
 * extractCloseFragment above for why it must not be decoded). Closing the
 * window without saving fires `onClosed("")` (cancel). `onClosed` fires
 * exactly once.
 */
export function openClayWindow(
  url: string,
  onClosed: (rawFragment: string) => void,
  parent?: BrowserWindow,
): BrowserWindow {
  // Lazy Electron load: a top-level `import { BrowserWindow } from "electron"`
  // would make the pure helpers above unimportable under vitest's node env
  // (the electron package resolves to a path string outside an Electron
  // process). The esbuild cjs bundle keeps this require as-is (electron is
  // marked external), so at app runtime it is the real module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as typeof import("electron");

  const win = new electron.BrowserWindow({
    width: 520,
    height: 640,
    parent,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // no preload: the config page is untrusted remote content and needs no API
    },
  });

  // Single-fire guard: a close navigation fires onClosed(fragment) and then
  // win.close() triggers "closed", which must NOT fire onClosed("") again.
  let fired = false;
  const fire = (rawFragment: string): void => {
    if (fired) return;
    fired = true;
    onClosed(rawFragment);
  };

  /** If `target` is a close URL: capture the fragment, close, return true. */
  const handleClose = (target: string): boolean => {
    const rawFragment = extractCloseFragment(target);
    if (rawFragment === null) return false;
    fire(rawFragment);
    win.close();
    return true;
  };

  win.webContents.on("will-navigate", (event, target) => {
    if (handleClose(target)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, target) => {
    if (handleClose(target)) event.preventDefault();
  });
  // Some pages use window.open / target=_blank for the close URL; also deny
  // every other popup — a sandboxed config page has no business opening windows.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    handleClose(target);
    return { action: "deny" };
  });

  // Window closed without a captured fragment = user cancelled.
  win.on("closed", () => fire(""));

  void win.loadURL(url);
  return win;
}
