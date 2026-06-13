import { describe, it, expect } from "vitest";
import {
  parsePhonesimPort,
  extractCloseFragment,
  rewriteClayConfigUrl,
} from "../../src/main/clayWindow.js";

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

describe("rewriteClayConfigUrl", () => {
  /** Decode the HTML out of a `data:text/html;charset=utf-8,<enc>` URL. */
  const htmlOf = (dataUrl: string): string => {
    const prefix = "data:text/html;charset=utf-8,";
    expect(dataUrl.startsWith(prefix)).toBe(true);
    return decodeURIComponent(dataUrl.slice(prefix.length));
  };

  const clayUrl = (fragment: string): string =>
    `http://clay.pebble.com.s3-website-us-west-2.amazonaws.com/#${fragment}`;

  it("self-hosts a clay.pebble.com bootstrap URL, substituting return_to", () => {
    const html = `<!DOCTYPE html><script>window.returnTo="$$RETURN_TO$$"</script>`;
    const out = rewriteClayConfigUrl(clayUrl(encodeURIComponent(html)));
    const decoded = htmlOf(out);
    expect(decoded).toContain(`window.returnTo="pebblejs://close#"`);
    expect(decoded).not.toContain("$$RETURN_TO$$");
    expect(decoded.startsWith("<")).toBe(true);
  });

  it("decodes a base64 fragment (HTML not starting with '<')", () => {
    const html = `<html><script>window.returnTo="$$RETURN_TO$$"</script></html>`;
    const b64 = Buffer.from(html, "utf-8").toString("base64");
    const out = rewriteClayConfigUrl(clayUrl(encodeURIComponent(b64)));
    expect(htmlOf(out)).toContain(`window.returnTo="pebblejs://close#"`);
  });

  it("substitutes only the FIRST $$RETURN_TO$$ (matches the bootstrap)", () => {
    const html = `<a>$$RETURN_TO$$</a><b>$$RETURN_TO$$</b>`;
    const decoded = htmlOf(rewriteClayConfigUrl(clayUrl(encodeURIComponent(html))));
    expect(decoded).toBe(`<a>pebblejs://close#</a><b>$$RETURN_TO$$</b>`);
  });

  it("matches the plain clay.pebble.com host too (no s3 suffix)", () => {
    const html = `<x>$$RETURN_TO$$</x>`;
    const out = rewriteClayConfigUrl(`https://clay.pebble.com/#${encodeURIComponent(html)}`);
    expect(htmlOf(out)).toBe(`<x>pebblejs://close#</x>`);
  });

  it("leaves a non-clay http(s) config page unchanged", () => {
    const u = "https://example.com/config?return_to=pebblejs://close%23";
    expect(rewriteClayConfigUrl(u)).toBe(u);
  });

  it("leaves a data: URL unchanged", () => {
    const u = "data:text/html,<html>hi</html>";
    expect(rewriteClayConfigUrl(u)).toBe(u);
  });

  it("leaves a clay URL with no fragment unchanged (defensive)", () => {
    const u = "http://clay.pebble.com.s3-website-us-west-2.amazonaws.com/";
    expect(rewriteClayConfigUrl(u)).toBe(u);
    const empty = "http://clay.pebble.com.s3-website-us-west-2.amazonaws.com/#";
    expect(rewriteClayConfigUrl(empty)).toBe(empty);
  });

  it("does not treat an unrelated host as a clay bootstrap", () => {
    expect(rewriteClayConfigUrl("https://notclay.example/#x")).toBe("https://notclay.example/#x");
    expect(rewriteClayConfigUrl("https://pebble.com/#x")).toBe("https://pebble.com/#x");
  });
});
