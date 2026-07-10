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

/** The return_to we inject so the config page's Save navigation is one our
 * interceptor (extractCloseFragment) recognises. */
const RETURN_TO_SENTINEL = "pebblejs://close#";

/** Matches a clay.pebble.com *bootstrap* URL (the real `pebble-clay` config URL
 * on the pypkjs emulator: `http://clay.pebble.com[.s3-…]/#<encoded HTML>`). */
const CLAY_BOOTSTRAP_RE = /^https?:\/\/clay\.pebble\.com[./:]/i;

/**
 * Rewrite the broadcast AppConfig URL into the page we actually load, so the
 * config page's Save lands on a URL we can intercept.
 *
 * THE PROBLEM (verified live against a Clay-based watchface): on the pypkjs
 * emulator `pebble-clay`
 * builds the config URL as
 *   http://clay.pebble.com.s3-website-us-west-2.amazonaws.com/#<encodeURIComponent(HTML)>
 * where the HTML embeds `window.returnTo="$$RETURN_TO$$"` and Saves via
 *   location.href = (window.returnTo || "pebblejs://close#") + encodeURIComponent(json)
 * That clay.pebble.com page is a *bootstrap*: it reads a `return_to` QUERY param,
 * substitutes `$$RETURN_TO$$` in the HTML, and renders the real page in an iframe.
 * Loading the broadcast URL raw (as we used to) gives no `return_to` → Save goes
 * nowhere we see (and the iframe defeats main-frame will-navigate anyway).
 *
 * THE FIX (self-host the bootstrap): for a clay.pebble.com URL we replicate the
 * bootstrap ourselves — decode the fragment to HTML, substitute `$$RETURN_TO$$`
 * with RETURN_TO_SENTINEL, and return it as a top-level `data:text/html` URL.
 * Save then navigates the TOP frame to `pebblejs://close#<json>`, which
 * extractCloseFragment handles — no iframe, no dependency on the (defunct) bucket.
 *
 * Non-clay.pebble.com URLs (an app self-hosting its own config page, or a
 * `data:` URI) are returned UNCHANGED: those pages read `return_to` from their
 * own query string and already default to `pebblejs://close#`, which we catch.
 *
 * Pure (no Electron) so it is unit-testable.
 */
export function rewriteClayConfigUrl(url: string): string {
  if (!CLAY_BOOTSTRAP_RE.test(url)) return url;
  const hash = url.indexOf("#");
  if (hash === -1) return url; // no embedded page — nothing to self-host
  const rawFragment = url.slice(hash + 1);
  if (rawFragment === "") return url;

  // A third-party watchface can hand us a malformed percent-escape here, which
  // makes decodeURIComponent throw URIError; fall back to loading the URL as-is
  // (matching the base64 branch below) rather than rejecting the IPC.
  let data: string;
  try {
    data = decodeURIComponent(rawFragment);
  } catch {
    return url;
  }
  // The bootstrap treats a fragment NOT starting with '<' as base64 HTML.
  if (data.charAt(0) !== "<") {
    try {
      data = Buffer.from(data, "base64").toString("utf-8");
    } catch {
      return url; // not decodable — fall back to loading the URL as-is
    }
  }
  // Match the bootstrap's single `replace` (first occurrence only).
  const html = data.replace("$$RETURN_TO$$", RETURN_TO_SENTINEL);
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
 *
 * The incoming `url` is the raw broadcast AppConfig URL; rewriteClayConfigUrl
 * self-hosts the clay.pebble.com bootstrap so Save lands on a top-frame
 * pebblejs://close navigation we can intercept (see that function).
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

  // The page we host is untrusted third-party content; the only navigations we
  // trust are the pebblejs://close capture (handled above), staying on the
  // exact page we loaded, or a same-origin move within it. Everything else — an
  // outbound redirect to a tracker or a phishing origin — is blocked. A data:
  // page has an opaque ("null") origin, so only the exact loadUrl is allowed.
  const loadUrl = rewriteClayConfigUrl(url);
  let loadOrigin: string | null = null;
  try {
    loadOrigin = new URL(loadUrl).origin;
  } catch {
    /* data:/malformed URL — leave null so only the exact loadUrl passes */
  }
  const isAllowedNavigation = (target: string): boolean => {
    if (target === loadUrl) return true;
    if (loadOrigin && loadOrigin !== "null") {
      try {
        return new URL(target).origin === loadOrigin;
      } catch {
        return false;
      }
    }
    return false;
  };

  win.webContents.on("will-navigate", (event, target) => {
    if (handleClose(target)) {
      event.preventDefault();
      return;
    }
    if (!isAllowedNavigation(target)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, target) => {
    if (handleClose(target)) {
      event.preventDefault();
      return;
    }
    if (!isAllowedNavigation(target)) event.preventDefault();
  });
  // Some pages use window.open / target=_blank for the close URL; also deny
  // every other popup — a sandboxed config page has no business opening windows.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    handleClose(target);
    return { action: "deny" };
  });

  // Window closed without a captured fragment = user cancelled. A load failure
  // (unreachable config page) is treated the same way — cancel rather than hang
  // on a blank window — by closing, which fires this once-guarded cancel.
  win.on("closed", () => fire(""));
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 && !fired) win.close();
  });

  void win.loadURL(loadUrl);
  return win;
}
