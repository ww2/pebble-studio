import { describe, it, expect } from "vitest";
import { FrameBudget } from "../../src/capture/gifRecorder.js";

describe("FrameBudget", () => {
  it("accepts frames up to the max and then signals stop", () => {
    const b = new FrameBudget({ fps: 10, maxSeconds: 1 }); // 10 frames max
    let accepted = 0;
    for (let i = 0; i < 15; i++) if (b.tryAdd()) accepted++;
    expect(accepted).toBe(10);
    expect(b.isFull()).toBe(true);
  });

  it("reports remaining frames", () => {
    const b = new FrameBudget({ fps: 5, maxSeconds: 2 }); // 10 max
    b.tryAdd(); b.tryAdd();
    expect(b.remaining()).toBe(8);
  });

  it("frameDelayMs derives from fps", () => {
    const b = new FrameBudget({ fps: 20, maxSeconds: 1 });
    expect(b.frameDelayMs()).toBe(50);
  });

  it("supports the raised 15s cap (15s preset completes at 15fps)", () => {
    // CaptureBar's new hard cap is 15s; a 15s @ 15fps recording must accept the
    // full 225 frames before signaling stop.
    const b = new FrameBudget({ fps: 15, maxSeconds: 15 });
    let accepted = 0;
    for (let i = 0; i < 300; i++) if (b.tryAdd()) accepted++;
    expect(accepted).toBe(225);
    expect(b.isFull()).toBe(true);
  });
});
