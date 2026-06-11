import { describe, it, expect } from "vitest";
import { touchEvent } from "../../src/main/backend/qmp.js";

describe("qmp touch encoding", () => {
  it("encodes an absolute tap as a QMP input-send-event with btn down+up", () => {
    const msgs = touchEvent({ x: 90, y: 90, kind: "tap", width: 180, height: 180 });
    expect(msgs[0].execute).toBe("input-send-event");
    // absolute axes are scaled to QEMU's 0..0x7fff range
    const move = msgs[0].arguments.events.find((e: any) => e.type === "abs" && e.data.axis === "x");
    expect(move.data.value).toBe(Math.round((90 / 180) * 0x7fff));
  });

  it("a tap produces a press then a release", () => {
    const msgs = touchEvent({ x: 0, y: 0, kind: "tap", width: 144, height: 168 });
    const btnDowns = msgs.flatMap((m) => m.arguments.events).filter((e: any) => e.type === "btn" && e.data.down === true);
    const btnUps = msgs.flatMap((m) => m.arguments.events).filter((e: any) => e.type === "btn" && e.data.down === false);
    expect(btnDowns.length).toBe(1);
    expect(btnUps.length).toBe(1);
  });
});
