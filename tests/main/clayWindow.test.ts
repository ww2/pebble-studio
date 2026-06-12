import { describe, it, expect } from "vitest";
import { parsePhonesimPort, extractCloseFragment } from "../../src/main/clayWindow.js";

describe("parsePhonesimPort", () => {
  const sample = JSON.stringify({
    basalt: { "4.9": { pypkjs: { port: 12345 }, qemu: { monitor: 63215 } } },
  });

  it("returns the pypkjs port for the given platform", () => {
    expect(parsePhonesimPort(sample, "basalt")).toBe(12345);
  });

  it("returns null when the platform is missing", () => {
    expect(parsePhonesimPort(sample, "aplite")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parsePhonesimPort("{not json", "basalt")).toBeNull();
    expect(parsePhonesimPort("", "basalt")).toBeNull();
  });

  it("returns null when no version entry has a pypkjs port", () => {
    const noPypkjs = JSON.stringify({
      basalt: { "4.9": { qemu: { monitor: 63215 } } },
    });
    expect(parsePhonesimPort(noPypkjs, "basalt")).toBeNull();
  });

  it("picks a version entry that has a port when multiple versions exist", () => {
    const multi = JSON.stringify({
      basalt: {
        "4.8": { qemu: { monitor: 1 } },
        "4.9": { pypkjs: { port: 54321 }, qemu: { monitor: 2 } },
      },
    });
    expect(parsePhonesimPort(multi, "basalt")).toBe(54321);
  });

  it("tolerates non-object shapes without throwing", () => {
    expect(parsePhonesimPort("null", "basalt")).toBeNull();
    expect(parsePhonesimPort('{"basalt": 7}', "basalt")).toBeNull();
    expect(parsePhonesimPort('{"basalt": {"4.9": null}}', "basalt")).toBeNull();
  });
});

describe("extractCloseFragment", () => {
  it("returns the RAW (still percent-encoded) fragment", () => {
    expect(extractCloseFragment("pebblejs://close#a%20b")).toBe("a%20b");
  });

  it("returns empty string when there is no fragment (cancel)", () => {
    expect(extractCloseFragment("pebblejs://close")).toBe("");
  });

  it("returns empty string for an empty fragment", () => {
    expect(extractCloseFragment("pebblejs://close#")).toBe("");
  });

  it("returns null for non-close URLs", () => {
    expect(extractCloseFragment("https://example.com#x")).toBeNull();
    expect(extractCloseFragment("pebblejs://other#x")).toBeNull();
    expect(extractCloseFragment("pebblejs://closer#x")).toBeNull();
    expect(extractCloseFragment("")).toBeNull();
  });

  it("handles query-string and case variants", () => {
    expect(extractCloseFragment("pebblejs://close?x=1#frag")).toBe("frag");
    expect(extractCloseFragment("PEBBLEJS://CLOSE#frag")).toBe("frag");
    expect(extractCloseFragment("pebblejs://close/#frag")).toBe("frag");
  });

  it("splits on the FIRST '#' only", () => {
    expect(extractCloseFragment("pebblejs://close#a%23b#c")).toBe("a%23b#c");
  });
});
