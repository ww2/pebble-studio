import { readFileSync, writeFileSync } from "node:fs";

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
      this.entries.push(pbwPath);
      this.save();
    }
  }

  remove(pbwPath: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e !== pbwPath);
    if (this.entries.length !== before) {
      this.save();
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

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2), "utf8");
  }
}
