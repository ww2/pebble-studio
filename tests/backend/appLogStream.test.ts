import { describe, it, expect, vi } from "vitest";
import { AppLogStream } from "../../src/main/backend/appLogStream.js";

describe("AppLogStream", () => {
  it("splits a single push carrying multiple newline-separated lines (defensive)", () => {
    const seen: string[] = [];
    const s = new AppLogStream({ onLine: (l) => seen.push(l) });
    s.push("hello\nworld\n");
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
  it("emits a newline-less line immediately (no cross-push buffering)", () => {
    const seen: string[] = [];
    const s = new AppLogStream({ onLine: (l) => seen.push(l) });
    s.push("a-complete-line"); // pre-split by the feeder, no terminator
    expect(seen).toEqual(["a-complete-line"]);
    expect(s.history()).toEqual(["a-complete-line"]);
  });
  // Regression (#6 app-log panel showed nothing): the feeders (spawnLineStream and
  // the WinInputChannel) already deliver ONE complete, newline-STRIPPED line per
  // push() — the CLI path with no terminator, the channel path with a trailing CR.
  // push() must emit each such line; it previously re-split on "\n", found none, and
  // buffered every line forever so nothing ever reached the panel.
  it("emits a whole pre-split line with no trailing newline (CLI + channel feeders)", () => {
    const seen: string[] = [];
    const s = new AppLogStream({ onLine: (l) => seen.push(l) });
    s.push("[12:00:00] (app log stream connected)\r"); // channel-style: CR-terminated, no \n
    s.push("[12:00:01] main.c:42> hello world");        // CLI-style: no terminator at all
    expect(seen).toEqual([
      "[12:00:00] (app log stream connected)",
      "[12:00:01] main.c:42> hello world",
    ]);
    expect(s.history()).toEqual([
      "[12:00:00] (app log stream connected)",
      "[12:00:01] main.c:42> hello world",
    ]);
  });
});
