/**
 * languageController.ts — language-pack management for the native-Windows track:
 * fetch/cache the Rebble language catalog, download or sideload a `.pbl` pack,
 * install it onto the running emulator (by spawning the Task 8 helper
 * `pb-lang-helper.py`), persist the user's per-board selection, and re-assert that
 * selection after every boot (packs live in RAM and are wiped on reboot, same as
 * battery/time/health state).
 *
 * A Pebble language pack is a `pbpack` (a resource bundle): its first uint32-LE is
 * the resource COUNT, which for a real pack is a small number (1..256). We push it
 * to the watch RAW via the helper's `PutBytes(File, filename="lang")` path.
 *
 * DESIGN: catalog is available only for the four boards Rebble ships packs for
 * (BOARD_TO_HW); emery/gabbro/flint are sideload-only, so fetchCatalog returns
 * empty for them WITHOUT any network call. The install retry mirrors
 * WindowsNativeDriver.activateHealth / batteryController: the pypkjs bridge lags
 * "Live" for a few seconds after boot, so a connection-class helper failure is
 * retried up to 8 × 400ms; a NACK (the watch rejected the pack) is terminal.
 *
 * Everything the module touches is injected (fs, fetch, helper spawn, clock,
 * sleep, pypkjs port) so it is unit-testable with NO electron / network / disk.
 * Production wiring (Task 10) builds the deps from winRuntime + deployWinHelpers +
 * spawnRunner + readPypkjsPort.
 */

import { win32 as winPath } from "node:path";
import { readFile, writeFile, copyFile, mkdir, stat, rename } from "node:fs/promises";
import type { RunResult } from "./BackendDriver.js";
import { spawnRunner } from "./spawnRunner.js";
import { isPathInside } from "./sdkController.js";

/** Boards Rebble publishes language packs for → their catalog `hw` code. Boards
 * absent here (emery/gabbro/flint) are sideload-only: fetchCatalog returns empty
 * for them without touching the network. */
export const BOARD_TO_HW = {
  aplite: "ev2_4",
  basalt: "snowy_dvt",
  chalk: "spalding",
  diorite: "silk",
} as const;

/** Rebble language catalog endpoint. */
const CATALOG_BASE = "https://lp.rebble.io/v1/languages";
/** Base used to resolve a catalog entry's `file` when it is not an absolute URL. */
const REBBLE_ORIGIN = "https://lp.rebble.io/";

/** Cache time-to-live: serve a cache younger than this without hitting the network. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound on the catalog/download HTTP request. */
const HTTP_TIMEOUT_MS = 10_000;
/** Hard bound on the install/query helper process (the helper self-bounds ~12s). */
const HELPER_TIMEOUT_MS = 15_000;

/** Install retry — mirrors HEALTH_ACTIVATE_* (activateHealth): the pypkjs bridge
 * lags "Live" for a few seconds after boot, so retry connection-class failures.
 * Worst case with a WEDGED (accepting-but-dead) bridge: each attempt burns the
 * helper's ~12s self-watchdog before failing, so 8 attempts ≈ 100s total — unlike
 * activateHealth's fast/slow-miss decision. Acceptable because installs run off
 * the boot critical path (reassertOnLive is fire-and-forget) and the common
 * failure (connection refused before the bridge binds) fails in milliseconds. */
const INSTALL_MAX_ATTEMPTS = 8;
const INSTALL_RETRY_MS = 400;

/** User-facing message for a watch-rejected (NACK) pack — terminal, not retried. */
export const NACK_HINT =
  "The watch rejected this pack — it may not match this firmware, or flash space is low.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A catalog board key (the ones we have an `hw` mapping for). */
export type CatalogBoard = keyof typeof BOARD_TO_HW;

/** A reduced catalog entry (newest version per locale). */
export interface CatalogEntry {
  isoLocal: string;
  name: string;
  localName: string;
  version: number;
  file: string;
}

/** fetchCatalog result. `catalogUnavailable` is set only when the network failed
 * AND there was no cache to fall back to (so the UI can show a note). */
export interface CatalogResult {
  entries: CatalogEntry[];
  catalogUnavailable?: boolean;
}

/** A `.pbl` copied into the app's writable store. */
export interface StoredPack {
  path: string;
  fileName: string;
  source: "sideload" | "catalog";
}

/** What installPack accepts: an already-local sideload pack, or a catalog entry
 * that must be downloaded first. */
export type PackRef =
  | { source: "sideload"; path: string; fileName?: string }
  | { source: "catalog"; entry: CatalogEntry };

/** Persisted per-board selection. `path` for sideload; `url`/`isoLocal` for catalog. */
export interface Selection {
  source: "catalog" | "sideload";
  isoLocal?: string;
  name?: string;
  url?: string;
  path?: string;
}

/** One JSON line the helper emits (mirrors LANG_HELPER_PY's contract). */
interface HelperResult {
  ok: boolean;
  language?: string;
  languageVersion?: number | null;
  error?: string;
  kind?: "nack" | "connect" | "timeout" | "other";
}

/** Minimal, injectable filesystem surface. */
export interface LangFs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer | string): Promise<void>;
  readText(p: string): Promise<string | null>;
  writeText(p: string, s: string): Promise<void>;
  copyFile(src: string, dst: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  /** File size, or null when the path is missing. */
  stat(p: string): Promise<{ size: number } | null>;
  exists(p: string): Promise<boolean>;
  /** Atomic move (replace an existing destination) — temp-file commit step. */
  rename(src: string, dst: string): Promise<void>;
}

/** Minimal fetch surface (Node's global fetch Response satisfies it structurally). */
export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchFn = (url: string, opts?: { signal?: AbortSignal }) => Promise<FetchResponse>;

export interface LanguageControllerDeps {
  /** app.getPath("userData") — writable root for lang-packs + cache + selections. */
  userDataDir: string;
  /** Deployed pb-lang-helper.py (from deployWinHelpers().langHelperPath). */
  langHelperPath: string;
  /** Bundled interpreter that runs the helper (pebblePyExe). */
  pythonExe: string;
  /** Current pypkjs websocket port, or null when the emulator isn't booted. */
  readPort: () => number | null;
  /** HTTP fetch (default: Node global fetch). */
  fetchFn?: FetchFn;
  /** Spawn a bounded child (default: spawnRunner). */
  spawn?: (cmd: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => Promise<RunResult>;
  /** File ops (default: realLangFs()). */
  fs?: LangFs;
  /** Clock (default Date.now) — for cache freshness. */
  now?: () => number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Log sink for swallowed reassert errors. */
  log?: (msg: string) => void;
}

export interface LanguageController {
  fetchCatalog(board: string, fwVersion: string): Promise<CatalogResult>;
  sideload(srcPath: string): Promise<StoredPack>;
  installPack(board: string, pack: PackRef): Promise<{ language: string }>;
  selection(board: string): Promise<Selection | null>;
  setSelection(board: string, sel: Selection | null): Promise<void>;
  reassertOnLive(board: string): Promise<void>;
  queryActive(board: string): Promise<{ language: string; languageVersion: number } | null>;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Raw catalog entry shape from the Rebble endpoint (superset of what we keep). */
interface RawCatalogEntry {
  ISOLocal?: string;
  name?: string;
  localName?: string;
  version?: number | string;
  file?: string;
}

/** Reduce the raw catalog to the newest `version` per `ISOLocal`, projecting to
 * CatalogEntry. Malformed rows (no ISOLocal/file) are dropped. */
export function reduceCatalog(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const byLocale = new Map<string, CatalogEntry>();
  for (const r of raw as RawCatalogEntry[]) {
    if (!r || typeof r !== "object") continue;
    const isoLocal = String(r.ISOLocal ?? "");
    const file = String(r.file ?? "");
    if (!isoLocal || !file) continue;
    const version = Number(r.version ?? 0) || 0;
    const prev = byLocale.get(isoLocal);
    if (prev && prev.version >= version) continue;
    byLocale.set(isoLocal, {
      isoLocal,
      name: String(r.name ?? isoLocal),
      localName: String(r.localName ?? r.name ?? isoLocal),
      version,
      file,
    });
  }
  return [...byLocale.values()];
}

/** True when `buf` looks like a real pbpack: ≥ 8 bytes and its first uint32-LE
 * (the resource entry count) is in [1, 256]. */
export function validatePbpackHeader(buf: Buffer): boolean {
  if (!buf || buf.length < 8) return false;
  const count = buf.readUInt32LE(0);
  return count >= 1 && count <= 256;
}

/** Last basename component of a path or URL (handles `/` and `\`). */
function baseName(p: string): string {
  const clean = p.split(/[?#]/, 1)[0]; // strip query/hash for URLs
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || "lang.pbl";
}

/** Parse the helper's stdout down to its one JSON line (scan from the end so any
 * leading debug noise is ignored). */
function parseHelperResult(stdout: string): HelperResult | null {
  const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]) as HelperResult;
      if (o && typeof o === "object" && typeof o.ok === "boolean") return o;
    } catch {
      /* not JSON — keep scanning up */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Real fs implementation
// ---------------------------------------------------------------------------

export function realLangFs(): LangFs {
  return {
    readFile: (p) => readFile(p),
    writeFile: async (p, data) => { await writeFile(p, data); },
    readText: async (p) => readFile(p, "utf8").then((s) => s as string).catch(() => null),
    writeText: async (p, s) => { await writeFile(p, s, "utf8"); },
    copyFile: async (src, dst) => { await copyFile(src, dst); },
    mkdirp: async (dir) => { await mkdir(dir, { recursive: true }); },
    stat: async (p) => stat(p).then((s) => ({ size: s.size })).catch(() => null),
    exists: async (p) => stat(p).then(() => true).catch(() => false),
    rename: async (src, dst) => { await rename(src, dst); },
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export function makeLanguageController(deps: LanguageControllerDeps): LanguageController {
  const fs = deps.fs ?? realLangFs();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const doFetch: FetchFn =
    deps.fetchFn ?? ((url, opts) => (globalThis.fetch as unknown as FetchFn)(url, opts));
  const spawn = deps.spawn ?? spawnRunner;

  const langPacksDir = winPath.join(deps.userDataDir, "lang-packs");
  const catalogDir = winPath.join(langPacksDir, "catalog");
  const selectionsPath = winPath.join(langPacksDir, "selections.json");

  // -- catalog cache ---------------------------------------------------------

  function cachePath(hw: string, fw: string): string {
    const safeFw = String(fw).replace(/[^\w.-]/g, "_") || "unknown";
    return winPath.join(catalogDir, `${hw}-${safeFw}.json`);
  }

  async function readCache(p: string): Promise<{ fetchedAt: number; entries: CatalogEntry[] } | null> {
    const text = await fs.readText(p).catch(() => null);
    if (!text) return null;
    try {
      const o = JSON.parse(text) as { fetchedAt?: number; entries?: CatalogEntry[] };
      if (!Array.isArray(o.entries)) return null;
      return { fetchedAt: Number(o.fetchedAt) || 0, entries: o.entries };
    } catch {
      return null;
    }
  }

  async function fetchCatalog(board: string, fwVersion: string): Promise<CatalogResult> {
    const hw = (BOARD_TO_HW as Record<string, string>)[board];
    if (!hw) return { entries: [] }; // sideload-only board → no network

    const p = cachePath(hw, fwVersion);
    const cached = await readCache(p);
    if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { entries: cached.entries }; // fresh cache — no network
    }

    const url = `${CATALOG_BASE}?hw=${encodeURIComponent(hw)}&firmware=${encodeURIComponent(fwVersion)}`;
    try {
      const res = await withTimeout((signal) => doFetch(url, { signal }), HTTP_TIMEOUT_MS);
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const entries = reduceCatalog(JSON.parse(await res.text()));
      await fs.mkdirp(catalogDir).catch(() => {});
      await fs.writeText(p, JSON.stringify({ fetchedAt: now(), entries })).catch(() => {});
      return { entries };
    } catch (e) {
      // Network/parse failure: serve any cache regardless of age; else unavailable.
      if (cached) return { entries: cached.entries };
      log(`[lang] catalog fetch failed (no cache): ${String(e)}`);
      return { entries: [], catalogUnavailable: true };
    }
  }

  // -- sideload --------------------------------------------------------------

  async function sideload(srcPath: string): Promise<StoredPack> {
    const buf = await fs.readFile(srcPath);
    if (!validatePbpackHeader(buf)) {
      throw new Error("That file isn't a valid Pebble language pack (.pbl).");
    }
    const fileName = baseName(srcPath);
    const dst = winPath.join(langPacksDir, fileName);
    await fs.mkdirp(langPacksDir).catch(() => {});
    await fs.copyFile(srcPath, dst);
    return { path: dst, fileName, source: "sideload" };
  }

  // -- install ---------------------------------------------------------------

  /** Resolve a PackRef to a local `.pbl` path, downloading a catalog pack (once)
   * into `<userData>\lang-packs\<board>\` when needed.
   *
   * A downloaded body is HEADER-VALIDATED before it is committed (temp file →
   * validate → rename into place), and an already-present file is only trusted if
   * it ALSO passes the header check. Without both, a 200 response with a
   * truncated/HTML body (captive portal, CDN error page) would be cached forever
   * by the size>0 skip — every later install would push garbage to the watch and
   * surface the misleading NACK firmware/flash hint, with no way to re-fetch. */
  async function resolveLocalPack(board: string, pack: PackRef): Promise<string> {
    if (pack.source === "sideload") {
      // A sideload ref must point inside the app's own lang-packs store (where
      // `sideload()` copied it). The ref crosses the IPC boundary, so a
      // compromised renderer could otherwise name any file on disk and have it
      // pushed to the emulator. Same boundary-validation posture as sim:set.
      if (!isPathInside(langPacksDir, pack.path)) {
        throw new Error("That language pack isn't in Pebble Studio's store — sideload it again.");
      }
      return pack.path;
    }
    const { entry } = pack;
    const boardDir = winPath.join(langPacksDir, board);
    const dst = winPath.join(boardDir, baseName(entry.file));
    const existing = await fs.stat(dst);
    if (existing && existing.size > 0) {
      // Trust the cached download only if it still looks like a pbpack; a bad
      // earlier write (or manual tampering) falls through to a re-download.
      const cached = await fs.readFile(dst).catch(() => null);
      if (cached && validatePbpackHeader(cached)) return dst;
    }
    // Catalog entries download ONLY from the Rebble catalog host over HTTPS.
    // `entry.file` also crosses the IPC boundary, so pin the resolved URL rather
    // than trusting the renderer (blocks SSRF to arbitrary hosts and plaintext
    // downgrade; relative files resolve against REBBLE_ORIGIN and pass).
    const url = new URL(entry.file, REBBLE_ORIGIN);
    if (url.protocol !== "https:" || url.host !== new URL(REBBLE_ORIGIN).host) {
      throw new Error("Language packs can only be downloaded from the official catalog.");
    }
    const res = await withTimeout((signal) => doFetch(url.toString(), { signal }), HTTP_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Couldn't download the language pack (HTTP ${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!validatePbpackHeader(bytes)) {
      // Do NOT write the bad body — leave nothing on disk so the next attempt
      // re-downloads. Distinct message from NACK_HINT: the watch never saw this.
      throw new Error("The downloaded language pack was corrupt or invalid — please try again.");
    }
    await fs.mkdirp(boardDir).catch(() => {});
    // Temp-write + rename so a crash mid-write can't leave a torn file that the
    // size>0 check above would half-trust.
    const tmp = `${dst}.download`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, dst);
    return dst;
  }

  function runHelper(args: string[]): Promise<RunResult> {
    return spawn(deps.pythonExe, [deps.langHelperPath, ...args], undefined, HELPER_TIMEOUT_MS);
  }

  /** One install attempt. Returns the language on success, or a classified error. */
  async function attemptInstall(
    port: number,
    pblPath: string,
  ): Promise<{ ok: true; language: string } | { ok: false; retry: boolean; error: Error }> {
    let r: RunResult;
    try {
      r = await runHelper(["--port", String(port), "install", pblPath]);
    } catch (e) {
      // spawn itself failed — treat as a connection-class (retryable) fault.
      return { ok: false, retry: true, error: e instanceof Error ? e : new Error(String(e)) };
    }
    const out = parseHelperResult(r.stdout);
    if (out?.ok) return { ok: true, language: out.language || "unknown" };
    if (out && !out.ok) {
      if (out.kind === "nack") return { ok: false, retry: false, error: new Error(NACK_HINT) };
      if (out.kind === "connect" || out.kind === "timeout") {
        return { ok: false, retry: true, error: new Error(out.error || out.kind) };
      }
      return { ok: false, retry: false, error: new Error(out.error || "Language install failed.") };
    }
    // No parseable JSON line (helper crashed / process timeout) → retryable.
    return {
      ok: false,
      retry: true,
      error: new Error((r.stderr || `helper exited ${r.code} with no result`).trim()),
    };
  }

  async function installPack(board: string, pack: PackRef): Promise<{ language: string }> {
    const pblPath = await resolveLocalPack(board, pack); // download once (before retries)
    let lastErr: Error = new Error("Language install failed.");
    for (let attempt = 0; attempt < INSTALL_MAX_ATTEMPTS; attempt++) {
      const port = deps.readPort();
      if (port == null) {
        lastErr = new Error("The emulator isn't running yet."); // connection-class → retry
      } else {
        const res = await attemptInstall(port, pblPath);
        if (res.ok) return { language: res.language };
        lastErr = res.error;
        if (!res.retry) throw res.error; // NACK / other terminal fault
      }
      if (attempt < INSTALL_MAX_ATTEMPTS - 1) await sleep(INSTALL_RETRY_MS);
    }
    throw lastErr;
  }

  // -- selection persistence -------------------------------------------------

  async function readSelections(): Promise<Record<string, Selection>> {
    const text = await fs.readText(selectionsPath).catch(() => null);
    if (!text) return {};
    try {
      const o = JSON.parse(text) as Record<string, Selection>;
      return o && typeof o === "object" ? o : {};
    } catch {
      return {};
    }
  }

  async function writeSelections(map: Record<string, Selection>): Promise<void> {
    await fs.mkdirp(langPacksDir).catch(() => {});
    // Temp-write + rename: a crash mid-write must not corrupt selections.json
    // (readSelections would silently treat a torn file as "no selections").
    const tmp = `${selectionsPath}.tmp`;
    await fs.writeText(tmp, JSON.stringify(map, null, 2));
    await fs.rename(tmp, selectionsPath);
  }

  async function selection(board: string): Promise<Selection | null> {
    const map = await readSelections();
    return map[board] ?? null;
  }

  async function setSelection(board: string, sel: Selection | null): Promise<void> {
    const map = await readSelections();
    if (sel) map[board] = sel;
    else delete map[board];
    await writeSelections(map);
  }

  /** Build a PackRef from a persisted selection (null when it lacks the fields
   * needed to install). */
  function selectionToRef(sel: Selection): PackRef | null {
    if (sel.source === "sideload") {
      if (!sel.path) return null;
      return { source: "sideload", path: sel.path, fileName: sel.name };
    }
    if (!sel.url) return null;
    return {
      source: "catalog",
      entry: { isoLocal: sel.isoLocal || "", name: sel.name || "", localName: "", version: 0, file: sel.url },
    };
  }

  async function reassertOnLive(board: string): Promise<void> {
    const sel = await selection(board);
    if (!sel) return; // nothing selected → no-op
    const ref = selectionToRef(sel);
    if (!ref) return;
    try {
      // installPack already caps its retries at 8 × 400ms (one bounded attempt),
      // exactly like the health/battery reassert — it never loops forever.
      await installPack(board, ref);
    } catch (e) {
      log(`[lang] reassert (${board}) failed: ${String(e)}`);
    }
  }

  // -- query -----------------------------------------------------------------

  async function queryActive(board: string): Promise<{ language: string; languageVersion: number } | null> {
    void board; // active language is a watch-global; board is accepted for symmetry
    const port = deps.readPort();
    if (port == null) return null;
    try {
      const r = await runHelper(["--port", String(port), "query"]);
      const out = parseHelperResult(r.stdout);
      if (out?.ok && out.language) {
        return { language: out.language, languageVersion: Number(out.languageVersion) || 0 };
      }
    } catch {
      /* swallow — query is best-effort */
    }
    return null;
  }

  return {
    fetchCatalog,
    sideload,
    installPack,
    selection,
    setSelection,
    reassertOnLive,
    queryActive,
  };
}

/** Run `fn` with an AbortSignal that aborts after `ms`, clearing the timer on
 * settle. Keeps every HTTP call bounded even if the default fetch has no timeout. */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}
