/**
 * winHelpers.ts — deploy the persistent input helper (pb-input-helper.py) the
 * windows-native driver runs with the bundled interpreter. Written to disk under
 * a per-user dir at startup so the driver can invoke it by absolute path.
 *
 * (No tz/time helper here: custom time over the watch protocol can't work on the
 * native track — pypkjs is single-client and emu-control holds the watch
 * connection, so the SetUTC handshake times out. The input helper only sends
 * qemu-relay packets, which need no watch handshake, so it works.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persistent input helper: connects ONCE to the running emulator's pypkjs
 * websocket (port = argv[1]) and turns one-line stdin commands into the same
 * QemuButton/QemuTap relay packets `pebble emu-button`/`emu-tap` send. Holding
 * the connection open is what removes the per-press process-spawn latency.
 *
 * It ALSO handles `screenshot <out_path>`: a BACKLIGHT-FREE framebuffer grab
 * over the watch protocol (libpebble2 Screenshot service, endpoint 8000 — bright
 * regardless of the LCD backlight). This is layered on the SAME websocket the
 * input relay uses: a libpebble2 PebbleConnection is wrapped around the existing
 * transport LAZILY (only on the first screenshot), so the latency-critical
 * button/tap path is never altered — button sends remain raw WebSocketRelayQemu
 * writes exactly as before. The grab runs under a watchdog so a hung framebuffer
 * read can't wedge the helper.
 *
 * NOTE: the framebuffer screenshot path is UNVERIFIED LIVE (the emulator was
 * closed when this was authored) — pypkjs is single-client, so wrapping the
 * relay socket in a PebbleConnection read loop is the one piece that needs a real
 * watch to confirm. Every failure mode prints `ERR ...`; the renderer falls back
 * to the existing VNC-canvas + backlight screenshot, so a failure here is benign.
 */
export const INPUT_HELPER_PY = `import sys, time, threading, json, uuid
from libpebble2.communication.transports.websocket import WebsocketTransport, MessageTargetPhone
from libpebble2.communication.transports.websocket.protocol import WebSocketRelayQemu, WebSocketTimelinePin, InsertPin, DeletePin
from libpebble2.communication.transports.qemu.protocol import QemuPacket, QemuButton, QemuTap

_SUNLIGHT_LUT = {
    (0,0,0):(0,0,0),(0,0,85):(0,30,65),(0,0,170):(0,67,135),(0,0,255):(0,104,202),
    (0,85,0):(43,74,44),(0,85,85):(39,81,79),(0,85,170):(22,99,141),(0,85,255):(0,125,206),
    (0,170,0):(94,152,96),(0,170,85):(92,155,114),(0,170,170):(87,165,162),(0,170,255):(76,180,219),
    (0,255,0):(142,227,145),(0,255,85):(142,230,158),(0,255,170):(138,235,192),(0,255,255):(132,245,241),
    (85,0,0):(74,22,27),(85,0,85):(72,39,72),(85,0,170):(64,72,138),(85,0,255):(47,107,204),
    (85,85,0):(86,78,54),(85,85,85):(84,84,84),(85,85,170):(79,103,144),(85,85,255):(65,128,208),
    (85,170,0):(117,154,100),(85,170,85):(117,157,118),(85,170,170):(113,166,164),(85,170,255):(105,181,221),
    (85,255,0):(158,229,148),(85,255,85):(157,231,160),(85,255,170):(155,236,194),(85,255,255):(149,246,242),
    (170,0,0):(153,53,63),(170,0,85):(152,62,90),(170,0,170):(149,86,148),(170,0,255):(143,116,210),
    (170,85,0):(157,91,77),(170,85,85):(157,96,100),(170,85,170):(154,112,153),(170,85,255):(149,135,213),
    (170,170,0):(175,160,114),(170,170,85):(174,163,130),(170,170,170):(171,171,171),(170,170,255):(167,186,226),
    (170,255,0):(201,232,157),(170,255,85):(201,234,167),(170,255,170):(199,240,200),(170,255,255):(195,249,247),
    (255,0,0):(227,84,98),(255,0,85):(226,88,116),(255,0,170):(225,106,163),(255,0,255):(222,131,220),
    (255,85,0):(230,110,107),(255,85,85):(230,114,124),(255,85,170):(227,127,167),(255,85,255):(225,148,223),
    (255,170,0):(241,170,134),(255,170,85):(241,173,147),(255,170,170):(239,181,184),(255,170,255):(236,195,235),
    (255,255,0):(255,238,171),(255,255,85):(255,241,181),(255,255,170):(255,246,211),(255,255,255):(255,255,255),
}
_SUNLIGHT_SNAP = [(0,85,170,255)[min(3,(v+42)//85)] for v in range(256)]

# Lazy framebuffer-screenshot state. The PebbleConnection that drives the
# libpebble2 Screenshot service is built once, on the first 'screenshot' command,
# wrapping the SAME transport the button relay already uses. None until then so
# the pure-input path pays nothing.
_pebble = None
_pebble_lock = threading.Lock()
# stdout is shared by ack writes (stdin-loop thread) and app-log lines (the
# PebbleConnection dispatch thread), so serialize whole-line writes.
_stdout_lock = threading.Lock()
_logs_started = False
# We only SEND on this websocket (button/tap/pin relays), but pypkjs BROADCASTS
# everything to every client: the watchface's constant traffic AND, on each Clay
# gear open, a ~98KB AppConfigURL frame. If nobody reads our socket, those frames
# back up until pypkjs's server-side send blocks — which freezes its single JS
# runtime greenlet, so showConfiguration stops firing and Clay dies with
# "No config page" after a couple of opens. So a background thread continuously
# drains (reads + discards) the socket. When a framebuffer screenshot needs the
# libpebble2 read loop, we hand the socket over (two readers would corrupt it).
_drain_stop = threading.Event()


def _drain_loop(transport):
    while not _drain_stop.is_set():
        try:
            transport.read_packet()  # consume + discard one inbound frame
        except Exception:
            # WebSocketTimeoutException (idle, expected) -> keep draining;
            # a real close -> exit so we don't spin. NOTE: 'connected' is a
            # @property — calling it crashed this thread with a TypeError on
            # the FIRST idle timeout (shipped in v3.0.3..v3.0.5), silently
            # disabling the drain that keeps pypkjs broadcasts from backing
            # up on our socket (the Clay "No config page" wedge protection).
            if not transport.connected:
                return


def _start_drain(transport):
    _drain_stop.clear()
    try:
        transport.ws.settimeout(0.5)  # so read_packet returns ~0.5s when idle
    except Exception:
        pass
    t = threading.Thread(target=_drain_loop, args=(transport,))
    t.daemon = True
    t.start()


def _get_pebble(transport):
    # Build (once) and return a connected PebbleConnection over the live relay
    # socket. run_async() spawns the read loop + fetch_watch_info() handshake the
    # Screenshot service needs. Raises on failure — caller turns it into 'ERR'.
    global _pebble
    with _pebble_lock:
        if _pebble is None:
            # Stop the raw drain and let it exit (recv timeout is 0.5s) so the
            # PebbleConnection read loop is the SOLE reader of this socket.
            _drain_stop.set()
            time.sleep(0.7)
            try:
                transport.ws.settimeout(None)  # blocking reads for the real reader
            except Exception:
                pass
            try:
                from libpebble2.communication import PebbleConnection
                p = PebbleConnection(transport)
                p.run_async()  # background read loop; also fetches watch info
                _pebble = p
            except Exception:
                # Screenshot reader failed to start — resume draining so the
                # socket keeps being emptied, then report the failure upward.
                _start_drain(transport)
                raise
        return _pebble


def _emit(s):
    with _stdout_lock:
        sys.stdout.write(s + '\\n')
        sys.stdout.flush()


def _one_line(s):
    return ' | '.join(str(s).splitlines())


def _start_app_logs(transport):
    # Stream watch APP_LOG + pkjs console output as 'LOG ...' stdout lines, over
    # the SAME PebbleConnection the screenshot path uses — so app logs cost no
    # extra pypkjs client (the bridge only accepts a couple). Triggered by the
    # 'logs' stdin command, which the app sends at Live, so the run_async
    # handshake finds a booted watch; short retries cover a still-settling
    # bridge. Failure only disables the log stream (input/screenshot unaffected).
    from libpebble2.protocol.logs import AppLogMessage, AppLogShippingControl
    from libpebble2.communication.transports.websocket.protocol import WebSocketPhoneAppLog
    global _logs_started
    pebble = None
    err = 'unknown'
    for _ in range(5):
        try:
            pebble = _get_pebble(transport)
            break
        except Exception as e:
            err = e
            time.sleep(2.0)
    if pebble is None:
        sys.stderr.write('app-log: bridge unavailable (%s)\\n' % err)
        sys.stderr.flush()
        # Clear the latch so a later 'logs' re-arm (panel re-open, or a reboot's
        # fresh helper) retries instead of being swallowed as a no-op by _ensure_logs.
        _logs_started = False
        return

    def on_watch(packet):
        _emit('LOG [%s] %s:%s> %s' % (time.strftime('%H:%M:%S'),
              packet.filename, packet.line_number, _one_line(packet.message)))

    def on_phone(packet):
        try:
            text = packet.payload.decode('utf-8', 'replace')
        except Exception:
            text = str(packet.payload)
        _emit('LOG [%s] pkjs> %s' % (time.strftime('%H:%M:%S'), _one_line(text)))

    try:
        pebble.register_endpoint(AppLogMessage, on_watch)
        pebble.register_transport_endpoint(MessageTargetPhone, WebSocketPhoneAppLog, on_phone)
        pebble.send_packet(AppLogShippingControl(enable=True))
    except Exception as e:
        sys.stderr.write('app-log: failed to start stream (%s)\\n' % e)
        sys.stderr.flush()
        _logs_started = False  # let a later re-arm retry
        return
    # Positive signal for the UI panel (and live tests) that the stream is up.
    _emit('LOG [%s] (app log stream connected)' % time.strftime('%H:%M:%S'))


def _ensure_logs(transport):
    global _logs_started
    if _logs_started:
        return
    _logs_started = True
    t = threading.Thread(target=_start_app_logs, args=(transport,))
    t.daemon = True
    t.start()


def _grab_png(transport, out_path):
    # Framebuffer grab → PNG with Pebble sunlight colour correction (matches
    # pebble-tool's _correct_colours; only invoked when the UI toggle is on).
    from libpebble2.services.screenshot import Screenshot
    import png
    pebble = _get_pebble(transport)
    rows = Screenshot(pebble).grab_image()  # list of RGB8 row bytearrays
    if not rows:
        raise RuntimeError('no screenshot data')
    height = len(rows)
    width = len(rows[0]) // 3
    snap = _SUNLIGHT_SNAP
    lut = _SUNLIGHT_LUT
    corrected = []
    for row in rows:
        out = bytearray(len(row))
        for x in range(0, len(row), 3):
            cr, cg, cb = lut[(snap[row[x]], snap[row[x+1]], snap[row[x+2]])]
            out[x] = cr; out[x+1] = cg; out[x+2] = cb
        corrected.append(out)
    png.from_array(corrected, mode='RGB;8', info={'width': width, 'height': height}).save(out_path)


def do_screenshot(transport, out_path, timeout=8.0):
    # Run the grab in a worker so a wedged framebuffer read can't block the input
    # loop forever; the watchdog turns a hang into a clean 'ERR timeout'.
    result = {}

    def worker():
        try:
            _grab_png(transport, out_path)
            result['ok'] = True
        except Exception as e:
            result['err'] = str(e)

    t = threading.Thread(target=worker)
    t.daemon = True
    t.start()
    t.join(timeout)
    if t.is_alive():
        _emit('ERR screenshot timed out')
    elif result.get('ok'):
        _emit('OK %s' % out_path)
    else:
        _emit('ERR %s' % result.get('err', 'screenshot failed'))


def main():
    port = int(sys.argv[1])
    transport = WebsocketTransport('ws://localhost:%d/' % port)
    transport.connect()
    # Keep the inbound stream drained so a pypkjs broadcast can never block on our
    # socket (which would wedge its JS runtime and break Clay). See _drain_loop.
    _start_drain(transport)

    BTN = {'back': QemuButton.Button.Back, 'up': QemuButton.Button.Up,
           'select': QemuButton.Button.Select, 'down': QemuButton.Button.Down}
    AXIS = {'x': QemuTap.Axis.X, 'y': QemuTap.Axis.Y, 'z': QemuTap.Axis.Z}

    def send(data):
        packet = QemuPacket(data=data)
        packet.serialise()
        transport.send_packet(
            WebSocketRelayQemu(protocol=packet.protocol, data=data.serialise()),
            target=MessageTargetPhone())

    SANDBOX_UUID = 'a1b2c3d4-0000-0000-0000-000000000001'

    def pin_guid(pin_id):
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, '%s.pin.developer.getpebble.com' % pin_id))

    def send_pin(pin_id, unix_time, title):
        iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(unix_time))
        now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        pin = {
            'id': pin_id, 'guid': pin_guid(pin_id), 'time': iso,
            'createTime': now_iso, 'updateTime': now_iso, 'topicKeys': [],
            'source': 'sdk', 'dataSource': 'sandbox-uuid:%s' % SANDBOX_UUID,
            'layout': {'type': 'genericPin', 'title': title,
                       'tinyIcon': 'system://images/NOTIFICATION_FLAG'},
        }
        transport.send_packet(WebSocketTimelinePin(data=InsertPin(json=json.dumps(pin))),
                              target=MessageTargetPhone())

    def send_unpin(pin_id):
        transport.send_packet(WebSocketTimelinePin(data=DeletePin(uuid=pin_guid(pin_id))),
                              target=MessageTargetPhone())

    sys.stdout.write('ready\\n')
    sys.stdout.flush()
    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        try:
            cmd = parts[0]
            if cmd in ('click', 'hold'):
                mask = 0
                for b in parts[1:]:
                    mask |= BTN.get(b, 0)
                send(QemuButton(state=mask))
                if cmd == 'click':
                    time.sleep(0.08)
                    send(QemuButton(state=0))
            elif cmd == 'release':
                send(QemuButton(state=0))
            elif cmd == 'tap':
                d = parts[1] if len(parts) > 1 else 'x+'
                axis = AXIS.get(d[0], QemuTap.Axis.X)
                direction = 1 if d.endswith('+') else -1
                send(QemuTap(axis=axis, direction=direction))
            elif cmd == 'screenshot':
                # Path may contain spaces — everything after the verb is the path.
                out_path = line.split(None, 1)[1].strip() if len(parts) > 1 else ''
                if out_path:
                    do_screenshot(transport, out_path)
                else:
                    sys.stdout.write('ERR no output path\\n')
                    sys.stdout.flush()
            elif cmd == 'pin':
                # pin <id> <unix_time> <title...>
                pin_id = parts[1]
                unix_time = int(parts[2])
                rest = line.split(None, 3)
                title = rest[3].strip() if len(rest) > 3 else 'Sample Pin'
                send_pin(pin_id, unix_time, title)
                _emit('OK pin %s' % pin_id)
            elif cmd == 'unpin':
                send_unpin(parts[1])
                _emit('OK unpin')
            elif cmd == 'logs':
                # Fire-and-forget (no ack): start streaming app logs as
                # 'LOG ...' lines. Idempotent — repeat sends are no-ops.
                _ensure_logs(transport)
        except Exception as e:
            # Input errors go to stderr (fire-and-forget); a screenshot error is
            # reported on stdout by do_screenshot, so report any stray failure
            # there too so the renderer's pending screenshot request can resolve.
            sys.stderr.write('input-helper error: %s\\n' % e)
            sys.stderr.flush()
            if parts and parts[0] in ('screenshot', 'pin', 'unpin'):
                _emit('ERR %s' % e)


main()
`;

/**
 * Language-pack helper (pb-lang-helper.py): a ONE-SHOT CLI (not a persistent
 * channel) that installs a Pebble language pack (.pbl) onto the running emulator
 * and/or reports the watch's active language, connecting to the SAME pypkjs
 * websocket the input helper uses (port passed via `--port`).
 *
 * A .pbl is pushed RAW as a single `PutBytes(File, filename="lang")` object
 * straight to the WATCH — it passes through the pypkjs bridge transparently (it
 * is NOT an app-install bundle, which would route to pypkjs and fail). The active
 * language is read from the WatchVersion handshake (WatchVersionResponse.language
 * / .language_version). Contract (consumed by the Task 9 controller):
 *
 *   pb-lang-helper.py --port <p> install <path.pbl>
 *   pb-lang-helper.py --port <p> query
 *
 * prints EXACTLY ONE JSON line to stdout —
 *   {"ok": true, "language": "fr_FR", "languageVersion": 38}
 *   {"ok": false, "error": "<message>", "kind": "<nack|connect|timeout|other>"}
 * — exit 0 on ok else 1. Every socket op is bounded by a watchdog so the process
 * never hangs (the caller enforces a 15s process timeout on top). Kept
 * backslash-free so it embeds verbatim in this template literal.
 */
export const LANG_HELPER_PY = `"""pb-lang-helper.py -- install a Pebble language pack (.pbl) onto the running
emulator and/or report the watch's active language.

Usage:
  pb-lang-helper.py --port <pypkjsPort> install <path.pbl>
  pb-lang-helper.py --port <pypkjsPort> query

A .pbl is pushed RAW as a single PutBytes File object (filename "lang") straight
to the WATCH; it passes through the pypkjs websocket bridge transparently (it is
NOT an app-install bundle). The active language is read from the WatchVersion
handshake (WatchVersionResponse.language / .language_version).

Prints EXACTLY ONE JSON line to stdout:
  {"ok": true, "language": "fr_FR", "languageVersion": 38}
  {"ok": false, "error": "<message>", "kind": "<nack|connect|timeout|other>"}
Exit 0 on ok, else 1. All socket ops are bounded by a watchdog so the process
never hangs (Task 9's controller enforces a 15s process timeout on top). Debug
lines may go to stderr; stdout stays exactly one JSON line.
"""
import sys, os, json, argparse, threading

# Overall watchdog: the process is guaranteed to finish within this many seconds
# (well under the caller's 15s spawn timeout). Individual round trips are bounded
# too so a wedged bridge produces a clean "timeout" rather than a hang. 12s is
# deliberately BELOW libpebble2's default send_and_read timeout (15s): our
# watchdog must fire (and emit the one JSON line) before any library timeout
# surfaces or the caller's process kill hits.
_OVERALL_TIMEOUT = 12.0
_REQUERY_TIMEOUT = 4.0


def _emit(obj):
    # Exactly one JSON line on stdout, flushed so the parent reads it promptly.
    print(json.dumps(obj), flush=True)


def _classify(exc):
    # Map an exception to one of the CLI's error kinds.
    name = type(exc).__name__
    low = str(exc).lower()
    if name == "PutBytesError" or "nack" in low:
        return "nack"
    if "timeout" in name.lower() or "timed out" in low:
        return "timeout"
    if (name in ("ConnectionRefusedError", "ConnectionResetError", "ConnectionError",
                 "WebSocketConnectionClosedException", "WebSocketBadStatusException",
                 "WebSocketException", "WebSocketAddressException")
            or "refused" in low or "reset" in low or "connection" in low
            or "no pypkjs" in low):
        return "connect"
    return "other"


def _read_language(pebble, timeout):
    # One bounded WatchVersion round trip -> (language, language_version). Used to
    # REFRESH after an install (the cached watch_info is pre-install).
    from libpebble2.protocol.system import WatchVersion, WatchVersionRequest
    resp = pebble.send_and_read(WatchVersion(data=WatchVersionRequest()),
                                WatchVersion, timeout=timeout).data
    lang = (resp.language or "").split(chr(0))[0]
    return lang, int(resp.language_version)


def _connect(port):
    from libpebble2.communication import PebbleConnection
    from libpebble2.communication.transports.websocket import WebsocketTransport
    pebble = PebbleConnection(WebsocketTransport("ws://localhost:%d/" % port))
    pebble.connect()
    # run_async spawns the read loop AND performs the WatchVersion handshake
    # (fetch_watch_info), so watch_info is populated when this returns.
    pebble.run_async()
    return pebble


def _do(args, result):
    try:
        pebble = _connect(args.port)
    except Exception as e:
        result["obj"] = {"ok": False, "error": str(e), "kind": _classify(e)}
        return
    try:
        if args.command == "install":
            with open(args.pbl, "rb") as f:
                data = f.read()
            from libpebble2.services.putbytes import PutBytes, PutBytesType
            PutBytes(pebble, PutBytesType.File, data, bank=0, filename="lang").send()
            # Confirm the flip with a fresh handshake. Firmware may briefly go
            # unresponsive / reboot after applying a pack, so a re-query failure
            # is reported as language "unknown" (the install itself succeeded)
            # rather than as an error.
            try:
                lang, ver = _read_language(pebble, _REQUERY_TIMEOUT)
            except Exception:
                lang, ver = "unknown", None
            result["obj"] = {"ok": True, "language": lang, "languageVersion": ver}
        else:  # query
            info = pebble.watch_info  # cached from the run_async handshake
            lang = (info.language or "").split(chr(0))[0]
            result["obj"] = {"ok": True, "language": lang,
                             "languageVersion": int(info.language_version)}
    except Exception as e:
        result["obj"] = {"ok": False, "error": str(e), "kind": _classify(e)}


def main():
    # add_help=False everywhere: argparse's -h/--help prints help to STDOUT,
    # which would break the exactly-one-JSON-line contract. Usage lives in the
    # module docstring; the only consumer is the TS controller.
    p = argparse.ArgumentParser(prog="pb-lang-helper.py", add_help=False)
    p.add_argument("--port", type=int, required=True)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("query", add_help=False)
    ip = sub.add_parser("install", add_help=False)
    ip.add_argument("pbl")
    try:
        args = p.parse_args()
    except SystemExit:
        # argparse prints its usage/error to stderr then raises SystemExit
        # (code 2) BEFORE any of our machinery runs. The contract is
        # unconditional: exactly one JSON line on stdout, exit 0/1 — so
        # translate every parse-time exit into a JSON error.
        _emit({"ok": False, "error": "invalid arguments (see stderr)",
               "kind": "other"})
        sys.exit(1)

    result = {}
    t = threading.Thread(target=_do, args=(args, result))
    t.daemon = True
    t.start()
    t.join(_OVERALL_TIMEOUT)
    if t.is_alive():
        # A wedged websocket keeps the daemon thread alive; os._exit so we still
        # terminate immediately after emitting the one JSON line.
        _emit({"ok": False, "error": "operation timed out", "kind": "timeout"})
        os._exit(1)
    obj = result.get("obj") or {"ok": False, "error": "no result", "kind": "other"}
    _emit(obj)
    sys.exit(0 if obj.get("ok") else 1)


main()
`;

export interface DeployedHelpers {
  /** Absolute path to the deployed persistent input helper. */
  inputHelperPath: string;
  /** Absolute path to the deployed one-shot language-pack helper. */
  langHelperPath: string;
}

/**
 * Write the helper scripts into `dir` (created if missing) and return their
 * absolute paths. Idempotent — overwrites with the current source each launch so
 * an app update re-deploys fresh helpers.
 */
export function deployWinHelpers(dir: string): DeployedHelpers {
  mkdirSync(dir, { recursive: true });
  const inputHelperPath = join(dir, "pb-input-helper.py");
  writeFileSync(inputHelperPath, INPUT_HELPER_PY, "utf8");
  const langHelperPath = join(dir, "pb-lang-helper.py");
  writeFileSync(langHelperPath, LANG_HELPER_PY, "utf8");
  return { inputHelperPath, langHelperPath };
}
