import { describe, it, expect, vi } from "vitest";
import { win32 as winPath } from "node:path";
import {
  BOARD_TO_HW,
  reduceCatalog,
  validatePbpackHeader,
  makeLanguageController,
  NACK_HINT,
  type LangFs,
  type FetchFn,
  type FetchResponse,
  type LanguageControllerDeps,
} from "../../src/main/backend/languageController.js";
import type { RunResult } from "../../src/main/backend/BackendDriver.js";

// ---------------------------------------------------------------------------
// In-memory LangFs — keys on the exact (win32) path string.
// ---------------------------------------------------------------------------
function memFs(seed: Record<string, Buffer | string> = {}): {
  fs: LangFs;
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(seed)) {
    files.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8"));
  }
  const fs: LangFs = {
    readFile: async (p) => {
      const b = files.get(p);
      if (!b) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return b;
    },
    writeFile: async (p, data) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
    },
    readText: async (p) => {
      const b = files.get(p);
      return b ? b.toString("utf8") : null;
    },
    writeText: async (p, s) => {
      files.set(p, Buffer.from(s, "utf8"));
    },
    copyFile: async (src, dst) => {
      const b = files.get(src);
      if (!b) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(dst, Buffer.from(b));
    },
    mkdirp: async () => {},
    stat: async (p) => {
      const b = files.get(p);
      return b ? { size: b.length } : null;
    },
    exists: async (p) => files.has(p),
    rename: async (src, dst) => {
      const b = files.get(src);
      if (!b) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.delete(src);
      files.set(dst, b);
    },
  };
  return { fs, files };
}

const USER = "C:\\data";

/** A JSON fetch response for the catalog endpoint. */
function jsonResponse(body: unknown, ok = true, status = 200): FetchResponse {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    arrayBuffer: async () => new Uint8Array(Buffer.from(text)).buffer,
  };
}

function bytesResponse(buf: Buffer, ok = true, status = 200): FetchResponse {
  return {
    ok,
    status,
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => new Uint8Array(buf).buffer,
  };
}

function make(over: Partial<LanguageControllerDeps> = {}) {
  const { fs, files } = over.fs
    ? { fs: over.fs, files: new Map<string, Buffer>() }
    : memFs();
  const deps: LanguageControllerDeps = {
    userDataDir: USER,
    langHelperPath: "C:\\helpers\\pb-lang-helper.py",
    pythonExe: "C:\\py\\PebbleStudioEmu.exe",
    readPort: () => 6001,
    fs,
    now: () => 1_000_000,
    sleep: async () => {},
    ...over,
  };
  return { ctl: makeLanguageController(deps), fs, files, deps };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("reduceCatalog", () => {
  it("keeps the newest version per ISOLocal and reduces the schema", () => {
    const raw = [
      { ISOLocal: "fr_FR", name: "French", localName: "Français", version: 37, file: "a.pbl", firmware: "4.0", hardware: "snowy_dvt", id: 1 },
      { ISOLocal: "fr_FR", name: "French", localName: "Français", version: 38, file: "b.pbl", firmware: "4.0", hardware: "snowy_dvt", id: 2 },
      { ISOLocal: "de_DE", name: "German", localName: "Deutsch", version: 12, file: "c.pbl", firmware: "4.0", hardware: "snowy_dvt", id: 3 },
    ];
    const out = reduceCatalog(raw);
    expect(out).toHaveLength(2);
    const fr = out.find((e) => e.isoLocal === "fr_FR")!;
    expect(fr).toEqual({ isoLocal: "fr_FR", name: "French", localName: "Français", version: 38, file: "b.pbl" });
    expect(out.find((e) => e.isoLocal === "de_DE")!.version).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// validatePbpackHeader
// ---------------------------------------------------------------------------
describe("validatePbpackHeader", () => {
  it("accepts a real pbpack header (first uint32 LE in [1,256])", () => {
    const buf = Buffer.from([0x13, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    expect(validatePbpackHeader(buf)).toBe(true);
  });
  it("rejects garbage (count out of range) and too-short files", () => {
    expect(validatePbpackHeader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]))).toBe(false);
    expect(validatePbpackHeader(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false); // 0 entries
    expect(validatePbpackHeader(Buffer.from([1, 2, 3]))).toBe(false); // < 8 bytes
  });
  it("accepts the boundary 256 and rejects 257 (ceiling is inclusive-256)", () => {
    expect(validatePbpackHeader(Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]))).toBe(true); // 256 == 0x100
    expect(validatePbpackHeader(Buffer.from([0x01, 0x01, 0x00, 0x00, 0, 0, 0, 0]))).toBe(false); // 257 == 0x101
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog
// ---------------------------------------------------------------------------
describe("fetchCatalog", () => {
  it("returns empty WITHOUT hitting the network for sideload-only boards (emery)", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const { ctl } = make({ fetchFn });
    const res = await ctl.fetchCatalog("emery", "4.4.2");
    expect(res.entries).toEqual([]);
    expect(res.catalogUnavailable).toBeFalsy();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches, reduces, and caches on success", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse([
        { ISOLocal: "fr_FR", name: "French", localName: "Français", version: 38, file: "b.pbl" },
      ]),
    );
    const { ctl, fs } = make({ fetchFn });
    const res = await ctl.fetchCatalog("basalt", "4.4.2");
    expect(res.entries).toEqual([{ isoLocal: "fr_FR", name: "French", localName: "Français", version: 38, file: "b.pbl" }]);
    expect(fetchFn).toHaveBeenCalledOnce();
    // URL includes hw + firmware.
    const url = (fetchFn.mock.calls[0][0]) as string;
    expect(url).toContain("hw=snowy_dvt");
    expect(url).toContain("firmware=4.4.2");
    // Cache was written.
    const cachePath = winPath.join(USER, "lang-packs", "catalog", "snowy_dvt-4.4.2.json");
    expect(await fs.exists(cachePath)).toBe(true);
  });

  it("serves a FRESH cache without hitting the network", async () => {
    const cachePath = winPath.join(USER, "lang-packs", "catalog", "snowy_dvt-4.4.2.json");
    const cached = { fetchedAt: 1_000_000 - 1000, entries: [{ isoLocal: "es_ES", name: "Spanish", localName: "Español", version: 5, file: "es.pbl" }] };
    const { fs } = memFs({ [cachePath]: JSON.stringify(cached) });
    const fetchFn = vi.fn<FetchFn>();
    const { ctl } = make({ fs, fetchFn, now: () => 1_000_000 });
    const res = await ctl.fetchCatalog("basalt", "4.4.2");
    expect(res.entries[0].isoLocal).toBe("es_ES");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to a STALE cache when the network fails", async () => {
    const cachePath = winPath.join(USER, "lang-packs", "catalog", "snowy_dvt-4.4.2.json");
    const stale = { fetchedAt: 0, entries: [{ isoLocal: "it_IT", name: "Italian", localName: "Italiano", version: 9, file: "it.pbl" }] };
    const { fs } = memFs({ [cachePath]: JSON.stringify(stale) });
    const fetchFn = vi.fn<FetchFn>(async () => { throw new Error("network down"); });
    const { ctl } = make({ fs, fetchFn, now: () => 100_000_000 }); // far past 24h
    const res = await ctl.fetchCatalog("basalt", "4.4.2");
    expect(res.entries[0].isoLocal).toBe("it_IT");
    expect(res.catalogUnavailable).toBeFalsy();
    expect(fetchFn).toHaveBeenCalled();
  });

  it("returns catalogUnavailable when the network fails and there is no cache", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => { throw new Error("network down"); });
    const { ctl } = make({ fetchFn });
    const res = await ctl.fetchCatalog("basalt", "4.4.2");
    expect(res.entries).toEqual([]);
    expect(res.catalogUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sideload
// ---------------------------------------------------------------------------
describe("sideload", () => {
  it("validates the header and copies into lang-packs, returning a StoredPack", async () => {
    const src = "D:\\downloads\\french.pbl";
    const { fs } = memFs({ [src]: Buffer.from([0x13, 0, 0, 0, 1, 2, 3, 4]) });
    const { ctl } = make({ fs });
    const pack = await ctl.sideload(src);
    expect(pack.source).toBe("sideload");
    expect(pack.fileName).toBe("french.pbl");
    const dst = winPath.join(USER, "lang-packs", "french.pbl");
    expect(pack.path).toBe(dst);
    expect(await fs.exists(dst)).toBe(true);
  });

  it("rejects a file that is not a valid pbpack", async () => {
    const src = "D:\\downloads\\bogus.pbl";
    const { fs } = memFs({ [src]: Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]) });
    const { ctl } = make({ fs });
    await expect(ctl.sideload(src)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// installPack — retry policy
// ---------------------------------------------------------------------------
describe("installPack", () => {
  const sidePack = { source: "sideload" as const, path: "C:\\data\\lang-packs\\x.pbl", fileName: "x.pbl" };

  function helperSpawn(results: RunResult[]) {
    let i = 0;
    return vi.fn(async (): Promise<RunResult> => results[Math.min(i++, results.length - 1)]);
  }
  const okLine = (lang: string) => JSON.stringify({ ok: true, language: lang, languageVersion: 38 });
  const connLine = JSON.stringify({ ok: false, error: "refused", kind: "connect" });
  const nackLine = JSON.stringify({ ok: false, error: "putbytes nack", kind: "nack" });

  it("retries connection-class failures, then succeeds", async () => {
    const spawn = helperSpawn([
      { code: 1, stdout: connLine, stderr: "" },
      { code: 1, stdout: connLine, stderr: "" },
      { code: 0, stdout: okLine("fr_FR"), stderr: "" },
    ]);
    const { ctl } = make({ spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    const r = await ctl.installPack("basalt", sidePack);
    expect(r.language).toBe("fr_FR");
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a NACK — fails immediately with the flash/firmware hint", async () => {
    const spawn = helperSpawn([{ code: 1, stdout: nackLine, stderr: "" }]);
    const { ctl } = make({ spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    await expect(ctl.installPack("basalt", sidePack)).rejects.toThrow(NACK_HINT);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry cap on persistent connection failures", async () => {
    const spawn = helperSpawn([{ code: 1, stdout: connLine, stderr: "" }]);
    const { ctl } = make({ spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    await expect(ctl.installPack("basalt", sidePack)).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(8); // INSTALL_MAX_ATTEMPTS
  });

  const deEntry = { source: "catalog" as const, entry: { isoLocal: "de_DE", name: "German", localName: "Deutsch", version: 12, file: "https://lp.rebble.io/packs/de.pbl" } };
  const dePath = winPath.join(USER, "lang-packs", "basalt", "de.pbl");

  it("downloads a catalog pack once — a second install reuses the VALID cached file", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => bytesResponse(Buffer.from([0x13, 0, 0, 0, 9, 9, 9, 9])));
    const spawn = helperSpawn([{ code: 0, stdout: okLine("de_DE"), stderr: "" }]);
    const { ctl, fs } = make({
      fetchFn,
      spawn: spawn as unknown as LanguageControllerDeps["spawn"],
    });
    const r = await ctl.installPack("basalt", deEntry);
    expect(r.language).toBe("de_DE");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(await fs.exists(dePath)).toBe(true);
    // No leftover temp file from the atomic download commit.
    expect(await fs.exists(`${dePath}.download`)).toBe(false);
    // Second install: the valid cached file is reused — NO second download.
    const r2 = await ctl.installPack("basalt", deEntry);
    expect(r2.language).toBe("de_DE");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects a corrupt download body (HTML/truncated) WITHOUT caching it, with a clear error (not the NACK hint)", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => bytesResponse(Buffer.from("<html>captive portal</html>", "utf8")));
    const spawn = vi.fn();
    const { ctl, fs } = make({ fetchFn, spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    await expect(ctl.installPack("basalt", deEntry)).rejects.toThrow(/corrupt or invalid/);
    await expect(ctl.installPack("basalt", deEntry)).rejects.not.toThrow(NACK_HINT);
    // Nothing was committed to disk — the bad body must not poison future installs.
    expect(await fs.exists(dePath)).toBe(false);
    expect(await fs.exists(`${dePath}.download`)).toBe(false);
    // The helper was never spawned with a garbage pack.
    expect(spawn).not.toHaveBeenCalled();
  });

  it("re-downloads when the existing cached file is invalid (self-heals a poisoned cache)", async () => {
    const { fs, files } = memFs({ [dePath]: Buffer.from("<html>old bad cache</html>", "utf8") });
    const good = Buffer.from([0x13, 0, 0, 0, 7, 7, 7, 7]);
    const fetchFn = vi.fn<FetchFn>(async () => bytesResponse(good));
    const spawn = helperSpawn([{ code: 0, stdout: okLine("de_DE"), stderr: "" }]);
    const { ctl } = make({ fs, fetchFn, spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    const r = await ctl.installPack("basalt", deEntry);
    expect(r.language).toBe("de_DE");
    expect(fetchFn).toHaveBeenCalledOnce(); // invalid cache → re-download
    expect(files.get(dePath)).toEqual(good); // replaced with the valid bytes
  });
});

// ---------------------------------------------------------------------------
// selection persistence
// ---------------------------------------------------------------------------
describe("selection / setSelection", () => {
  it("round-trips a per-board selection and deletes on null", async () => {
    const { ctl } = make();
    expect(await ctl.selection("basalt")).toBeNull();
    await ctl.setSelection("basalt", { source: "catalog", isoLocal: "fr_FR", name: "French", url: "https://x/fr.pbl" });
    await ctl.setSelection("chalk", { source: "sideload", path: "C:\\data\\lang-packs\\z.pbl", name: "z.pbl" });
    expect(await ctl.selection("basalt")).toEqual({ source: "catalog", isoLocal: "fr_FR", name: "French", url: "https://x/fr.pbl" });
    expect(await ctl.selection("chalk")).toMatchObject({ source: "sideload" });
    await ctl.setSelection("basalt", null);
    expect(await ctl.selection("basalt")).toBeNull();
    // chalk survives basalt's deletion.
    expect(await ctl.selection("chalk")).toMatchObject({ source: "sideload" });
  });

  it("persists across controller instances (same fs)", async () => {
    const { fs } = memFs();
    const a = make({ fs });
    await a.ctl.setSelection("basalt", { source: "catalog", isoLocal: "es_ES", name: "Spanish", url: "u" });
    const b = make({ fs });
    expect(await b.ctl.selection("basalt")).toMatchObject({ isoLocal: "es_ES" });
  });
});

// ---------------------------------------------------------------------------
// reassertOnLive
// ---------------------------------------------------------------------------
describe("reassertOnLive", () => {
  it("no-ops when there is no selection for the board", async () => {
    const spawn = vi.fn();
    const { ctl } = make({ spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    await expect(ctl.reassertOnLive("basalt")).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("installs the persisted sideload selection and never throws on failure", async () => {
    const path = winPath.join(USER, "lang-packs", "x.pbl");
    const { fs } = memFs({ [path]: Buffer.from([0x13, 0, 0, 0, 1, 1, 1, 1]) });
    const spawn = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: JSON.stringify({ ok: false, kind: "connect", error: "x" }), stderr: "" }));
    const { ctl } = make({ fs, spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    await ctl.setSelection("basalt", { source: "sideload", path, name: "x.pbl" });
    // Even though every attempt fails (connect), reassert swallows and resolves.
    await expect(ctl.reassertOnLive("basalt")).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// queryActive
// ---------------------------------------------------------------------------
describe("queryActive", () => {
  it("returns the active language on success", async () => {
    const spawn = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: JSON.stringify({ ok: true, language: "fr_FR", languageVersion: 38 }), stderr: "" }));
    const { ctl } = make({ spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    expect(await ctl.queryActive("basalt")).toEqual({ language: "fr_FR", languageVersion: 38 });
  });

  it("returns null on any failure or when not booted", async () => {
    const spawn = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: JSON.stringify({ ok: false, kind: "connect", error: "x" }), stderr: "" }));
    const { ctl } = make({ spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    expect(await ctl.queryActive("basalt")).toBeNull();
    const notBooted = make({ readPort: () => null, spawn: spawn as unknown as LanguageControllerDeps["spawn"] });
    expect(await notBooted.ctl.queryActive("basalt")).toBeNull();
  });
});

describe("BOARD_TO_HW", () => {
  it("maps the four catalog boards and omits sideload-only boards", () => {
    expect(BOARD_TO_HW).toEqual({ aplite: "ev2_4", basalt: "snowy_dvt", chalk: "spalding", diorite: "silk" });
    expect((BOARD_TO_HW as Record<string, string>).emery).toBeUndefined();
  });
});
