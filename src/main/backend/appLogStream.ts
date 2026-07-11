export interface AppLogStreamOptions {
  /** Max lines retained; oldest dropped past this (default 2000). */
  cap?: number;
  /** Called with each complete line as it arrives (for live IPC forwarding). */
  onLine?: (line: string) => void;
}

const DEFAULT_CAP = 2000;

/**
 * Bounded in-memory buffer of emulator app-log lines (the `pebble logs` stream).
 * Capture runs whenever the emulator is live; the renderer toggle only controls
 * visibility, so history() back-fills the panel when first opened. Pure (no I/O):
 * fed via push() by the streaming spawn / input channel in ipc.ts.
 */
export class AppLogStream {
  private readonly lines: string[] = [];
  private readonly cap: number;
  onLine: (line: string) => void;

  constructor(opts: AppLogStreamOptions = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.onLine = opts.onLine ?? ((): void => {});
  }

  /**
   * Record emulator output. The feeders (spawnLineStream for the CLI/WSL `pebble
   * logs` path, and WinInputChannel for the native helper stream) ALREADY split
   * their raw stdout into whole lines, so each push() is one complete line —
   * sometimes fully newline-stripped (CLI), sometimes carrying a trailing CR (the
   * channel splits the helper's stdout on "\n" and leaves the "\r"). So we
   * normalize CRLF/CR and emit the line(s) directly.
   *
   * There is deliberately NO cross-push partial buffering: the line split already
   * happened upstream. Re-splitting here and holding a newline-less remainder as a
   * "partial" meant every pre-split line (which never carries its own "\n") was
   * buffered forever and never reached the panel — the #6 "logs show nothing" bug.
   * A single push that does carry multiple "\n"-separated lines is still split
   * (defensive); a lone trailing "" from a terminating "\n" is dropped.
   */
  push(chunk: string): void {
    const text = chunk.replace(/\r\n/g, "\n").replace(/\r+$/, "");
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1 && parts[i] === "") break; // trailing-newline artifact
      this.lines.push(parts[i]);
      this.onLine(parts[i]);
    }
    const overflow = this.lines.length - this.cap;
    if (overflow > 0) this.lines.splice(0, overflow);
  }

  history(): string[] {
    return this.lines.slice();
  }

  clear(): void {
    this.lines.length = 0;
  }
}
