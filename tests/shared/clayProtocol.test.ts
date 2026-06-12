import { describe, it, expect } from "vitest";
import {
  encodeConfigSetup,
  decodeConfigUrl,
  encodeConfigResponse,
  encodeConfigCancelled,
  parseCloseFragment,
} from "../../src/shared/clayProtocol.js";

// Byte-layout evidence, from the local pebble-tool installation
// (~/.local/share/uv/tools/pebble-tool/lib/python3.13/site-packages/):
//
// libpebble2/communication/transports/websocket/protocol.py:
//   class WebSocketPhonesimAppConfig(PebblePacket):   # client -> pypkjs, endpoint 0x0a
//       command = Uint8()
//       config = Union(command, {
//           0x01: AppConfigSetup,        # (empty body)
//           0x02: AppConfigResponse,     # length = Uint32(); data = FixedString(length=length)
//           0x03: AppConfigCancelled,    # (empty body)
//       })
//   to_watch = { ... 0x0a: WebSocketPhonesimAppConfig ... }
//   (libpebble2 PebblePacket serialization is big-endian by default.)
//
// pypkjs/runner/websocket.py (server side, confirms the same bytes):
//   def do_config_ws(self, ws, message):              # message = frame[1:] after opcode 0x0a
//       if message[0] == 0x01: self.do_config(); return
//       ...
//       if message[0] == 0x02:
//           length, = struct.unpack_from(">I", message, 1)
//           result, = struct.unpack_from(">%ds" % length, message, 5)
//           self.config_callback(result)
//       elif message[0] == 0x03:
//           self.config_callback("")
//
//   def open_config_page(self, url, callback):        # pypkjs -> client URL frame
//       self.broadcast(struct.pack('>BBI%ds' % len(url), 0x0a, 0x01,
//                                  len(url.encode('utf-8')), url.encode('utf-8')))

const te = new TextEncoder();

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

describe("encodeConfigSetup", () => {
  it("is exactly [0x0a, 0x01] (opcode + AppConfigSetup, empty body)", () => {
    // pebble_tool/commands/emucontrol.py:
    //   self.pebble.transport.send_packet(WebSocketPhonesimAppConfig(config=AppConfigSetup()), ...)
    expect(Array.from(encodeConfigSetup())).toEqual([0x0a, 0x01]);
  });
});

describe("encodeConfigCancelled", () => {
  it("is exactly [0x0a, 0x03] (opcode + AppConfigCancelled, empty body)", () => {
    // pebble_tool/commands/emucontrol.py handle_config_close:
    //   if query == '': ...send_packet(WebSocketPhonesimAppConfig(config=AppConfigCancelled()), ...)
    expect(Array.from(encodeConfigCancelled())).toEqual([0x0a, 0x03]);
  });
});

describe("encodeConfigResponse", () => {
  it("frames as 0x0a 0x02 <u32be byte-length> <utf-8 data>", () => {
    // pypkjs do_config_ws: length, = struct.unpack_from(">I", message, 1)
    //                      result, = struct.unpack_from(">%ds" % length, message, 5)
    const fragment = "%7B%22a%22%3A1%7D"; // Clay sends the still-percent-encoded payload
    const frame = encodeConfigResponse(fragment);
    expect(Array.from(frame)).toEqual([
      0x0a, 0x02, ...u32be(fragment.length), ...Array.from(te.encode(fragment)),
    ]);
  });

  it("uses the utf-8 BYTE length, not the character count", () => {
    const fragment = "café"; // 4 chars, 5 utf-8 bytes
    const frame = encodeConfigResponse(fragment);
    expect(Array.from(frame.subarray(0, 6))).toEqual([0x0a, 0x02, ...u32be(5)]);
    expect(Array.from(frame.subarray(6))).toEqual(Array.from(te.encode(fragment)));
  });

  it("handles an empty fragment (length 0)", () => {
    expect(Array.from(encodeConfigResponse(""))).toEqual([0x0a, 0x02, 0, 0, 0, 0]);
  });
});

describe("decodeConfigUrl", () => {
  // Hand-built frame mirroring pypkjs open_config_page:
  //   struct.pack('>BBI%ds' % len(url), 0x0a, 0x01, len(url.encode('utf-8')), url.encode('utf-8'))
  function urlFrame(url: string): Uint8Array {
    const bytes = te.encode(url);
    return new Uint8Array([0x0a, 0x01, ...u32be(bytes.length), ...bytes]);
  }

  it("decodes the AppConfigURL frame", () => {
    const url = "data:text/html;base64,PGh0bWw+";
    expect(decodeConfigUrl(urlFrame(url))).toBe(url);
  });

  it("round-trips a long Clay data: URL", () => {
    const url = "data:text/html;charset=utf-8," + "x".repeat(70000); // length > 0xffff exercises u32
    expect(decodeConfigUrl(urlFrame(url))).toBe(url);
  });

  it("returns null for a different endpoint opcode", () => {
    // 0x02 = WebSocketPhoneAppLog, not a config frame
    expect(decodeConfigUrl(new Uint8Array([0x02, 0x68, 0x69]))).toBeNull();
  });

  it("returns null for a config frame with a non-URL subcommand", () => {
    // WebSocketPhonesimConfigResponse only defines subcommand 0x01: AppConfigURL
    expect(decodeConfigUrl(new Uint8Array([0x0a, 0x02, 0, 0, 0, 0]))).toBeNull();
  });

  it("returns null for truncated frames", () => {
    expect(decodeConfigUrl(new Uint8Array([]))).toBeNull();
    expect(decodeConfigUrl(new Uint8Array([0x0a]))).toBeNull();
    expect(decodeConfigUrl(new Uint8Array([0x0a, 0x01, 0, 0]))).toBeNull(); // header cut short
  });

  it("clamps when the length field exceeds the actual payload", () => {
    // pypkjs quirk: struct.pack('>BBI%ds' % len(url), ...) sizes the field by CHARACTER
    // count but writes the BYTE count into the length prefix, so a non-ASCII URL arrives
    // truncated relative to its length field. Decode what is actually present.
    const bytes = te.encode("http://x");
    const frame = new Uint8Array([0x0a, 0x01, ...u32be(bytes.length + 4), ...bytes]);
    expect(decodeConfigUrl(frame)).toBe("http://x");
  });
});

describe("parseCloseFragment", () => {
  it("decodes a percent-encoded Clay payload", () => {
    expect(parseCloseFragment("pebblejs://close#%7B%22color%22%3A%22%23FF0000%22%7D"))
      .toBe('{"color":"#FF0000"}');
  });

  it("returns '' for a plain pebblejs://close (cancel)", () => {
    expect(parseCloseFragment("pebblejs://close")).toBe("");
  });

  it("returns '' for an empty fragment", () => {
    expect(parseCloseFragment("pebblejs://close#")).toBe("");
  });

  it("returns '' for URLs with no '#' at all", () => {
    expect(parseCloseFragment("http://localhost:1234/whatever?a=b")).toBe("");
  });

  it("passes through fragments that need no decoding", () => {
    expect(parseCloseFragment("pebblejs://close#plain")).toBe("plain");
  });

  it("only splits on the FIRST '#' (payload may contain encoded '#' -> '%23')", () => {
    expect(parseCloseFragment("pebblejs://close#a%23b")).toBe("a#b");
  });

  it("returns the raw fragment when percent-decoding fails (malformed escape)", () => {
    expect(parseCloseFragment("pebblejs://close#100%")).toBe("100%");
  });
});

describe("setup/response round-trip against the pypkjs parser layout", () => {
  it("response frame fields land where do_config_ws reads them", () => {
    const fragment = "ready=1&theme=dark";
    const frame = encodeConfigResponse(fragment);
    // Server side: opcode = message[0]; handler gets message[1:]
    expect(frame[0]).toBe(0x0a);
    const message = frame.subarray(1);
    expect(message[0]).toBe(0x02);
    // length, = struct.unpack_from(">I", message, 1)
    const dv = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const length = dv.getUint32(1, false);
    // result, = struct.unpack_from(">%ds" % length, message, 5)
    const result = new TextDecoder().decode(message.subarray(5, 5 + length));
    expect(result).toBe(fragment);
    expect(message.byteLength).toBe(5 + length); // no trailing garbage
  });
});
