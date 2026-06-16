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
export const INPUT_HELPER_PY = `import sys, time, threading
from libpebble2.communication.transports.websocket import WebsocketTransport, MessageTargetPhone
from libpebble2.communication.transports.websocket.protocol import WebSocketRelayQemu
from libpebble2.communication.transports.qemu.protocol import QemuPacket, QemuButton, QemuTap

# Lazy framebuffer-screenshot state. The PebbleConnection that drives the
# libpebble2 Screenshot service is built once, on the first 'screenshot' command,
# wrapping the SAME transport the button relay already uses. None until then so
# the pure-input path pays nothing.
_pebble = None
_pebble_lock = threading.Lock()


def _get_pebble(transport):
    # Build (once) and return a connected PebbleConnection over the live relay
    # socket. run_async() spawns the read loop + fetch_watch_info() handshake the
    # Screenshot service needs. Raises on failure — caller turns it into 'ERR'.
    global _pebble
    with _pebble_lock:
        if _pebble is None:
            from libpebble2.communication import PebbleConnection
            p = PebbleConnection(transport)
            p.run_async()  # background read loop; also fetches watch info
            _pebble = p
        return _pebble


def _grab_png(transport, out_path):
    # Framebuffer grab → PNG. Returns on success; raises on any failure. Runs in a
    # worker thread under a watchdog (see do_screenshot) so a hung grab times out.
    from libpebble2.services.screenshot import Screenshot
    import png
    pebble = _get_pebble(transport)
    rows = Screenshot(pebble).grab_image()  # list of RGB8 row bytearrays
    if not rows:
        raise RuntimeError('no screenshot data')
    height = len(rows)
    width = len(rows[0]) // 3
    # pebble_tool saves with png.from_array(..., mode='RGBA;8'); the Screenshot
    # service returns RGB8 rows, so write straight RGB (no colour correction /
    # roundify — those are cosmetic, and the renderer masks round platforms).
    png.from_array(rows, mode='RGB;8', info={'width': width, 'height': height}).save(out_path)


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
        sys.stdout.write('ERR screenshot timed out\\n')
    elif result.get('ok'):
        sys.stdout.write('OK %s\\n' % out_path)
    else:
        sys.stdout.write('ERR %s\\n' % result.get('err', 'screenshot failed'))
    sys.stdout.flush()


def main():
    port = int(sys.argv[1])
    transport = WebsocketTransport('ws://localhost:%d/' % port)
    transport.connect()

    BTN = {'back': QemuButton.Button.Back, 'up': QemuButton.Button.Up,
           'select': QemuButton.Button.Select, 'down': QemuButton.Button.Down}
    AXIS = {'x': QemuTap.Axis.X, 'y': QemuTap.Axis.Y, 'z': QemuTap.Axis.Z}

    def send(data):
        packet = QemuPacket(data=data)
        packet.serialise()
        transport.send_packet(
            WebSocketRelayQemu(protocol=packet.protocol, data=data.serialise()),
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
        except Exception as e:
            # Input errors go to stderr (fire-and-forget); a screenshot error is
            # reported on stdout by do_screenshot, so report any stray failure
            # there too so the renderer's pending screenshot request can resolve.
            sys.stderr.write('input-helper error: %s\\n' % e)
            sys.stderr.flush()
            if parts and parts[0] == 'screenshot':
                sys.stdout.write('ERR %s\\n' % e)
                sys.stdout.flush()


main()
`;

export interface DeployedHelpers {
  /** Absolute path to the deployed persistent input helper. */
  inputHelperPath: string;
}

/**
 * Write the input helper script into `dir` (created if missing) and return its
 * absolute path. Idempotent — overwrites with the current source each launch so
 * an app update re-deploys a fresh helper.
 */
export function deployWinHelpers(dir: string): DeployedHelpers {
  mkdirSync(dir, { recursive: true });
  const inputHelperPath = join(dir, "pb-input-helper.py");
  writeFileSync(inputHelperPath, INPUT_HELPER_PY, "utf8");
  return { inputHelperPath };
}
