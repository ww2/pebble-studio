import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_HELPER_PY, LANG_HELPER_PY, deployWinHelpers } from "../../src/main/backend/winHelpers.js";

describe("INPUT_HELPER_PY pin support", () => {
  it("imports the timeline protocol messages", () => {
    expect(INPUT_HELPER_PY).toContain("WebSocketTimelinePin");
    expect(INPUT_HELPER_PY).toContain("InsertPin");
    expect(INPUT_HELPER_PY).toContain("DeletePin");
  });
  it("handles the pin and unpin verbs", () => {
    expect(INPUT_HELPER_PY).toContain("cmd == 'pin'");
    expect(INPUT_HELPER_PY).toContain("cmd == 'unpin'");
    expect(INPUT_HELPER_PY).toContain("def send_pin");
  });
  it("reports pin/unpin errors on stdout so the ack can resolve", () => {
    expect(INPUT_HELPER_PY).toContain("'screenshot', 'pin', 'unpin'");
  });
});

describe("LANG_HELPER_PY language-pack helper", () => {
  it("pushes the .pbl as a raw PutBytes File object named 'lang'", () => {
    expect(LANG_HELPER_PY).toContain("from libpebble2.services.putbytes import PutBytes, PutBytesType");
    expect(LANG_HELPER_PY).toContain('PutBytes(pebble, PutBytesType.File, data, bank=0, filename="lang").send()');
  });
  it("reads the active language from the WatchVersion handshake", () => {
    expect(LANG_HELPER_PY).toContain("from libpebble2.protocol.system import WatchVersion, WatchVersionRequest");
    expect(LANG_HELPER_PY).toContain("info.language");
    expect(LANG_HELPER_PY).toContain("language_version");
  });
  it("distinguishes the nack / connect / timeout error kinds", () => {
    expect(LANG_HELPER_PY).toContain('"nack"');
    expect(LANG_HELPER_PY).toContain('"connect"');
    expect(LANG_HELPER_PY).toContain('"timeout"');
  });
  it("bounds every socket op with an overall watchdog so it never hangs", () => {
    expect(LANG_HELPER_PY).toContain("_OVERALL_TIMEOUT");
    expect(LANG_HELPER_PY).toContain("t.join(_OVERALL_TIMEOUT)");
    expect(LANG_HELPER_PY).toContain("os._exit(1)");
  });
  it("translates argparse SystemExit into the one-JSON-line contract", () => {
    // Malformed invocations (bad --port, missing/unknown subcommand) must still
    // print exactly one JSON line and exit 1 — bare argparse would exit(2) with
    // nothing on stdout. Help is disabled so even -h/--help can't print
    // argparse's help text to stdout ahead of the JSON line.
    expect(LANG_HELPER_PY).toContain("except SystemExit:");
    expect(LANG_HELPER_PY).toContain("invalid arguments (see stderr)");
    expect(LANG_HELPER_PY).toContain("add_help=False");
  });
  it("stays backslash-free so it embeds verbatim in the TS template literal", () => {
    expect(LANG_HELPER_PY).not.toContain("\\");
  });
});

describe("deployWinHelpers", () => {
  it("writes BOTH the input helper and the language helper into the dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-helpers-"));
    const { inputHelperPath, langHelperPath } = deployWinHelpers(dir);
    expect(inputHelperPath).toBe(join(dir, "pb-input-helper.py"));
    expect(langHelperPath).toBe(join(dir, "pb-lang-helper.py"));
    expect(readFileSync(langHelperPath, "utf8")).toBe(LANG_HELPER_PY);
    expect(readFileSync(inputHelperPath, "utf8")).toBe(INPUT_HELPER_PY);
  });
});
