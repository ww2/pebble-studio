/**
 * langIpc.ts — the IPC-surface layer for the native-Windows language-pack feature
 * (Task 10). It wraps the Task 9 `LanguageController` with the thin policy the
 * renderer needs:
 *
 *   - native-only gating: on the WSL / native-Linux backends there is no bundled
 *     pypkjs helper, so every handler resolves a clear "not supported" payload
 *     (an `{ error }` string, or `null`) instead of crashing;
 *   - error → string mapping: install/sideload turn a thrown controller error
 *     into a `{ error }` the UI can display verbatim (the controller's messages
 *     are already user-facing);
 *   - the file-pick + validation flow for sideload;
 *   - `kickLangReassert`, the fire-and-forget post-live hook that re-installs the
 *     per-board selection after every boot (packs live in RAM and are wiped on
 *     reboot, exactly like battery/time/health state).
 *
 * This module is deliberately ELECTRON-FREE (the controller, firmware version,
 * and file picker are all injected) so the handler policy is unit-testable with
 * no electron / disk / network. `ipc.ts` builds the real deps and registers each
 * handler on `ipcMain`.
 */

import { isPlatformId } from "../shared/validate.js";
import type {
  LanguageController,
  CatalogResult,
  StoredPack,
  Selection,
  PackRef,
} from "./backend/languageController.js";

/** Shown when a language handler runs on a backend that can't support packs
 * (WSL / native-Linux): only the self-contained windows-native stack bundles the
 * pypkjs helper + interpreter the install path needs. */
export const LANG_NOT_SUPPORTED =
  "Language packs are only available on the native Windows backend.";

/** Rejected board id (defense-in-depth: `board` is also used as a path segment
 * for the per-board catalog download cache inside the controller). */
const INVALID_BOARD = "Unknown board.";

/** catalog result + an optional surfaced `error` (not-supported / bad board). */
export type LangCatalogResult = CatalogResult & { error?: string };
/** install resolves the installed language, or a surfaced error string. */
export type LangInstallResult = { language: string } | { error: string };
/** sideload resolves the stored pack, a surfaced error, or a picker cancel. */
export type LangSideloadResult = { pack: StoredPack } | { error: string } | { cancelled: true };
/** active language on the watch, or null when unknown / unsupported. */
export type LangActiveResult = { language: string; languageVersion: number } | null;

export interface LangIpcDeps {
  /** The language controller, or null when the active backend can't support it
   * (non-native). Async so `ipc.ts` can construct it lazily on first use. */
  getController: () => Promise<LanguageController | null>;
  /** Firmware/SDK version to query the catalog for (the active SDK's version). */
  getFwVersion: () => Promise<string>;
  /** Open a `.pbl` file picker; resolves the chosen path, or null on cancel. */
  pickPblFile: () => Promise<string | null>;
  /** Log sink for swallowed reassert errors (defaults to a no-op). */
  log?: (m: string) => void;
}

export interface LangHandlers {
  catalog(board: string): Promise<LangCatalogResult>;
  install(board: string, ref: PackRef): Promise<LangInstallResult>;
  sideload(): Promise<LangSideloadResult>;
  active(board: string): Promise<LangActiveResult>;
  getSelection(board: string): Promise<Selection | null>;
  setSelection(board: string, sel: Selection | null): Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Build the language IPC handlers over injected deps. Each handler DELEGATES to
 * the controller; the layer here owns only gating + error mapping + the picker. */
export function makeLangHandlers(deps: LangIpcDeps): LangHandlers {
  return {
    async catalog(board) {
      const c = await deps.getController();
      if (!c) return { entries: [], catalogUnavailable: true, error: LANG_NOT_SUPPORTED };
      if (!isPlatformId(board)) return { entries: [], error: INVALID_BOARD };
      return c.fetchCatalog(board, await deps.getFwVersion());
    },

    async install(board, ref) {
      const c = await deps.getController();
      if (!c) return { error: LANG_NOT_SUPPORTED };
      if (!isPlatformId(board)) return { error: INVALID_BOARD };
      try {
        return await c.installPack(board, ref);
      } catch (e) {
        return { error: errMsg(e) };
      }
    },

    async sideload() {
      const c = await deps.getController();
      if (!c) return { error: LANG_NOT_SUPPORTED };
      const src = await deps.pickPblFile();
      if (!src) return { cancelled: true };
      try {
        return { pack: await c.sideload(src) };
      } catch (e) {
        return { error: errMsg(e) };
      }
    },

    async active(board) {
      const c = await deps.getController();
      if (!c || !isPlatformId(board)) return null;
      return c.queryActive(board);
    },

    async getSelection(board) {
      const c = await deps.getController();
      if (!c || !isPlatformId(board)) return null;
      return c.selection(board);
    },

    async setSelection(board, sel) {
      const c = await deps.getController();
      if (!c || !isPlatformId(board)) return; // no-op on unsupported backend / bad board
      await c.setSelection(board, sel);
    },
  };
}

/**
 * Fire-and-forget post-live hook: re-install the per-board language selection
 * after a boot. Called from `runPostLive` (both the cold boot and the warm-standby
 * claim), so it runs exactly once per user-visible launch. NEVER awaited on the
 * boot critical path — mirrors the health/battery reassert. `reassertOnLive`
 * already caps its own retries and never throws, but the outer catch also guards
 * the getController step and keeps a stray rejection from becoming an unhandled
 * promise. Returns void immediately.
 */
export function kickLangReassert(
  getController: () => Promise<LanguageController | null>,
  board: string,
  log: (m: string) => void = () => {},
): void {
  void (async () => {
    const c = await getController();
    if (!c) return;
    await c.reassertOnLive(board);
  })().catch((e) => log(`[lang] reassert kick failed: ${String(e)}`));
}
