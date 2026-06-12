import { describe, it, expect } from "vitest";
import { nextIndexedName } from "../../src/main/ipc.js";

/**
 * nextIndexedName is the pure scan/number helper behind `capture:nextName`. Given
 * the existing filenames in the capture dir, it returns the HIGHEST index matching
 * `^<base>-(\d+)\.<ext>$` (or -1 when none match); the caller forms the next name
 * as `<base>-<result + 1>.<ext>` so numbering starts at 1.
 */
describe("nextIndexedName", () => {
  const base = "pebble-shot-emery";

  it("returns -1 when no files exist (next name starts at 1)", () => {
    expect(nextIndexedName([], base, "png")).toBe(-1);
  });

  it("returns the max index, tolerating gaps", () => {
    const names = [`${base}-1.png`, `${base}-3.png`, `${base}-2.png`];
    expect(nextIndexedName(names, base, "png")).toBe(3);
  });

  it("ignores files with a different base prefix", () => {
    const names = [`${base}-2.png`, "pebble-shot-basalt-9.png", "other-50.png"];
    expect(nextIndexedName(names, base, "png")).toBe(2);
  });

  it("ignores the wrong extension", () => {
    const names = [`${base}-2.png`, `${base}-7.gif`];
    expect(nextIndexedName(names, base, "png")).toBe(2);
    expect(nextIndexedName(names, base, "gif")).toBe(7);
  });

  it("ignores non-indexed and malformed names", () => {
    const names = [`${base}.png`, `${base}-.png`, `${base}-x.png`, `${base}-4.png`];
    expect(nextIndexedName(names, base, "png")).toBe(4);
  });

  it("does not let regex metacharacters in the base leak into the pattern", () => {
    // The '.' in the base must be matched literally, not as 'any char'.
    const names = ["pebble.shot-3.png", "pebbleXshot-9.png"];
    expect(nextIndexedName(names, "pebble.shot", "png")).toBe(3);
  });
});
