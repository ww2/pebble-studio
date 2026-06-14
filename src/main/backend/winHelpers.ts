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
 */
export const INPUT_HELPER_PY = `import sys, time
from libpebble2.communication.transports.websocket import WebsocketTransport, MessageTargetPhone
from libpebble2.communication.transports.websocket.protocol import WebSocketRelayQemu
from libpebble2.communication.transports.qemu.protocol import QemuPacket, QemuButton, QemuTap


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
        except Exception as e:
            sys.stderr.write('input-helper error: %s\\n' % e)
            sys.stderr.flush()


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
