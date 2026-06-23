import { spawn } from "node:child_process";

/** Pure line splitter: given previously-buffered text + a new chunk, return the
 * complete lines (CRLF normalized, newline stripped) and the trailing partial. */
export function splitLines(buffered: string, chunk: string): { lines: string[]; rest: string } {
  const text = (buffered + chunk).replace(/\r\n/g, "\n");
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/** Handle to a running streamed child. */
export interface LineStreamHandle {
  kill(): void;
}

/**
 * Spawn a long-running child and deliver its stdout+stderr as whole lines via
 * `onLine`. Used for `pebble logs` (a continuous stream, unlike spawnRunner which
 * buffers and resolves on close). windowsHide so no console flashes; errors are
 * swallowed (a missing binary just yields no log lines).
 */
export function spawnLineStream(
  cmd: string,
  args: string[],
  env: Record<string, string> | undefined,
  onLine: (line: string) => void,
): LineStreamHandle {
  const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const feed = (chunk: Buffer): void => {
    const { lines, rest } = splitLines(buf, chunk.toString());
    buf = rest;
    for (const l of lines) onLine(l);
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  child.on("error", () => { /* binary missing / spawn failed → no logs */ });
  return { kill: () => { try { child.kill(); } catch { /* already gone */ } } };
}
