import { splitLines } from "./lineStream.js";

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
 * fed via push() by the streaming spawn in ipc.ts.
 */
export class AppLogStream {
  private readonly lines: string[] = [];
  private partial = "";
  private readonly cap: number;
  onLine: (line: string) => void;

  constructor(opts: AppLogStreamOptions = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.onLine = opts.onLine ?? ((): void => {});
  }

  push(chunk: string): void {
    const { lines, rest } = splitLines(this.partial, chunk);
    this.partial = rest;
    for (const l of lines) {
      this.lines.push(l);
      this.onLine(l);
    }
    const overflow = this.lines.length - this.cap;
    if (overflow > 0) this.lines.splice(0, overflow);
  }

  history(): string[] {
    return this.lines.slice();
  }

  clear(): void {
    this.lines.length = 0;
    // Drop any buffered partial line too, so the first line after a clear isn't
    // prefixed with a stale fragment from before it.
    this.partial = "";
  }
}
