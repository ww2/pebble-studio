/**
 * Renderer-side client for the pypkjs "phonesim" AppConfig (Clay) round-trip.
 *
 * Two-connection design (verified against pypkjs sources — see the
 * investigation record in src/shared/clayProtocol.ts):
 *   conn #1 (fetchConfigUrl): send AppConfigSetup, then WAIT on the SAME
 *     connection for the AppConfigURL broadcast (pypkjs broadcast()s to
 *     sockets connected AT THAT MOMENT — it is not queued), then close.
 *   conn #2 (sendConfigResult): the response/cancel may go out on a FRESH
 *     connection later; pypkjs stores config_callback process-wide.
 *
 * The websocket is binary; frames are decoded/encoded by the shared codec.
 * The WebSocket constructor is injectable so vitest (node env, no browser
 * WebSocket) can drive the flow with a stub.
 */
import {
  encodeConfigSetup,
  decodeConfigUrl,
  encodeConfigResponse,
  encodeConfigCancelled,
} from "../shared/clayProtocol.js";

/** Optional dependency injection for tests. */
export interface ClayClientDeps {
  wsCtor?: typeof WebSocket;
}

/**
 * "The app has no config page" class of failure: the bridge accepted the
 * Setup but no AppConfigURL arrived (timeout) or the connection closed first
 * (e.g. the running app never calls Pebble.openURL). Distinct from transport
 * errors so the UI can show friendlier copy.
 */
export class NoConfigPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoConfigPageError";
  }
}

/**
 * "The phone bridge couldn't be reached / didn't respond" class of failure:
 * transport-level — the websocket errored, closed before the handshake
 * completed, or timed out waiting for a response. Distinct from
 * NoConfigPageError (bridge answered, but the app has no config page) so the
 * UI can ask the user to Relaunch rather than blaming the app.
 */
export class BridgeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnreachableError";
  }
}

function wsCtorFrom(deps: ClayClientDeps): typeof WebSocket {
  return deps.wsCtor ?? globalThis.WebSocket;
}

/**
 * Connect to the phonesim bridge, send AppConfigSetup, await the AppConfigURL
 * broadcast on the SAME connection, close, resolve the URL. Rejects with
 * NoConfigPageError on timeout (default 8000 ms) or close-before-URL, and a
 * plain Error on a socket error.
 */
export async function fetchConfigUrl(
  port: number,
  timeoutMs = 8000,
  deps: ClayClientDeps = {},
): Promise<string> {
  const Ctor = wsCtorFrom(deps);
  return new Promise<string>((resolve, reject) => {
    const ws = new Ctor(`ws://localhost:${port}/`);
    ws.binaryType = "arraybuffer";

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Single exit point: clear the timer + close the socket on EVERY path. */
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // closing an already-failed socket must never mask the real outcome
      }
      outcome();
    };

    timer = setTimeout(
      () => settle(() => reject(new NoConfigPageError("timed out waiting for the config URL"))),
      timeoutMs,
    );

    ws.onopen = () => {
      ws.send(encodeConfigSetup());
    };
    ws.onmessage = (ev: { data: unknown }) => {
      if (!(ev.data instanceof ArrayBuffer)) return; // bridge frames are binary
      const url = decodeConfigUrl(new Uint8Array(ev.data));
      if (url === null) return; // unrelated pebble traffic — keep waiting
      settle(() => resolve(url));
    };
    ws.onerror = () => {
      settle(() => reject(new Error("websocket error talking to the phonesim bridge")));
    };
    ws.onclose = () => {
      settle(() =>
        reject(new NoConfigPageError("connection closed before the config URL arrived")),
      );
    };
  });
}

/**
 * Connect (a FRESH connection is fine — see header) and deliver the config
 * result: AppConfigResponse carrying the RAW STILL-PERCENT-ENCODED fragment,
 * or AppConfigCancelled when the fragment is empty (user cancelled). Resolves
 * once sent; WebSocket.close() flushes already-buffered data per spec.
 *
 * Rejects with BridgeUnreachableError on timeout (default 5000 ms), socket
 * error, or close-before-open — transport failures distinct from
 * NoConfigPageError so the UI can surface the right recovery hint.
 */
export async function sendConfigResult(
  port: number,
  rawFragment: string,
  deps: ClayClientDeps = {},
  timeoutMs = 5000,
): Promise<void> {
  const Ctor = wsCtorFrom(deps);
  return new Promise<void>((resolve, reject) => {
    const ws = new Ctor(`ws://localhost:${port}/`);
    ws.binaryType = "arraybuffer";

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Single exit point: clear the timer + close the socket on EVERY path. */
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore — socket may already be closed/failed
      }
      outcome();
    };

    timer = setTimeout(
      () =>
        settle(() => reject(new BridgeUnreachableError("timed out delivering the config result"))),
      timeoutMs,
    );

    ws.onopen = () => {
      // Raw fragment goes through UNDECODED — the watch app's JS calls
      // decodeURIComponent itself (clayProtocol.ts contract).
      ws.send(rawFragment === "" ? encodeConfigCancelled() : encodeConfigResponse(rawFragment));
      settle(resolve);
    };
    ws.onerror = () => {
      settle(() =>
        reject(new BridgeUnreachableError("websocket error talking to the phonesim bridge")),
      );
    };
    ws.onclose = () => {
      settle(() =>
        reject(new BridgeUnreachableError("connection closed before the config result was sent")),
      );
    };
  });
}
