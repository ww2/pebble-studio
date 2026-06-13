/**
 * Bridge health detection core (Task H1 — pure, unit-testable).
 *
 * Detects whether the qemu-pebble + pypkjs processes are still alive and
 * reachable by reading the emulator state file and probing the real process
 * table. Pure (no Electron, no polling loop, no fs reads) — all three
 * exported functions are fully unit-testable under vitest's node environment.
 *
 * Three responsibilities:
 *   1. parseBridgePids  — extract qemu.pid, pypkjs.pid, pypkjs.port from the
 *      /tmp/pb-emulator.json text (same read pattern as parsePhonesimPort in
 *      clayWindow.ts and parseMonitorPort in backend/backlight.ts).
 *   2. buildHealthCommand — assemble a quote-free bash one-liner that probes
 *      process states and the pypkjs TCP port, printing OK / DEAD pid /
 *      DEAD port to stdout.
 *   3. interpretHealth — parse that stdout into a structured verdict.
 *
 * CRITICAL: buildHealthCommand output MUST contain ZERO single-quote (') and
 * ZERO double-quote (") characters. The command is run via a Shell that on a
 * Windows host re-wraps it as `wsl.exe -- bash -lc "'bash' '-lc' '<cmd>'"`.
 * Any quote inside the command string is mangled across the two shell hops and
 * silently breaks only on the real .exe. (See pebbleCli.ts setTzOffsetCmd and
 * its no-quote test for the same constraint.)
 */

/**
 * The three identifiers needed to assess bridge health:
 *   - qemuPid     — PID of the qemu-pebble process
 *   - pypkjsPid   — PID of the pypkjs phone-bridge process
 *   - pypkjsPort  — WebSocket/TCP port pypkjs listens on
 */
export interface BridgePids {
  qemuPid: number;
  pypkjsPid: number;
  pypkjsPort: number;
}

/**
 * Extract the qemu PID, pypkjs PID, and pypkjs port for a given platform from
 * the emulator state file's JSON text (pebble-tool's /tmp/pb-emulator.json).
 *
 * Pure (no fs / no shell) so it is unit-testable. The file shape is:
 *   { "<platform>": { "<sdkVersion>": {
 *       "qemu":   { "pid": <n>, "port": <n>, "monitor": <n>, "vnc": true },
 *       "pypkjs": { "pid": <n>, "port": <n> },
 *       "websockify": { "pid": <n> }
 *     } } }
 * We return the first version entry under `platform` that carries all three
 * values (qemu.pid, pypkjs.pid, pypkjs.port) as finite numbers, or null when
 * the json is missing/malformed or no such entry exists. Tolerates non-object
 * shapes at any level without throwing.
 * (Same read pattern as parsePhonesimPort in clayWindow.ts and
 * parseMonitorPort in backend/backlight.ts.)
 */
export function parseBridgePids(json: string, platform: string): BridgePids | null {
  try {
    const parsed = JSON.parse(json) as Record<
      string,
      Record<
        string,
        {
          qemu?: { pid?: number };
          pypkjs?: { pid?: number; port?: number };
        }
      >
    >;
    const versions = parsed?.[platform];
    if (!versions || typeof versions !== "object") return null;
    for (const v of Object.values(versions)) {
      const qemuPid = v?.qemu?.pid;
      const pypkjsPid = v?.pypkjs?.pid;
      const pypkjsPort = v?.pypkjs?.port;
      if (
        typeof qemuPid === "number" && Number.isFinite(qemuPid) &&
        typeof pypkjsPid === "number" && Number.isFinite(pypkjsPid) &&
        typeof pypkjsPort === "number" && Number.isFinite(pypkjsPort)
      ) {
        return { qemuPid, pypkjsPid, pypkjsPort };
      }
    }
  } catch {
    /* missing / partial / malformed json → no pids */
  }
  return null;
}

/**
 * Build a quote-free bash one-liner that probes qemu + pypkjs health and
 * prints exactly ONE verdict token to stdout:
 *   OK        — both processes are alive (not zombies) and the pypkjs port
 *               accepts a TCP connection.
 *   DEAD pid  — at least one PID is gone or in zombie state (Z).
 *   DEAD port — both PIDs are alive but the pypkjs TCP port is not reachable.
 *
 * CRITICAL — the returned string MUST contain ZERO ' and ZERO " characters.
 * See module-level comment for why. All tokens are unquoted; the only
 * shell-special characters used are redirection (>/dev/null, 2>/dev/null),
 * pipe (|), semicolon (;), and parentheses — none of which require quoting
 * and all of which survive the WSL double-shell-hop unmangled.
 *
 * Implementation strategy (quote-free):
 *   Step 1: Read a single state char from /proc/<pid>/status via grep+cut.
 *           `grep -m1 ^State /proc/<pid>/status | cut -f2 | cut -c1` yields
 *           one char (Z/S/R/…) or empty when the process is gone.
 *           If either QSTATE or PSTATE is empty or equals Z → DEAD pid.
 *   Step 2: TCP probe via bare `(exec 3<>/dev/tcp/localhost/PORT) 2>/dev/null`.
 *           A refused connect fails immediately — no timeout wrapper needed.
 *   Verdict: on success echo OK; on failure echo DEAD port.
 */
export function buildHealthCommand(pids: BridgePids): string {
  const { qemuPid, pypkjsPid, pypkjsPort } = pids;

  // Step 1: extract a single state char from /proc/<pid>/status.
  // "State:" and the value are separated by a TAB, so `cut -f2` gives the value
  // field ("Z (zombie)", "S (sleeping)", etc.) and `cut -c1` reduces it to one
  // safe char. Empty when the process file is absent (process gone).
  // Single char, no spaces → unquoted [ ] tests are safe.
  //
  // Step 2: TCP probe — (exec 3<>/dev/tcp/localhost/PORT) 2>/dev/null
  // On connect refused this fails immediately. On success the subshell exits 0.

  return (
    `QSTATE=$(grep -m1 ^State /proc/${qemuPid}/status 2>/dev/null | cut -f2 | cut -c1); ` +
    `PSTATE=$(grep -m1 ^State /proc/${pypkjsPid}/status 2>/dev/null | cut -f2 | cut -c1); ` +
    `if [ -z $QSTATE ] || [ -z $PSTATE ] || [ $QSTATE = Z ] || [ $PSTATE = Z ]; then echo DEAD pid; exit 1; fi; ` +
    `(exec 3<>/dev/tcp/localhost/${pypkjsPort}) 2>/dev/null && echo OK || echo DEAD port`
  );
}

/**
 * Interpret the stdout (and exit code) of the health command into a structured
 * verdict.
 *
 * Tokens (case-insensitive, leading/trailing whitespace ignored):
 *   "OK"        → { alive: true,  kind: "ok"   }
 *   "DEAD pid"  → { alive: false, kind: "pid"  }
 *   "DEAD port" → { alive: false, kind: "port" }
 *   anything else (empty, garbage, parse error) →
 *               → { alive: false, kind: "port" }
 *                 (conservative; the monitor debounces port failures so this
 *                  won't immediately trigger a false alarm for a one-off glitch)
 *
 * `code` is accepted for API completeness but is not needed — the command
 * always prints a token regardless of exit code; the token carries the verdict.
 */
export function interpretHealth(
  stdout: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _code: number,
): { alive: boolean; kind: "ok" | "pid" | "port" } {
  const token = stdout.trim().toLowerCase();
  if (token === "ok") return { alive: true, kind: "ok" };
  if (token === "dead pid") return { alive: false, kind: "pid" };
  if (token === "dead port") return { alive: false, kind: "port" };
  // Empty, unknown, or garbage output → conservative dead-port verdict.
  return { alive: false, kind: "port" };
}
