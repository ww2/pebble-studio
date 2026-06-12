/**
 * Pure codec for the pypkjs "phonesim" websocket AppConfig (Clay) protocol.
 *
 * ============================================================================
 * INVESTIGATION RECORD (sources read 2026-06-12, local pebble-tool install at
 * ~/.local/share/uv/tools/pebble-tool/lib/python3.13/site-packages/)
 * ============================================================================
 *
 * Transport framing
 * -----------------
 * Each websocket message is a BINARY frame whose FIRST BYTE is an endpoint
 * opcode (pypkjs/runner/websocket.py `on_message`: `opcode = message[0]`).
 * Multi-byte integers are BIG-ENDIAN (every struct format in the sources uses
 * ">"; libpebble2 PebblePacket default is also big-endian). No outer length
 * prefix — the websocket message boundary is the frame boundary.
 *
 * Relevant opcodes (libpebble2/communication/transports/websocket/protocol.py):
 *   client -> pypkjs ("to_watch"):
 *     0x0a  WebSocketPhonesimAppConfig
 *             command = Uint8()                # subcommand
 *             0x01 AppConfigSetup              # empty body -> frame is [0x0a, 0x01]
 *             0x02 AppConfigResponse           # [0x0a, 0x02, u32be byteLen, utf-8 data]
 *             0x03 AppConfigCancelled          # empty body -> frame is [0x0a, 0x03]
 *   pypkjs -> client ("from_watch"):
 *     0x0a  WebSocketPhonesimConfigResponse
 *             0x01 AppConfigURL                # [0x0a, 0x01, u32be byteLen, utf-8 url]
 *
 * Server-side handling (pypkjs/runner/websocket.py):
 *   def do_config_ws(self, ws, message):       # message = frame[1:] after opcode 0x0a
 *       if message[0] == 0x01: self.do_config(); return
 *       if self.config_callback is None: return
 *       if message[0] == 0x02:
 *           length, = struct.unpack_from(">I", message, 1)
 *           result, = struct.unpack_from(">%ds" % length, message, 5)
 *           self.config_callback(result)
 *       elif message[0] == 0x03:
 *           self.config_callback("")
 *
 *   def open_config_page(self, url, callback):
 *       self.broadcast(struct.pack('>BBI%ds' % len(url), 0x0a, 0x01,
 *                                  len(url.encode('utf-8')), url.encode('utf-8')))
 *       self.config_callback = callback
 *   QUIRK: the '%ds' field is sized by CHARACTER count while the length prefix
 *   carries the BYTE count, so a non-ASCII URL arrives truncated relative to
 *   its length field (struct.pack silently truncates). decodeConfigUrl()
 *   therefore clamps the declared length to the bytes actually present.
 *
 * Round-trip (pebble_tool/commands/emucontrol.py EmuAppConfigCommand):
 *   1. client sends WebSocketPhonesimAppConfig(AppConfigSetup())   -> [0x0a, 0x01]
 *   2. pypkjs enqueues Pebble's "showConfiguration" event in the JS runtime
 *      (runner/__init__.py do_config -> javascript/runtime.py do_config ->
 *       javascript/pebble.py _configure). The app JS calls Pebble.openURL(url),
 *      which reaches open_config_page() above -> URL frame broadcast to clients.
 *   3. The CLI opens a browser. Clay-era pages historically finish by
 *      navigating to "pebblejs://close#<urlencoded payload>"; current
 *      pebble-tool injects a return_to=http://localhost:<port>/close? param and
 *      receives the still-percent-encoded payload as the query string. Either
 *      way the payload stays PERCENT-ENCODED on the wire (the app JS does
 *      decodeURIComponent(e.response) itself).
 *   4. client sends AppConfigResponse(data=payload)  -> [0x0a, 0x02, len, data]
 *      or AppConfigCancelled (when payload is empty) -> [0x0a, 0x03]
 *   5. pypkjs fires the "webviewclosed" event with e.response = payload
 *      (javascript/pebble.py _handle_config_response).
 *
 * FRESH-CONNECTION VERDICT: YES — a config response sent on a NEW websocket
 * connection still reaches the app. `config_callback` is stored on the
 * WebsocketRunner INSTANCE (process-wide), not on the per-connection Websocket
 * object, and `do_config_ws` accepts the 0x02/0x03 response from ANY authed
 * connection; the resulting "webviewclosed" event is dispatched into the
 * long-lived JS runtime. So the two-connection design works:
 *   conn #1: send [0x0a,0x01], WAIT for the URL frame, then disconnect;
 *   conn #2 (later): send the response/cancel frame, then disconnect.
 * Constraints discovered:
 *   - The URL frame is sent via broadcast() to sockets connected AT THAT
 *     MOMENT (not queued) — conn #1 must stay open until the URL arrives.
 *   - A second Setup while a callback is pending re-fires showConfiguration
 *     and OVERWRITES config_callback; if pypkjs restarts in between, the
 *     response is silently dropped (config_callback is None).
 *   - Despite the "one client at a time" folklore, this WebsocketRunner keeps
 *     a LIST of websockets and broadcasts to all of them; concurrent clients
 *     (e.g. a running `pebble` CLI) also receive the URL frame, which is
 *     harmless for us.
 * ============================================================================
 */

/** Endpoint opcode shared by AppConfig frames in both directions. */
export const PHONESIM_CONFIG_OPCODE = 0x0a;

const SUB_SETUP = 0x01; // client->pypkjs AppConfigSetup
// SUB_URL intentionally shares 0x01 with SUB_SETUP: same byte value, opposite
// direction (pypkjs->client AppConfigURL vs client->pypkjs AppConfigSetup) —
// per the protocol notes in the header above. The direction is determined by
// which side sends the frame, not by the subcommand byte.
const SUB_URL = 0x01; // pypkjs->client AppConfigURL
const SUB_RESPONSE = 0x02; // client->pypkjs AppConfigResponse
const SUB_CANCELLED = 0x03; // client->pypkjs AppConfigCancelled

/** Request the app's config URL: triggers "showConfiguration" in the app JS. */
export function encodeConfigSetup(): Uint8Array {
  return new Uint8Array([PHONESIM_CONFIG_OPCODE, SUB_SETUP]);
}

/**
 * Decode a pypkjs->client AppConfigURL frame to its URL.
 * Returns null if the frame is not an AppConfigURL frame (different endpoint,
 * different subcommand, or too short to contain the header).
 */
export function decodeConfigUrl(frame: Uint8Array): string | null {
  if (frame.length < 6 || frame[0] !== PHONESIM_CONFIG_OPCODE || frame[1] !== SUB_URL) {
    return null;
  }
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const declared = dv.getUint32(2, false); // big-endian, per struct ">I"
  // Clamp: pypkjs may truncate non-ASCII URLs below the declared byte length
  // (see header QUIRK note).
  const end = Math.min(6 + declared, frame.length);
  return new TextDecoder().decode(frame.subarray(6, end));
}

/**
 * "webviewclosed" with the config result. `fragment` must be the RAW
 * (still percent-encoded) payload from the close URL — the app's JS calls
 * decodeURIComponent on it itself.
 */
export function encodeConfigResponse(fragment: string): Uint8Array {
  const data = new TextEncoder().encode(fragment);
  const frame = new Uint8Array(6 + data.length);
  frame[0] = PHONESIM_CONFIG_OPCODE;
  frame[1] = SUB_RESPONSE;
  new DataView(frame.buffer).setUint32(2, data.length, false); // big-endian byte length
  frame.set(data, 6);
  return frame;
}

/** "webviewclosed" for a cancelled config page (pypkjs delivers e.response = ""). */
export function encodeConfigCancelled(): Uint8Array {
  return new Uint8Array([PHONESIM_CONFIG_OPCODE, SUB_CANCELLED]);
}

/**
 * Extract and percent-decode the payload from a Clay close navigation
 * ("pebblejs://close#<data>"). Returns "" when there is no '#' or an empty
 * fragment (i.e. the user cancelled). Splits on the FIRST '#'; a literal '#'
 * inside the payload is carried as "%23". If the fragment contains a
 * malformed percent escape, the raw fragment is returned as-is.
 *
 * NOTE: this is for cancel-detection/inspection. The bytes sent back to
 * pypkjs via encodeConfigResponse() must be the RAW (still-encoded) fragment.
 */
export function parseCloseFragment(url: string): string {
  const hash = url.indexOf("#");
  if (hash === -1) return "";
  const fragment = url.slice(hash + 1);
  if (fragment === "") return "";
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
