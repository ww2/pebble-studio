import { describe, it, expect } from "vitest";
import {
  parseBridgePids,
  buildHealthCommand,
  interpretHealth,
} from "../../src/main/backend/bridgeHealth.js";

// ---------------------------------------------------------------------------
// parseBridgePids
// ---------------------------------------------------------------------------

describe("parseBridgePids", () => {
  // Real shape from /tmp/pb-emulator.json sample.
  const sample = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 1854238, port: 51113, monitor: 42553, vnc: true },
        pypkjs: { pid: 1854276, port: 57749 },
        websockify: { pid: 1854300 },
      },
    },
  });

  it("returns all three numbers from a valid sample", () => {
    expect(parseBridgePids(sample, "emery")).toEqual({
      qemuPid: 1854238,
      pypkjsPid: 1854276,
      pypkjsPort: 57749,
    });
  });

  it("returns null when the platform is missing", () => {
    expect(parseBridgePids(sample, "basalt")).toBeNull();
  });

  it("returns null when qemu.pid is missing", () => {
    const noQemuPid = JSON.stringify({
      emery: {
        "4.9.169": {
          qemu: { port: 51113, monitor: 42553 },
          pypkjs: { pid: 1854276, port: 57749 },
        },
      },
    });
    expect(parseBridgePids(noQemuPid, "emery")).toBeNull();
  });

  it("returns null when pypkjs.pid is missing", () => {
    const noPypkjsPid = JSON.stringify({
      emery: {
        "4.9.169": {
          qemu: { pid: 1854238, port: 51113, monitor: 42553 },
          pypkjs: { port: 57749 },
        },
      },
    });
    expect(parseBridgePids(noPypkjsPid, "emery")).toBeNull();
  });

  it("returns null when pypkjs.port is missing", () => {
    const noPypkjsPort = JSON.stringify({
      emery: {
        "4.9.169": {
          qemu: { pid: 1854238, port: 51113, monitor: 42553 },
          pypkjs: { pid: 1854276 },
        },
      },
    });
    expect(parseBridgePids(noPypkjsPort, "emery")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseBridgePids("{not json", "emery")).toBeNull();
    expect(parseBridgePids("", "emery")).toBeNull();
  });

  it("tolerates non-object shapes without throwing", () => {
    expect(parseBridgePids("null", "emery")).toBeNull();
    expect(parseBridgePids('{"emery": 7}', "emery")).toBeNull();
    expect(parseBridgePids('{"emery": {"4.9": null}}', "emery")).toBeNull();
    expect(parseBridgePids('{"emery": {"4.9": {"qemu": null, "pypkjs": null}}}', "emery")).toBeNull();
  });

  it("picks the version entry that has all three values when multiple versions exist", () => {
    const multi = JSON.stringify({
      emery: {
        // This version is missing pypkjs.port — should be skipped.
        "4.8.0": {
          qemu: { pid: 111 },
          pypkjs: { pid: 222 },
        },
        // This version has all three — should be returned.
        "4.9.169": {
          qemu: { pid: 1854238 },
          pypkjs: { pid: 1854276, port: 57749 },
        },
      },
    });
    expect(parseBridgePids(multi, "emery")).toEqual({
      qemuPid: 1854238,
      pypkjsPid: 1854276,
      pypkjsPort: 57749,
    });
  });
});

// ---------------------------------------------------------------------------
// buildHealthCommand
// ---------------------------------------------------------------------------

describe("buildHealthCommand", () => {
  const pids = { qemuPid: 1854238, pypkjsPid: 1854276, pypkjsPort: 57749 };

  it("contains the qemu PID", () => {
    expect(buildHealthCommand(pids)).toContain("1854238");
  });

  it("contains the pypkjs PID", () => {
    expect(buildHealthCommand(pids)).toContain("1854276");
  });

  it("contains the pypkjs port", () => {
    expect(buildHealthCommand(pids)).toContain("57749");
  });

  // CRITICAL: the command is run via a Shell that on Windows re-wraps it as
  // `wsl.exe -- bash -lc "'bash' '-lc' '<cmd>'"`. Any quote inside the command
  // string is mangled across the two shell hops and silently breaks only on the
  // real .exe. (Same constraint as setTzOffsetCmd in pebbleCli.ts.)
  it("contains NO single-quote characters (survives the Windows→wsl.exe→bash hops)", () => {
    expect(buildHealthCommand(pids)).not.toContain("'");
  });

  it("contains NO double-quote characters (survives the Windows→wsl.exe→bash hops)", () => {
    expect(buildHealthCommand(pids)).not.toContain('"');
  });

  // Structural assertions: a gutted command body must not pass these.
  it("reads qemu process state from /proc/<qemuPid>/status", () => {
    expect(buildHealthCommand(pids)).toContain("/proc/1854238/status");
  });

  it("reads pypkjs process state from /proc/<pypkjsPid>/status", () => {
    expect(buildHealthCommand(pids)).toContain("/proc/1854276/status");
  });

  it("probes TCP via /dev/tcp/localhost/<pypkjsPort>", () => {
    expect(buildHealthCommand(pids)).toContain("/dev/tcp/localhost/57749");
  });

  it("emits echo OK on success", () => {
    expect(buildHealthCommand(pids)).toContain("echo OK");
  });

  it("emits echo DEAD on failure paths", () => {
    expect(buildHealthCommand(pids)).toContain("echo DEAD");
  });
});

// ---------------------------------------------------------------------------
// interpretHealth
// ---------------------------------------------------------------------------

describe("interpretHealth", () => {
  it("maps OK to alive=true, kind=ok", () => {
    expect(interpretHealth("OK", 0)).toEqual({ alive: true, kind: "ok" });
  });

  it("maps DEAD pid to alive=false, kind=pid", () => {
    expect(interpretHealth("DEAD pid", 1)).toEqual({ alive: false, kind: "pid" });
  });

  it("maps DEAD port to alive=false, kind=port", () => {
    expect(interpretHealth("DEAD port", 1)).toEqual({ alive: false, kind: "port" });
  });

  it("maps empty stdout to alive=false, kind=port (conservative fallback)", () => {
    expect(interpretHealth("", 0)).toEqual({ alive: false, kind: "port" });
  });

  it("maps garbage stdout to alive=false, kind=port (conservative fallback)", () => {
    expect(interpretHealth("unexpected error 42", 1)).toEqual({ alive: false, kind: "port" });
    expect(interpretHealth("bash: /proc/1/status: No such file", 1)).toEqual({ alive: false, kind: "port" });
  });

  it("tolerates surrounding whitespace and newlines", () => {
    expect(interpretHealth("  OK\n", 0)).toEqual({ alive: true, kind: "ok" });
    expect(interpretHealth("\nDEAD pid\n", 1)).toEqual({ alive: false, kind: "pid" });
    expect(interpretHealth("  DEAD port  ", 1)).toEqual({ alive: false, kind: "port" });
  });

  it("is case-insensitive", () => {
    expect(interpretHealth("ok", 0)).toEqual({ alive: true, kind: "ok" });
    expect(interpretHealth("dead pid", 1)).toEqual({ alive: false, kind: "pid" });
    expect(interpretHealth("DEAD PORT", 1)).toEqual({ alive: false, kind: "port" });
  });
});
