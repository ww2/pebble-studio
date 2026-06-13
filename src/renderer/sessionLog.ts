/**
 * Persistent diagnostics session log — DOM-free and pure so it's unit-testable.
 *
 * WHY this exists: the old boot-step overlay (`bootLog` in EmulatorView) was
 * wiped at the start of every boot AND again the moment the watch went live, and
 * the bridge-dead handler added nothing — so at the exact moment you'd want to
 * read it (right after a crash), it was empty. The qemu-pebble SIGBUS that kills
 * the emulator "loads then crashes" is an upstream binary fault we can't patch;
 * the realistic lever is observability. This model accumulates the full timeline
 * (boot steps + Live + crash reason + auto-relaunch + boot errors), each
 * timestamped, and is NEVER cleared on launch/crash — only on app close or an
 * explicit Clear — so a crash can be inspected (and copied to the clipboard)
 * after the fact.
 */

export type SessionLogKind = "boot" | "live" | "crash" | "relaunch" | "error" | "info";

export interface SessionLogEntry {
  /** Wall-clock timestamp (ms since epoch) of the entry. */
  t: number;
  kind: SessionLogKind;
  text: string;
}

export interface SessionLogOptions {
  /** Injectable clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Max entries retained; oldest are dropped past this (default 300). */
  cap?: number;
}

const DEFAULT_CAP = 300;

/** Phase key for boot-tick collapse: the text before the first " · " separator. */
function phasePrefix(s: string): string {
  return s.split(" · ")[0];
}

export class SessionLog {
  private readonly entries: SessionLogEntry[] = [];
  private readonly now: () => number;
  private readonly cap: number;

  constructor(opts: SessionLogOptions = {}) {
    this.now = opts.now ?? ((): number => Date.now());
    this.cap = opts.cap ?? DEFAULT_CAP;
  }

  /**
   * Append a boot-progress note. Consecutive ticks for the SAME phase (sharing
   * the text before the first " · ") collapse onto one updating entry — mirroring
   * the live boot overlay so a stuck phase emitting a tick every 1.5 s doesn't
   * flood the log. A different phase, or any non-boot entry in between, breaks the
   * run so the next tick starts a fresh line.
   */
  appendBootStep(text: string): void {
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === "boot" && phasePrefix(last.text) === phasePrefix(text)) {
      last.text = text;
      last.t = this.now();
      return;
    }
    this.push("boot", text);
  }

  /** Append a discrete lifecycle/event entry (never collapses). */
  append(kind: SessionLogKind, text: string): void {
    this.push(kind, text);
  }

  private push(kind: SessionLogKind, text: string): void {
    this.entries.push({ t: this.now(), kind, text });
    const overflow = this.entries.length - this.cap;
    if (overflow > 0) this.entries.splice(0, overflow);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Each entry as "HH:MM:SS  <text>" (local wall clock). */
  toLines(): string[] {
    return this.entries.map((e) => `${fmtClock(e.t)}  ${e.text}`);
  }

  /** The whole log as newline-joined text (for the overlay / clipboard). */
  toText(): string {
    return this.toLines().join("\n");
  }
}

/** Local-wall-clock "HH:MM:SS" for a ms-since-epoch timestamp. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
