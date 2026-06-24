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
 * NoConfigPageError on timeout (default 8000 ms) or close-before-URL, and
 * BridgeUnreachableError on a socket-level error.
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
      settle(() =>
        reject(new BridgeUnreachableError("websocket error talking to the phonesim bridge")),
      );
    };
    ws.onclose = () => {
      settle(() =>
        reject(new NoConfigPageError("connection closed before the config URL arrived")),
      );
    };
  });
}

/**
 * Resilient wrapper around fetchConfigUrl for the first-boot bridge-readiness
 * race. On a fresh boot the emulator reports "Live" once VNC is up, but pypkjs's
 * phone-sim bridge takes several more seconds to bind and the foreground app's JS
 * to register its showConfiguration handler (see bridgeMonitor's startup grace).
 * During that window a single attempt fails with BridgeUnreachableError (port not
 * bound yet) or NoConfigPageError (bridge up, app not answering) — surfacing the
 * misleading "No config page" even for an app that DOES support Clay. We retry
 * both classes a few times; a genuinely config-less app simply exhausts the
 * budget and the last error surfaces unchanged (same UX as before, just delayed).
 * Any other error (e.g. a real transport fault) propagates immediately.
 */
export const CLAY_FETCH_MAX_ATTEMPTS = 3;
export const CLAY_FETCH_RETRY_MS = 600;
export const CLAY_FETCH_TIMEOUT_MS = 2800;

export interface ClayResilientDeps extends ClayClientDeps {
  sleep?: (ms: number) => Promise<void>;
}

export async function fetchConfigUrlResilient(
  port: number,
  deps: ClayResilientDeps = {},
  opts: { attempts?: number; timeoutMs?: number; retryMs?: number } = {},
): Promise<string> {
  const attempts = opts.attempts ?? CLAY_FETCH_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? CLAY_FETCH_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? CLAY_FETCH_RETRY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchConfigUrl(port, timeoutMs, deps);
    } catch (e) {
      lastErr = e;
      // Only the readiness-race classes are worth retrying; anything else is a
      // hard fault that retrying won't fix.
      if (!(e instanceof NoConfigPageError || e instanceof BridgeUnreachableError)) throw e;
      if (attempt < attempts - 1) await sleep(retryMs);
    }
  }
  throw lastErr;
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
