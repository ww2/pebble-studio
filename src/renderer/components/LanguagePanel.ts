/**
 * LanguagePanel.ts — the Settings → "Language" section (Task 11, native-Windows
 * language packs). It renders as a standard `.settings-section` (same markup /
 * classes as the Battery / Time sections inside SettingsPane) but is a separate,
 * independently-testable component because — unlike those board-agnostic
 * sections — it is BOARD-SPECIFIC: every action is scoped to the live board, so
 * it must re-read the catalog / active language when the board switches or when
 * the emulator goes Live.
 *
 * Data flow (all via the injected `window.studio.lang` surface from Task 10):
 *   - catalog(board)      → dropdown of packs (or a note for sideload-only /
 *                           catalog-unavailable / unsupported boards),
 *   - install(board, ref) → one call; we show an in-flight state + disable the
 *                           buttons while it runs, then persist the choice via
 *   - setSelection(board) → so it re-asserts on future boots,
 *   - sideload()          → main opens the native picker itself, stores the .pbl;
 *                           we then install + persist it,
 *   - active(board)       → the "Active: …" line, refreshed after install & Live.
 *
 * This module is ELECTRON/CONTROLLER-FREE at runtime: the language controller
 * pulls in node:fs / node:path, so we only TYPE-import its shapes (erased) and
 * talk to it through the preload IPC surface (mirrors how the rest of the
 * renderer imports `main/backend/*` types). The `LangApiLike` interface is the
 * injectable seam the tests mock and `main.ts` types `studio.lang` against.
 */
import type {
  LangCatalogResult,
  LangInstallResult,
  LangSideloadResult,
  LangActiveResult,
} from "../../main/langIpc.js";
import type {
  CatalogEntry,
  PackRef,
  Selection,
  StoredPack,
} from "../../main/backend/languageController.js";

/** The subset of `window.studio.lang` the panel uses — the injectable seam the
 * tests mock. `main.ts` types `studio.lang` against this so the two never drift. */
export interface LangApiLike {
  catalog(board: string): Promise<LangCatalogResult>;
  install(board: string, ref: PackRef): Promise<LangInstallResult>;
  sideload(): Promise<LangSideloadResult>;
  active(board: string): Promise<LangActiveResult>;
  getSelection(board: string): Promise<Selection | null>;
  setSelection(board: string, sel: Selection | null): Promise<void>;
}

// ── Pure helpers (unit-tested directly) ─────────────────────────────────────

/** Catalog entries sorted alphabetically by their English `name` (locale-aware,
 * case-insensitive). The English name sorts deterministically regardless of the
 * localName's script/accents. Returns a new array; entry objects are shared. */
export function sortedCatalogEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Dropdown label: localName primary, English name secondary ("Français —
 * French"). Collapses to a single value when they match (English → "English") or
 * when one is missing. */
export function catalogOptionLabel(entry: CatalogEntry): string {
  const local = entry.localName || entry.name || entry.isoLocal;
  const eng = entry.name || entry.isoLocal;
  return local && eng && local !== eng ? `${local} — ${eng}` : local;
}

/** The note to show INSTEAD of the dropdown, or null when there are packs to
 * pick. `catalogUnavailable` (network failed, no cache) and a surfaced `error`
 * (unsupported backend / bad board — shown verbatim) each get their own copy;
 * an empty catalog with no flag is a sideload-only board (emery/gabbro/flint). */
export function catalogNote(result: LangCatalogResult): string | null {
  if (result.entries.length > 0) return null;
  if (result.error) return result.error;
  if (result.catalogUnavailable) return "Catalog unavailable — sideload still works";
  return "No official packs for this board — sideload a .pbl instead";
}

/** The persisted per-board selection for a catalog pack (re-asserted on boot). */
export function selectionForEntry(entry: CatalogEntry): Selection {
  return { source: "catalog", isoLocal: entry.isoLocal, name: entry.name, url: entry.file };
}

/** The persisted per-board selection for a sideloaded pack. */
export function selectionForSideload(pack: StoredPack): Selection {
  return { source: "sideload", path: pack.path, name: pack.fileName };
}

/** "Active: Français (fr_FR)" — maps the watch's language code to its localName
 * when it's a known catalog entry, else shows the raw code. Null when nothing is
 * active (emulator down / unknown). */
export function formatActive(active: LangActiveResult, entries: CatalogEntry[]): string | null {
  if (!active) return null;
  const match = entries.find((e) => e.isoLocal === active.language);
  return match && match.localName && match.localName !== active.language
    ? `Active: ${match.localName} (${active.language})`
    : `Active: ${active.language}`;
}

// ── Component ───────────────────────────────────────────────────────────────

export class LanguagePanel {
  readonly el: HTMLElement;

  private readonly getBoard: () => string;
  private readonly injectedApi?: LangApiLike;

  private readonly catalogHost: HTMLDivElement;
  private readonly installBtn: HTMLButtonElement;
  private readonly sideloadBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly activeLine: HTMLParagraphElement;
  private readonly statusLine: HTMLParagraphElement;
  private readonly errorLine: HTMLParagraphElement;
  private select: HTMLSelectElement | null = null;

  /** Catalog entries for the current board (sorted) — the source for install /
   * reset / active-code mapping. */
  private entries: CatalogEntry[] = [];
  /** The most recent in-flight operation (install/sideload/reset/refresh) — tests
   * await it via whenIdle(); production ignores it. Starts settled. */
  private pending: Promise<void> = Promise.resolve();

  private readonly disposers: Array<() => void> = [];

  constructor(getBoard: () => string, api?: LangApiLike) {
    this.getBoard = getBoard;
    this.injectedApi = api;

    this.el = document.createElement("section");
    this.el.className = "settings-section";

    const heading = document.createElement("h3");
    heading.className = "settings-section-title type-body-strong";
    heading.textContent = "Language";

    // Catalog area: swapped between a labelled <select> (packs) and a note.
    this.catalogHost = document.createElement("div");
    this.catalogHost.className = "lang-catalog";

    // Action buttons (same row/classes as the SDK section).
    this.installBtn = document.createElement("button");
    this.installBtn.type = "button";
    this.installBtn.className = "lib-pick-btn lang-install";
    this.installBtn.textContent = "Install";
    this.installBtn.addEventListener("click", () => this.onInstall());

    this.sideloadBtn = document.createElement("button");
    this.sideloadBtn.type = "button";
    this.sideloadBtn.className = "lib-pick-btn lang-sideload";
    this.sideloadBtn.textContent = "Sideload .pbl…";
    this.sideloadBtn.addEventListener("click", () => this.onSideload());

    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "lib-pick-btn lang-reset";
    this.resetBtn.textContent = "Reset to English";
    this.resetBtn.addEventListener("click", () => this.onReset());

    const actions = document.createElement("div");
    actions.className = "settings-row-actions";
    actions.append(this.installBtn, this.sideloadBtn, this.resetBtn);

    this.activeLine = document.createElement("p");
    this.activeLine.className = "settings-row-desc type-caption lang-active";
    this.statusLine = document.createElement("p");
    this.statusLine.className = "settings-row-desc type-caption lang-status";
    this.errorLine = document.createElement("p");
    this.errorLine.className = "settings-row-desc type-caption lang-error";

    this.el.append(heading, this.catalogHost, actions, this.activeLine, this.statusLine, this.errorLine);

    // Board switches → full reload; Live (apps-changed) → refresh the active line
    // (the backend re-asserts the selection on boot; we just re-read it).
    const onBoardChanged = (): void => { void this.refresh(); };
    const onAppsChanged = (): void => { void this.refreshActive(this.getBoard()); };
    window.addEventListener("pebble-studio:board-changed", onBoardChanged);
    window.addEventListener("pebble-studio:apps-changed", onAppsChanged);
    this.disposers.push(
      () => window.removeEventListener("pebble-studio:board-changed", onBoardChanged),
      () => window.removeEventListener("pebble-studio:apps-changed", onAppsChanged),
    );

    // Initial load (best-effort; tests await refresh() explicitly).
    void this.refresh();
  }

  /** Remove the window listeners (renderer is a singleton, but keep it tidy). */
  dispose(): void {
    for (const d of this.disposers) d();
  }

  /** Resolves when the last-started async op settles — the test-only await seam. */
  whenIdle(): Promise<void> {
    return this.pending;
  }

  private api(): LangApiLike {
    return this.injectedApi ?? window.studio.lang;
  }

  private setBusy(busy: boolean): void {
    this.installBtn.disabled = busy;
    this.sideloadBtn.disabled = busy;
    this.resetBtn.disabled = busy;
  }

  private setStatus(msg: string): void { this.statusLine.textContent = msg; }
  private setError(msg: string): void { this.errorLine.textContent = msg; }
  private clearError(): void { this.errorLine.textContent = ""; }

  /** Run an async action with the shared in-flight guard: disable the buttons,
   * clear any prior error, run, then re-enable. Errors surface on the error line
   * (never thrown), so the buttons are always restored. Recorded in `pending`. */
  private run(fn: () => Promise<void>): void {
    this.setBusy(true);
    this.clearError();
    this.pending = fn()
      .catch((e: unknown) => { this.setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { this.setBusy(false); });
  }

  /** Reload the catalog + persisted selection + active language for the live
   * board, swapping the dropdown ↔ note as appropriate. */
  async refresh(): Promise<void> {
    const board = this.getBoard();
    let result: LangCatalogResult;
    try {
      result = await this.api().catalog(board);
    } catch (e) {
      result = { entries: [], catalogUnavailable: true, error: e instanceof Error ? e.message : String(e) };
    }
    this.entries = sortedCatalogEntries(result.entries);
    this.renderCatalog(result);
    await this.reflectSelection(board);
    await this.refreshActive(board);
  }

  /** Build the dropdown (packs present) or the note (sideload-only / unavailable
   * / unsupported). Install is only meaningful with a dropdown. */
  private renderCatalog(result: LangCatalogResult): void {
    this.catalogHost.replaceChildren();
    this.select = null;
    const note = catalogNote(result);
    if (note !== null) {
      const noteEl = document.createElement("p");
      noteEl.className = "settings-row-desc type-caption lang-note";
      noteEl.textContent = note;
      this.catalogHost.append(noteEl);
      this.installBtn.hidden = true;
      return;
    }
    const control = document.createElement("label");
    control.className = "settings-watch-control";
    const label = document.createElement("span");
    label.className = "settings-watch-label type-body";
    label.textContent = "Language";
    const select = document.createElement("select");
    select.className = "settings-watch-select lang-select";
    for (const entry of this.entries) {
      const opt = document.createElement("option");
      opt.value = entry.isoLocal;
      opt.textContent = catalogOptionLabel(entry);
      select.append(opt);
    }
    control.append(label, select);
    this.catalogHost.append(control);
    this.select = select;
    this.installBtn.hidden = false;
  }

  /** Preselect the dropdown to the persisted catalog selection (if it's still in
   * the list). Sideload selections have no dropdown entry — left as-is. */
  private async reflectSelection(board: string): Promise<void> {
    if (!this.select) return;
    let sel: Selection | null = null;
    try {
      sel = await this.api().getSelection(board);
    } catch { /* best-effort — leave the default selection */ }
    if (sel?.source === "catalog" && sel.isoLocal && this.entries.some((e) => e.isoLocal === sel!.isoLocal)) {
      this.select.value = sel.isoLocal;
    }
  }

  /** Re-query and render the active-language line for `board`. */
  async refreshActive(board: string): Promise<void> {
    let active: LangActiveResult = null;
    try {
      active = await this.api().active(board);
    } catch { /* best-effort */ }
    this.activeLine.textContent = formatActive(active, this.entries) ?? "";
  }

  /** The catalog entry the dropdown currently points at, or null. */
  private selectedEntry(): CatalogEntry | null {
    if (!this.select) return null;
    return this.entries.find((e) => e.isoLocal === this.select!.value) ?? null;
  }

  /** Install a catalog pack + persist it, then refresh the active line. Shared by
   * the Install button and Reset-to-English. */
  private async installEntry(board: string, entry: CatalogEntry): Promise<void> {
    this.setStatus("Installing…");
    const res = await this.api().install(board, { source: "catalog", entry });
    if ("error" in res) { this.setError(res.error); this.setStatus(""); return; }
    await this.api().setSelection(board, selectionForEntry(entry));
    this.setStatus("");
    await this.refreshActive(board);
  }

  private onInstall(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.run(() => this.installEntry(this.getBoard(), entry));
  }

  private onSideload(): void {
    this.run(async () => {
      const r = await this.api().sideload();
      if ("error" in r) { this.setError(r.error); return; }
      if (!("pack" in r)) return; // cancelled — nothing picked
      const board = this.getBoard();
      this.setStatus("Installing…");
      const inst = await this.api().install(board, {
        source: "sideload", path: r.pack.path, fileName: r.pack.fileName,
      });
      if ("error" in inst) { this.setError(inst.error); this.setStatus(""); return; }
      await this.api().setSelection(board, selectionForSideload(r.pack));
      this.setStatus("");
      await this.refreshActive(board);
    });
  }

  private onReset(): void {
    this.run(async () => {
      const board = this.getBoard();
      const en = this.entries.find((e) => e.isoLocal === "en_US");
      if (en) { await this.installEntry(board, en); return; }
      // No en_US pack (sideload-only / unavailable catalog): clear the persisted
      // selection so a non-English pack stops re-asserting on future boots.
      await this.api().setSelection(board, null);
      this.setStatus("Reset to English (cleared the saved language).");
      await this.refreshActive(board);
    });
  }
}
