import { describe, it, expect, vi } from "vitest";
import { LibraryStore } from "../../src/main/library.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("LibraryStore", () => {
  it("adds and lists pbw entries, deduping by path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lib-"));
    const store = new LibraryStore(path.join(dir, "library.json"));
    store.add("/apps/a.pbw");
    store.add("/apps/a.pbw");
    store.add("/apps/b.pbw");
    expect(store.list()).toEqual(["/apps/a.pbw", "/apps/b.pbw"]);
  });
  it("persists across instances", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lib-"));
    const file = path.join(dir, "library.json");
    new LibraryStore(file).add("/apps/c.pbw");
    expect(new LibraryStore(file).list()).toEqual(["/apps/c.pbw"]);
  });
  it("removes entries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lib-"));
    const file = path.join(dir, "library.json");
    const s = new LibraryStore(file);
    s.add("/apps/a.pbw"); s.add("/apps/b.pbw"); s.remove("/apps/a.pbw");
    expect(s.list()).toEqual(["/apps/b.pbw"]);
  });
  it("writes atomically, leaving no leftover temp file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lib-"));
    const file = path.join(dir, "library.json");
    new LibraryStore(file).add("/apps/a.pbw");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(new LibraryStore(file).list()).toEqual(["/apps/a.pbw"]);
  });
  it("does not throw and rolls back in-memory state when the save fails", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Target a file in a non-existent directory so the write throws ENOENT.
    const file = path.join(tmpdir(), `lib-missing-${Date.now()}`, "library.json");
    const store = new LibraryStore(file);
    expect(() => store.add("/apps/a.pbw")).not.toThrow();
    expect(store.list()).toEqual([]); // rolled back — memory matches (empty) disk
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
