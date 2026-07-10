import { describe, it, expect, vi } from "vitest";
import { AppLogStream } from "../../src/main/backend/appLogStream.js";

describe("AppLogStream", () => {
  it("accumulates partial chunks into whole lines and emits each once", () => {
    const seen: string[] = [];
    const s = new AppLogStream({ onLine: (l) => seen.push(l) });
    s.push("hel");
    s.push("lo\nwor");
    s.push("ld\n");
    expect(seen).toEqual(["hello", "world"]);
    expect(s.history()).toEqual(["hello", "world"]);
  });
  it("normalizes CRLF", () => {
    const s = new AppLogStream();
    s.push("a\r\nb\r\n");
    expect(s.history()).toEqual(["a", "b"]);
  });
  it("caps history to the newest `cap` lines", () => {
    const s = new AppLogStream({ cap: 2 });
    s.push("1\n2\n3\n4\n");
    expect(s.history()).toEqual(["3", "4"]);
  });
  it("clear() empties history but keeps the line accumulator working", () => {
    const s = new AppLogStream();
    s.push("x\n");
    s.clear();
    expect(s.history()).toEqual([]);
    s.push("y\n");
    expect(s.history()).toEqual(["y"]);
  });
  it("clear() also drops a buffered partial so the next line has no stale prefix", () => {
    const seen: string[] = [];
    const s = new AppLogStream({ onLine: (l) => seen.push(l) });
    s.push("stale-frag"); // no newline → held as the partial
    s.clear();
    s.push("fresh\n");
    expect(s.history()).toEqual(["fresh"]);   // NOT "stale-fragfresh"
    expect(seen).toEqual(["fresh"]);
  });
});
