// @vitest-environment jsdom
//
// Language panel (Task 11) tests. Runs under jsdom (per-file, so the rest of the
// suite stays on the default node env) so we can mount the real component and
// mock the injected `window.studio.lang` surface. Covers the pure formatting
// helpers plus the mounted install / sideload / note / in-flight behaviours.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LanguagePanel,
  sortedCatalogEntries,
  catalogOptionLabel,
  catalogNote,
  formatActive,
  selectionForEntry,
  selectionForSideload,
  type LangApiLike,
} from "../../src/renderer/components/LanguagePanel.js";
import type { CatalogEntry } from "../../src/main/backend/languageController.js";

const ENTRIES: CatalogEntry[] = [
  { isoLocal: "fr_FR", name: "French", localName: "Français", version: 1, file: "fr.pbl" },
  { isoLocal: "de_DE", name: "German", localName: "Deutsch", version: 2, file: "de.pbl" },
  { isoLocal: "en_US", name: "English", localName: "English", version: 1, file: "en.pbl" },
];

const frEntry = ENTRIES[0];

// ── pure helpers ──────────────────────────────────────────────────────────
describe("LanguagePanel helpers", () => {
  it("sorts catalog entries alphabetically by English name", () => {
    const names = sortedCatalogEntries(ENTRIES).map((e) => e.name);
    expect(names).toEqual(["English", "French", "German"]);
  });

  it("labels an entry localName primary, English name secondary", () => {
    expect(catalogOptionLabel(frEntry)).toBe("Français — French");
  });

  it("collapses the label when localName equals the English name", () => {
    expect(catalogOptionLabel(ENTRIES[2])).toBe("English");
  });

  it("catalogNote: entries present → no note", () => {
    expect(catalogNote({ entries: ENTRIES })).toBeNull();
  });

  it("catalogNote: sideload-only board (empty, no flag) → sideload hint", () => {
    expect(catalogNote({ entries: [] })).toBe(
      "No official packs for this board — sideload a .pbl instead",
    );
  });

  it("catalogNote: catalogUnavailable → unavailable note", () => {
    expect(catalogNote({ entries: [], catalogUnavailable: true })).toBe(
      "Catalog unavailable — sideload still works",
    );
  });

  it("catalogNote: surfaces an {error} verbatim", () => {
    expect(catalogNote({ entries: [], error: "Language packs are only available on the native Windows backend." }))
      .toBe("Language packs are only available on the native Windows backend.");
  });

  it("selectionForEntry maps to a catalog LangSelection", () => {
    expect(selectionForEntry(frEntry)).toEqual({
      source: "catalog", isoLocal: "fr_FR", name: "French", url: "fr.pbl",
    });
  });

  it("selectionForSideload maps to a sideload LangSelection", () => {
    expect(selectionForSideload({ path: "C:\\x\\ru.pbl", fileName: "ru.pbl", source: "sideload" }))
      .toEqual({ source: "sideload", path: "C:\\x\\ru.pbl", name: "ru.pbl" });
  });

  it("formatActive maps a known code to its localName", () => {
    expect(formatActive({ language: "fr_FR", languageVersion: 1 }, ENTRIES))
      .toBe("Active: Français (fr_FR)");
  });

  it("formatActive falls back to the raw code when unknown", () => {
    expect(formatActive({ language: "zz_ZZ", languageVersion: 0 }, ENTRIES))
      .toBe("Active: zz_ZZ");
  });

  it("formatActive returns null when nothing is active", () => {
    expect(formatActive(null, ENTRIES)).toBeNull();
  });
});

// ── mounted component ───────────────────────────────────────────────────────
function makeApi(over: Partial<LangApiLike> = {}): LangApiLike {
  return {
    catalog: vi.fn().mockResolvedValue({ entries: ENTRIES }),
    install: vi.fn().mockResolvedValue({ language: "fr_FR" }),
    sideload: vi.fn().mockResolvedValue({ cancelled: true }),
    active: vi.fn().mockResolvedValue(null),
    getSelection: vi.fn().mockResolvedValue(null),
    setSelection: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const $ = (root: HTMLElement, sel: string): HTMLElement =>
  root.querySelector(sel) as HTMLElement;

describe("LanguagePanel (mounted)", () => {
  // Every case shares ONE jsdom window, so panels are disposed after each test —
  // otherwise their window listeners (board-changed / apps-changed) pile up and
  // earlier panels react to later tests' dispatches.
  const mounted: LanguagePanel[] = [];
  const mount = (getBoard: () => string, api: LangApiLike): LanguagePanel => {
    const panel = new LanguagePanel(getBoard, api);
    mounted.push(panel);
    return panel;
  };

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    for (const p of mounted.splice(0)) p.dispose();
  });

  it("renders catalog entries in the dropdown, sorted by name", async () => {
    const api = makeApi();
    const panel = mount(() => "basalt", api);
    await panel.refresh();
    const opts = [...panel.el.querySelectorAll<HTMLOptionElement>("select.lang-select option")];
    expect(opts.map((o) => o.textContent)).toEqual([
      "English", "Français — French", "Deutsch — German",
    ]);
    expect(opts.map((o) => o.value)).toEqual(["en_US", "fr_FR", "de_DE"]);
  });

  it("install flow persists the selection and shows the active language", async () => {
    const active = vi.fn()
      .mockResolvedValueOnce(null) // initial refresh
      .mockResolvedValue({ language: "fr_FR", languageVersion: 1 }); // after install
    const api = makeApi({ active });
    const panel = mount(() => "basalt", api);
    await panel.refresh();

    const select = $(panel.el, "select.lang-select") as HTMLSelectElement;
    select.value = "fr_FR";
    ($(panel.el, "button.lang-install") as HTMLButtonElement).click();
    await panel.whenIdle();

    expect(api.install).toHaveBeenCalledWith("basalt", { source: "catalog", entry: frEntry });
    expect(api.setSelection).toHaveBeenCalledWith("basalt", selectionForEntry(frEntry));
    expect($(panel.el, ".lang-active").textContent).toBe("Active: Français (fr_FR)");
  });

  it("shows the {error} string verbatim on a failed install", async () => {
    const api = makeApi({ install: vi.fn().mockResolvedValue({ error: "The watch rejected this pack." }) });
    const panel = mount(() => "basalt", api);
    await panel.refresh();
    ($(panel.el, "button.lang-install") as HTMLButtonElement).click();
    await panel.whenIdle();
    expect($(panel.el, ".lang-error").textContent).toBe("The watch rejected this pack.");
    expect(api.setSelection).not.toHaveBeenCalled();
  });

  it("shows the sideload-only note (no dropdown) for a sideload-only board", async () => {
    const api = makeApi({ catalog: vi.fn().mockResolvedValue({ entries: [] }) });
    const panel = mount(() => "emery", api);
    await panel.refresh();
    expect(panel.el.querySelector("select.lang-select")).toBeNull();
    expect($(panel.el, ".lang-note").textContent).toBe(
      "No official packs for this board — sideload a .pbl instead",
    );
  });

  it("shows the catalog-unavailable note", async () => {
    const api = makeApi({ catalog: vi.fn().mockResolvedValue({ entries: [], catalogUnavailable: true }) });
    const panel = mount(() => "basalt", api);
    await panel.refresh();
    expect($(panel.el, ".lang-note").textContent).toBe("Catalog unavailable — sideload still works");
  });

  it("disables the action buttons while an install is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<{ language: string }>((r) => {
      release = () => r({ language: "fr_FR" });
    });
    const api = makeApi({ install: vi.fn().mockReturnValue(gate) });
    const panel = mount(() => "basalt", api);
    await panel.refresh();

    const installBtn = $(panel.el, "button.lang-install") as HTMLButtonElement;
    const sideloadBtn = $(panel.el, "button.lang-sideload") as HTMLButtonElement;
    installBtn.click();
    await Promise.resolve(); // let the click handler set the in-flight state
    expect(installBtn.disabled).toBe(true);
    expect(sideloadBtn.disabled).toBe(true);

    release();
    await panel.whenIdle();
    expect(installBtn.disabled).toBe(false);
    expect(sideloadBtn.disabled).toBe(false);
  });

  it("Reset to English installs the en_US entry when the catalog has it", async () => {
    const api = makeApi();
    const panel = mount(() => "basalt", api);
    await panel.refresh();
    ($(panel.el, "button.lang-reset") as HTMLButtonElement).click();
    await panel.whenIdle();
    expect(api.install).toHaveBeenCalledWith("basalt", { source: "catalog", entry: ENTRIES[2] });
  });

  it("Reset to English clears the selection when no en_US entry exists", async () => {
    const api = makeApi({ catalog: vi.fn().mockResolvedValue({ entries: [] }) });
    const panel = mount(() => "emery", api);
    await panel.refresh();
    ($(panel.el, "button.lang-reset") as HTMLButtonElement).click();
    await panel.whenIdle();
    expect(api.setSelection).toHaveBeenCalledWith("emery", null);
    expect(api.install).not.toHaveBeenCalled();
  });

  // ── reactivity wiring (window events) ─────────────────────────────────────

  it("reloads for the new board on pebble-studio:board-changed", async () => {
    let board = "basalt";
    const catalog = vi.fn(async (b: string) =>
      b === "basalt" ? { entries: ENTRIES } : { entries: [] });
    const api = makeApi({ catalog });
    const panel = mount(() => board, api);
    await panel.refresh();
    expect(panel.el.querySelector("select.lang-select")).not.toBeNull();

    board = "emery";
    window.dispatchEvent(new Event("pebble-studio:board-changed"));
    await panel.whenIdle();

    expect(catalog).toHaveBeenCalledWith("emery");
    expect(panel.el.querySelector("select.lang-select")).toBeNull();
    expect($(panel.el, ".lang-note").textContent).toBe(
      "No official packs for this board — sideload a .pbl instead",
    );
  });

  it("refreshes the active line on pebble-studio:apps-changed (Live)", async () => {
    let current: { language: string; languageVersion: number } | null = null;
    const api = makeApi({ active: vi.fn(async () => current) });
    const panel = mount(() => "basalt", api);
    await panel.refresh();
    expect($(panel.el, ".lang-active").textContent).toBe("");

    current = { language: "fr_FR", languageVersion: 1 }; // boot re-asserted the pack
    window.dispatchEvent(new Event("pebble-studio:apps-changed"));
    await panel.whenIdle();

    expect($(panel.el, ".lang-active").textContent).toBe("Active: Français (fr_FR)");
  });

  it("drops a stale refresh that resolves after a newer one (board-switch race)", async () => {
    let board = "basalt";
    const resolvers: Record<string, (r: { entries: CatalogEntry[] }) => void> = {};
    const catalog = vi.fn(
      (b: string) => new Promise<{ entries: CatalogEntry[] }>((res) => { resolvers[b] = res; }),
    );
    const api = makeApi({ catalog });
    const panel = mount(() => board, api);
    const firstRefresh = panel.whenIdle(); // constructor refresh for basalt (held)

    board = "emery";
    window.dispatchEvent(new Event("pebble-studio:board-changed"));
    const secondRefresh = panel.whenIdle();

    // The NEWER board's catalog resolves first, the OLD board's afterwards:
    // the stale basalt result must be dropped, not overwrite emery's note.
    resolvers["emery"]({ entries: [] });
    await secondRefresh;
    resolvers["basalt"]({ entries: ENTRIES });
    await firstRefresh;

    expect(panel.el.querySelector("select.lang-select")).toBeNull();
    expect($(panel.el, ".lang-note").textContent).toBe(
      "No official packs for this board — sideload a .pbl instead",
    );
  });

  it("does not install a stale entry when the board changed under the dropdown", async () => {
    let board = "basalt";
    const api = makeApi();
    const panel = mount(() => board, api);
    await panel.refresh(); // dropdown now holds basalt's entries

    // Board switched but the board-changed reload hasn't landed yet: the click
    // must NOT install basalt's pack onto emery.
    board = "emery";
    ($(panel.el, "button.lang-install") as HTMLButtonElement).click();
    await panel.whenIdle();

    expect(api.install).not.toHaveBeenCalled();
    expect(api.setSelection).not.toHaveBeenCalled();
    // The mismatch kicked a reload for the new board instead.
    expect(api.catalog).toHaveBeenCalledWith("emery");
  });
});
