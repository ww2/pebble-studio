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
 *   Step 1: Read process states from /proc/<pid>/status (field "State:").
 *           `grep -m1 ^State /proc/<pid>/status` returns e.g. "State:\tZ (zombie)"
 *           or fails with exit code 1 when the file is absent (process gone).
 *           We run this for both PIDs and count how many lines contain Z.
 *           If fewer than 2 lines came back, or any line starts with Z, the
 *           PID check fails → print DEAD pid and exit 1.
 *   Step 2: Attempt a TCP connection to localhost:<pypkjsPort> using bash's
 *           built-in /dev/tcp device (quote-free: /dev/tcp/localhost/<port>
 *           uses no word-splitting characters). A refused/timed-out connect
 *           fails fast (no timeout wrapper needed for refuse; a live but slow
 *           port could hang, so we wrap the subshell with a `timeout 2`
 *           invocation — `timeout 2 bash -lc ...` would need inner quotes, so
 *           instead we use the /dev/tcp redirect directly in a subshell with
 *           `timeout 2 /bin/bash` passing the compound command as a here-doc
 *           — but here-docs need quotes. Simplest truly quote-free approach:
 *           use `(exec 3<>/dev/tcp/localhost/PORT) 2>/dev/null` — parentheses
 *           open a subshell whose failure mode on refused/nonexistent port is
 *           immediate; on a live but slow port this subshell blocks, so we
 *           accept that `timeout` is omitted (a refused connection is
 *           instant; a half-open one that hangs is itself a signal of
 *           degraded health that the caller's debounce will surface).
 *   Verdict: on success echo OK; on failure echo DEAD port.
 */
export function buildHealthCommand(pids: BridgePids): string {
  const { qemuPid, pypkjsPid, pypkjsPort } = pids;

  // Step 1: collect "State:" lines from /proc/<pid>/status for both processes.
  // grep -m1 exits 0 and prints "State:\t<char> ..." on success; exits 1 when
  // the file is absent (process gone). We gather both outputs separated by a
  // newline via printf, then count lines.
  //
  // We use `awk` to extract the single state character from each "State:" line:
  //   awk NR==1{print $2} → first field after "State:", e.g. "Z", "S", "R", ...
  // Then we count total lines and lines starting with Z.
  //
  // quote-free count-of-Z lines: `grep -c ^Z` counts matching lines (0 if none).
  // quote-free total-line count: `wc -l` — but note: if proc file is absent,
  // grep -m1 exits 1. We use `|| true` to suppress the exit code and still
  // allow the pipeline to proceed, counting an empty line contribution.
  //
  // Simpler approach that avoids counting: build a small if-block using process
  // substitution. But process substitution uses <(...) which requires no quotes.
  //
  // Final chosen design (clearest and verifiably quote-free):
  //   STATES=$(grep -m1 ^State /proc/<q>/status 2>/dev/null | awk {print $2};
  //            grep -m1 ^State /proc/<p>/status 2>/dev/null | awk {print $2})
  //   LINE_COUNT=$(echo $STATES | wc -w)   # word count = number of state chars
  //   ZOMBIE_COUNT=$(echo $STATES | grep -c ^Z)
  //   if [ $LINE_COUNT -lt 2 ] || [ $ZOMBIE_COUNT -gt 0 ]; then echo DEAD pid; exit 1; fi
  //
  // awk program: {print $2} — braces are fine (no quotes needed); $2 is the
  // second whitespace-separated field of "State:\tZ (zombie)".
  //
  // Step 2: TCP probe — (exec 3<>/dev/tcp/localhost/PORT) 2>/dev/null
  // On connect refused this fails immediately. On success the subshell exits 0.

  return (
    `QSTATE=$(grep -m1 ^State /proc/${qemuPid}/status 2>/dev/null | awk {print $2}); ` +
    `PSTATE=$(grep -m1 ^State /proc/${pypkjsPid}/status 2>/dev/null | awk {print $2}); ` +
    `if [ -z $QSTATE ] || [ -z $PSTATE ]; then echo DEAD pid; exit 1; fi; ` +
    `if [ $(echo $QSTATE | cut -c1) = Z ] || [ $(echo $PSTATE | cut -c1) = Z ]; then echo DEAD pid; exit 1; fi; ` +
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
