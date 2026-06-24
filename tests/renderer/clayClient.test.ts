import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fetchConfigUrl,
  fetchConfigUrlResilient,
  sendConfigResult,
  NoConfigPageError,
  BridgeUnreachableError,
} from "../../src/renderer/clayClient.js";

const te = new TextEncoder();

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** pypkjs -> client AppConfigURL frame: [0x0a, 0x01, u32be byteLen, utf-8 url]. */
function urlFrame(url: string): Uint8Array {
  const bytes = te.encode(url);
  return new Uint8Array([0x0a, 0x01, ...u32be(bytes.length), ...bytes]);
}

/**
 * Event-emitting WebSocket stub. vitest runs in the node environment (no real
 * browser WebSocket), so the clay client takes an injectable constructor.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // -- test helpers ---------------------------------------------------------
  open(): void {
    this.onopen?.();
  }

  /** Deliver a binary message the way the browser does (ArrayBuffer data). */
  message(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.onmessage?.({ data: buf });
  }

  emitError(): void {
    this.onerror?.();
  }

  emitClose(): void {
    this.onclose?.();
  }
}

const deps = { wsCtor: FakeWebSocket as unknown as typeof WebSocket };

afterEach(() => {
  FakeWebSocket.reset();
  vi.useRealTimers();
});

describe("fetchConfigUrl", () => {
  it("sends Setup on open and resolves with the URL from an AppConfigURL frame", async () => {
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:9000/");
    expect(ws.binaryType).toBe("arraybuffer");

    ws.open();
    // AppConfigSetup goes out on the SAME connection that awaits the URL.
    expect(ws.sent.map((f) => Array.from(f))).toEqual([[0x0a, 0x01]]);

    ws.message(urlFrame("data:text/html;base64,PGh0bWw+"));
    await expect(p).resolves.toBe("data:text/html;base64,PGh0bWw+");
    expect(ws.closed).toBe(true);
  });

  it("ignores non-config frames (the bridge relays unrelated pebble traffic)", async () => {
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.message(new Uint8Array([0x02, 0x68, 0x69])); // app-log endpoint
    ws.message(new Uint8Array([0x0a, 0x02, 0, 0, 0, 0])); // config endpoint, non-URL sub
    ws.message(new Uint8Array([0x05])); // random short frame
    expect(ws.closed).toBe(false);

    ws.message(urlFrame("http://localhost:1/config"));
    await expect(p).resolves.toBe("http://localhost:1/config");
    expect(ws.closed).toBe(true);
  });

  it("ignores non-binary (string) messages", async () => {
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.onmessage?.({ data: "not binary" });
    expect(ws.closed).toBe(false);
    ws.message(urlFrame("http://x/"));
    await expect(p).resolves.toBe("http://x/");
  });

  it("rejects with NoConfigPageError on timeout and closes the socket", async () => {
    vi.useFakeTimers();
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const assertion = expect(p).rejects.toBeInstanceOf(NoConfigPageError);
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(ws.closed).toBe(true);
  });

  it("respects a custom timeout", async () => {
    vi.useFakeTimers();
    const p = fetchConfigUrl(9000, 100, deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const assertion = expect(p).rejects.toBeInstanceOf(NoConfigPageError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(ws.closed).toBe(true);
  });

  it("rejects with NoConfigPageError when the socket closes before the URL arrives", async () => {
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.emitClose();
    await expect(p).rejects.toBeInstanceOf(NoConfigPageError);
  });

  it("rejects with BridgeUnreachableError on a socket error", async () => {
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    ws.emitError();
    await expect(p).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(ws.closed).toBe(true);
  });

  it("does not double-settle when the timer would fire after a resolve", async () => {
    vi.useFakeTimers();
    const p = fetchConfigUrl(9000, 8000, deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(urlFrame("http://x/"));
    await expect(p).resolves.toBe("http://x/");
    // Timer must have been cleared — advancing past the deadline is a no-op.
    await vi.advanceTimersByTimeAsync(10000);
    ws.emitClose(); // late close after settle is also ignored
  });
});

describe("fetchConfigUrlResilient — first-boot bridge-readiness retry", () => {
  // Real timers (injected no-op sleep means no real delay); flush lets the
  // post-rejection microtasks run so the next attempt's socket is constructed.
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("retries past a first-boot close/NoConfigPage, then resolves once the app answers", async () => {
    const sleep = vi.fn(async () => {});
    const p = fetchConfigUrlResilient(9000, { ...deps, sleep }, { attempts: 3, retryMs: 5 });
    // Attempt 1: connects but closes before any URL (bridge/app still settling).
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].emitClose();
    await flush();
    // Attempt 2: same.
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].emitClose();
    await flush();
    // Attempt 3: the app's JS is now up and answers with the config URL.
    FakeWebSocket.instances[2].open();
    FakeWebSocket.instances[2].message(urlFrame("http://cfg/"));
    await expect(p).resolves.toBe("http://cfg/");
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2); // one delay between each attempt
  });

  it("gives up with the last error after exhausting attempts (a genuinely config-less app)", async () => {
    const sleep = vi.fn(async () => {});
    const p = fetchConfigUrlResilient(9000, { ...deps, sleep }, { attempts: 2, retryMs: 5 });
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].emitClose();
    await flush();
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].emitClose();
    await expect(p).rejects.toBeInstanceOf(NoConfigPageError);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("also retries the port-not-bound race (BridgeUnreachableError), not just NoConfigPage", async () => {
    const sleep = vi.fn(async () => {});
    const p = fetchConfigUrlResilient(9000, { ...deps, sleep }, { attempts: 3, retryMs: 5 });
    // Attempts 1-2: the pypkjs port isn't bound yet → socket error.
    FakeWebSocket.instances[0].emitError();
    await flush();
    FakeWebSocket.instances[1].emitError();
    await flush();
    // Attempt 3: bridge is up and the app answers.
    FakeWebSocket.instances[2].open();
    FakeWebSocket.instances[2].message(urlFrame("http://cfg/"));
    await expect(p).resolves.toBe("http://cfg/");
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("sendConfigResult", () => {
  it("sends an AppConfigResponse with the RAW still-percent-encoded fragment, then closes", async () => {
    const fragment = "%7B%22a%22%3A1%7D";
    const p = sendConfigResult(9000, fragment, deps);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:9000/");
    ws.open();
    await p;
    expect(ws.sent).toHaveLength(1);
    expect(Array.from(ws.sent[0])).toEqual([
      0x0a,
      0x02,
      ...u32be(fragment.length),
      ...Array.from(te.encode(fragment)),
    ]);
    expect(ws.closed).toBe(true);
  });

  it("sends AppConfigCancelled for an empty fragment, then closes", async () => {
    const p = sendConfigResult(9000, "", deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    await p;
    expect(ws.sent.map((f) => Array.from(f))).toEqual([[0x0a, 0x03]]);
    expect(ws.closed).toBe(true);
  });

  it("rejects with BridgeUnreachableError on a socket error before open", async () => {
    const p = sendConfigResult(9000, "x", deps);
    const ws = FakeWebSocket.instances[0];
    ws.emitError();
    await expect(p).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(ws.closed).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it("rejects with BridgeUnreachableError when the socket closes before the result was sent", async () => {
    const p = sendConfigResult(9000, "x", deps);
    const ws = FakeWebSocket.instances[0];
    ws.emitClose();
    await expect(p).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(ws.sent).toHaveLength(0);
  });

  it("rejects with BridgeUnreachableError on timeout (ws never opens)", async () => {
    vi.useFakeTimers();
    const p = sendConfigResult(9000, "x", deps, 50);
    const ws = FakeWebSocket.instances[0];
    const assertion = expect(p).rejects.toBeInstanceOf(BridgeUnreachableError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(ws.closed).toBe(true);
    expect(ws.sent).toHaveLength(0);
  });

  it("clears the timeout and does not double-settle after a successful send", async () => {
    vi.useFakeTimers();
    const p = sendConfigResult(9000, "ok", deps, 5000);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    await expect(p).resolves.toBeUndefined();
    // Advancing past the original deadline must be a no-op (timer was cleared).
    await vi.advanceTimersByTimeAsync(10000);
    ws.emitClose(); // late close after settle is also ignored
  });

  it("does not reject after a successful send when the socket later closes", async () => {
    const p = sendConfigResult(9000, "ok", deps);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    await expect(p).resolves.toBeUndefined();
    // settled flag prevents late onclose from re-rejecting
    ws.emitClose();
  });
});

describe("BridgeUnreachableError", () => {
  it("is exported and extends Error", () => {
    const err = new BridgeUnreachableError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BridgeUnreachableError);
    expect(err.name).toBe("BridgeUnreachableError");
    expect(err.message).toBe("test");
  });

  it("is distinct from NoConfigPageError", () => {
    expect(new BridgeUnreachableError("x")).not.toBeInstanceOf(NoConfigPageError);
    expect(new NoConfigPageError("x")).not.toBeInstanceOf(BridgeUnreachableError);
  });
});
