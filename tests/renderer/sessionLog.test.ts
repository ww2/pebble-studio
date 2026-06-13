import { describe, it, expect } from "vitest";
import { SessionLog, fmtClock } from "../../src/renderer/sessionLog.js";

/** A controllable clock so timestamps are deterministic. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("SessionLog", () => {
  it("appends discrete entries in order and exposes them as timestamped lines", () => {
    const clk = fakeClock();
    const log = new SessionLog({ now: clk.now });
    log.append("info", "▶ Booting Pebble Time 2");
    clk.advance(1000);
    log.append("live", "● Live");
    expect(log.size).toBe(2);
    const lines = log.toLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\s+▶ Booting Pebble Time 2$/);
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2}\s+● Live$/);
    expect(log.toText()).toBe(lines.join("\n"));
  });

  it("collapses consecutive boot ticks for the same phase onto one updating entry", () => {
    const log = new SessionLog({ now: fakeClock().now });
    log.appendBootStep("Waiting for state file · 2s · qemu ✓");
    log.appendBootStep("Waiting for state file · 4s · qemu ✓");
    log.appendBootStep("Waiting for state file · 6s · qemu ✓");
    // Same phase prefix ⇒ a single entry that reflects the latest tick.
    expect(log.size).toBe(1);
    expect(log.toLines()[0]).toMatch(/Waiting for state file · 6s · qemu ✓$/);
  });

  it("stacks distinct boot phases instead of collapsing", () => {
    const log = new SessionLog({ now: fakeClock().now });
    log.appendBootStep("Waiting for state file · 2s");
    log.appendBootStep("Waiting for websockify · 1s");
    expect(log.size).toBe(2);
  });

  it("does not collapse a boot tick into a non-boot entry of the same prefix", () => {
    const log = new SessionLog({ now: fakeClock().now });
    log.append("crash", "Waiting for state file · stopped responding");
    log.appendBootStep("Waiting for state file · 2s");
    expect(log.size).toBe(2);
  });

  it("keeps lifecycle markers across simulated launch → live → crash → relaunch", () => {
    const log = new SessionLog({ now: fakeClock().now });
    log.append("info", "▶ Booting");
    log.appendBootStep("Waiting · 2s");
    log.append("live", "● Live");
    log.append("crash", "⚠ Emulator stopped responding (reason: pid)");
    log.append("relaunch", "↻ Auto-relaunch (1/2)");
    log.append("info", "▶ Booting");
    log.append("live", "● Live");
    // Nothing was wiped on launch or crash — the whole timeline survives.
    expect(log.size).toBe(7);
    expect(log.toText()).toContain("⚠ Emulator stopped responding (reason: pid)");
    expect(log.toText()).toContain("↻ Auto-relaunch (1/2)");
  });

  it("caps the number of retained entries, dropping the oldest", () => {
    const log = new SessionLog({ now: fakeClock().now, cap: 3 });
    log.append("info", "a");
    log.append("info", "b");
    log.append("info", "c");
    log.append("info", "d");
    expect(log.size).toBe(3);
    const text = log.toText();
    expect(text).not.toContain("a");
    expect(text.endsWith("d")).toBe(true);
  });

  it("clear() empties the log", () => {
    const log = new SessionLog({ now: fakeClock().now });
    log.append("info", "x");
    log.clear();
    expect(log.size).toBe(0);
    expect(log.toText()).toBe("");
  });
});

describe("fmtClock", () => {
  it("renders HH:MM:SS zero-padded", () => {
    expect(fmtClock(0)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
