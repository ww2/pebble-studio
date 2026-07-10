import { describe, it, expect, vi } from "vitest";
import {
  makeLangHandlers,
  kickLangReassert,
  LANG_NOT_SUPPORTED,
  type LangIpcDeps,
} from "../../src/main/langIpc.js";
import type {
  LanguageController,
  PackRef,
} from "../../src/main/backend/languageController.js";

// ---------------------------------------------------------------------------
// A fully-mocked LanguageController. Each handler must DELEGATE to it — the IPC
// layer owns only gating (native-only), file-pick, and error→string mapping.
// ---------------------------------------------------------------------------
function stubController(over: Partial<LanguageController> = {}): LanguageController {
  return {
    fetchCatalog: vi.fn(async () => ({ entries: [] })),
    sideload: vi.fn(async () => ({
      path: "C:\\data\\lang-packs\\x.pbl",
      fileName: "x.pbl",
      source: "sideload" as const,
    })),
    installPack: vi.fn(async () => ({ language: "fr_FR" })),
    selection: vi.fn(async () => null),
    setSelection: vi.fn(async () => {}),
    reassertOnLive: vi.fn(async () => {}),
    queryActive: vi.fn(async () => null),
    ...over,
  };
}

function makeDeps(
  controller: LanguageController | null,
  over: Partial<LangIpcDeps> = {},
): LangIpcDeps {
  return {
    getController: async () => controller,
    getFwVersion: async () => "4.4.2",
    pickPblFile: async () => "D:\\downloads\\french.pbl",
    ...over,
  };
}

const sidePack: PackRef = { source: "sideload", path: "C:\\data\\lang-packs\\x.pbl", fileName: "x.pbl" };

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------
describe("lang catalog handler", () => {
  it("delegates to the controller with the board + firmware version", async () => {
    const c = stubController({
      fetchCatalog: vi.fn(async () => ({ entries: [{ isoLocal: "fr_FR", name: "French", localName: "Français", version: 38, file: "b.pbl" }] })),
    });
    const h = makeLangHandlers(makeDeps(c));
    const res = await h.catalog("basalt");
    expect(c.fetchCatalog).toHaveBeenCalledWith("basalt", "4.4.2");
    expect(res.entries).toHaveLength(1);
    expect(res.error).toBeUndefined();
  });

  it("returns a not-supported error (no controller) without touching the network", async () => {
    const h = makeLangHandlers(makeDeps(null));
    const res = await h.catalog("basalt");
    expect(res.entries).toEqual([]);
    expect(res.error).toBe(LANG_NOT_SUPPORTED);
  });

  it("rejects an unknown board without delegating", async () => {
    const c = stubController();
    const h = makeLangHandlers(makeDeps(c));
    const res = await h.catalog("not-a-board");
    expect(res.error).toBeTruthy();
    expect(c.fetchCatalog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------
describe("lang install handler", () => {
  it("delegates to installPack and returns { language }", async () => {
    const c = stubController();
    const h = makeLangHandlers(makeDeps(c));
    const res = await h.install("basalt", sidePack);
    expect(c.installPack).toHaveBeenCalledWith("basalt", sidePack);
    expect(res).toEqual({ language: "fr_FR" });
  });

  it("surfaces an install failure as an { error } string the UI can show", async () => {
    const c = stubController({
      installPack: vi.fn(async () => { throw new Error("The watch rejected this pack."); }),
    });
    const h = makeLangHandlers(makeDeps(c));
    const res = await h.install("basalt", sidePack);
    expect(res).toEqual({ error: "The watch rejected this pack." });
  });

  it("returns the not-supported error on a non-native backend", async () => {
    const h = makeLangHandlers(makeDeps(null));
    expect(await h.install("basalt", sidePack)).toEqual({ error: LANG_NOT_SUPPORTED });
  });
});

// ---------------------------------------------------------------------------
// sideload
// ---------------------------------------------------------------------------
describe("lang sideload handler", () => {
  it("opens the picker, stores the pack, and returns it", async () => {
    const c = stubController();
    const h = makeLangHandlers(makeDeps(c));
    const res = await h.sideload();
    expect(c.sideload).toHaveBeenCalledWith("D:\\downloads\\french.pbl");
    expect(res).toEqual({ pack: { path: "C:\\data\\lang-packs\\x.pbl", fileName: "x.pbl", source: "sideload" } });
  });

  it("surfaces a validation failure as an { error } string", async () => {
    const c = stubController({
      sideload: vi.fn(async () => { throw new Error("That file isn't a valid Pebble language pack (.pbl)."); }),
    });
    const h = makeLangHandlers(makeDeps(c));
    const res = await h.sideload();
    expect(res).toEqual({ error: "That file isn't a valid Pebble language pack (.pbl)." });
  });

  it("returns { cancelled } when the user dismisses the picker", async () => {
    const c = stubController();
    const h = makeLangHandlers(makeDeps(c, { pickPblFile: async () => null }));
    const res = await h.sideload();
    expect(res).toEqual({ cancelled: true });
    expect(c.sideload).not.toHaveBeenCalled();
  });

  it("returns the not-supported error on a non-native backend", async () => {
    const h = makeLangHandlers(makeDeps(null));
    expect(await h.sideload()).toEqual({ error: LANG_NOT_SUPPORTED });
  });
});

// ---------------------------------------------------------------------------
// active / selection
// ---------------------------------------------------------------------------
describe("lang active + selection handlers", () => {
  it("active delegates to queryActive", async () => {
    const c = stubController({ queryActive: vi.fn(async () => ({ language: "de_DE", languageVersion: 12 })) });
    const h = makeLangHandlers(makeDeps(c));
    expect(await h.active("basalt")).toEqual({ language: "de_DE", languageVersion: 12 });
    expect(c.queryActive).toHaveBeenCalledWith("basalt");
  });

  it("active returns null on a non-native backend", async () => {
    const h = makeLangHandlers(makeDeps(null));
    expect(await h.active("basalt")).toBeNull();
  });

  it("getSelection + setSelection delegate to the controller", async () => {
    const sel = { source: "catalog" as const, isoLocal: "fr_FR", name: "French", url: "https://x/fr.pbl" };
    const c = stubController({ selection: vi.fn(async () => sel) });
    const h = makeLangHandlers(makeDeps(c));
    expect(await h.getSelection("basalt")).toEqual(sel);
    await h.setSelection("basalt", sel);
    expect(c.setSelection).toHaveBeenCalledWith("basalt", sel);
  });

  it("setSelection is a no-op on a non-native backend (never throws)", async () => {
    const h = makeLangHandlers(makeDeps(null));
    await expect(h.setSelection("basalt", null)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kickLangReassert — the post-live fire-and-forget hook
// ---------------------------------------------------------------------------
describe("kickLangReassert", () => {
  it("fires WITHOUT awaiting the reassert (returns void synchronously)", async () => {
    // reassertOnLive returns a promise that never resolves; the kick must NOT
    // block on it (it runs off the boot critical path, like the health reassert).
    let started = false;
    const reassertOnLive = vi.fn(() => { started = true; return new Promise<void>(() => {}); });
    const c = stubController({ reassertOnLive });
    const ret = kickLangReassert(async () => c, "basalt");
    // The call returns void immediately — it did not return (or await) the promise.
    expect(ret).toBeUndefined();
    // The reassert is scheduled and eventually invoked with the board, off-thread.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(true);
    expect(reassertOnLive).toHaveBeenCalledWith("basalt");
  });

  it("no-ops when there is no controller (non-native backend)", async () => {
    const getController = vi.fn(async () => null);
    kickLangReassert(getController, "basalt");
    await Promise.resolve();
    await Promise.resolve();
    expect(getController).toHaveBeenCalled(); // resolved to null → nothing else happened
  });

  it("swallows a reassert/getController rejection and logs it (never throws)", async () => {
    const log = vi.fn();
    kickLangReassert(async () => { throw new Error("boom"); }, "basalt", log);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toHaveBeenCalled();
  });
});
