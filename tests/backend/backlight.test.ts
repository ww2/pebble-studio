import { describe, it, expect } from "vitest";
import { parseMonitorPort } from "../../src/main/backend/backlight.js";

/**
 * parseMonitorPort is the pure helper behind the backlight keepalive: it extracts
 * the qemu HMP `monitor` port from the /tmp/pb-emulator.json text so the keepalive
 * can open a TCP socket and send a Back press. It must be robust to a missing or
 * malformed file (return null, never throw).
 */
describe("parseMonitorPort", () => {
  // The real emulator state-file shape (from a live /tmp/pb-emulator.json).
  const realJson = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 635689, port: 57419, serial: 55005, gdb: 43673, monitor: 54685, vnc: true },
        pypkjs: { pid: 635727, port: 54737 },
        version: "4.9.169",
        websockify: { pid: 635751 },
      },
    },
  });

  it("returns the monitor port from a valid state file", () => {
    expect(parseMonitorPort(realJson)).toBe(54685);
  });

  it("returns the first live monitor port across platforms/versions", () => {
    const json = JSON.stringify({
      basalt: { "4.9": { qemu: { pid: 1, monitor: 12000 } } },
    });
    expect(parseMonitorPort(json)).toBe(12000);
  });

  it("returns null when there is no qemu.monitor entry", () => {
    const json = JSON.stringify({ basalt: { "4.9": { qemu: { pid: 1 } } } });
    expect(parseMonitorPort(json)).toBeNull();
  });

  it("returns null for an empty / missing file", () => {
    expect(parseMonitorPort("")).toBeNull();
  });

  it("returns null for malformed (partial-write) json", () => {
    expect(parseMonitorPort('{ "emery": { "4.9.169": { "qemu": {')).toBeNull();
  });

  it("ignores a non-numeric monitor value", () => {
    const json = JSON.stringify({ basalt: { "4.9": { qemu: { monitor: "nope" } } } });
    expect(parseMonitorPort(json)).toBeNull();
  });
});
