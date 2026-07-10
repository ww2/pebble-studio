import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";

/**
 * Persistent store for the installed-app library.
 * Backed by a JSON file; tolerates missing or corrupt files by starting empty.
 */
export class LibraryStore {
  private readonly file: string;
  private entries: string[];

  constructor(file: string) {
    this.file = file;
    this.entries = this.load();
  }

  add(pbwPath: string): void {
    if (!this.entries.includes(pbwPath)) {
      const prev = this.entries;
      this.entries = [...prev, pbwPath];
      this.save(prev);
    }
  }

  remove(pbwPath: string): void {
    const filtered = this.entries.filter((e) => e !== pbwPath);
    if (filtered.length !== this.entries.length) {
      const prev = this.entries;
      this.entries = filtered;
      this.save(prev);
    }
  }

  list(): string[] {
    return [...this.entries];
  }

  private load(): string[] {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((e): e is string => typeof e === "string");
      }
    } catch {
      // Missing or corrupt file — start empty.
    }
    return [];
  }

  /**
   * Persist entries atomically (write a temp file, then rename over the target
   * so a crash mid-write can't leave a truncated JSON file). On failure roll the
   * in-memory state back to `prev` so the store never diverges from disk, and log
   * rather than throw out of add/remove.
   */
  private save(prev: string[]): void {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.entries, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      this.entries = prev;
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
      console.error(`[library] failed to save ${this.file}:`, err);
    }
  }
}
