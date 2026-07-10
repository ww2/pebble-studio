import type { PlatformId } from "../../shared/types.js";
import type { BootToken } from "./bootEmulator.js";

/**
 * The warm-standby lifecycle:
 *  - `idle`    — nothing pre-booting (start state; also after a cancel/reset/failure).
 *  - `booting` — a background boot of the last-used board is in flight.
 *  - `ready`   — that boot reached Live and is waiting to be claimed.
 *  - `claimed` — the first user Launch adopted the warm boot (single-shot; the
 *                standby never re-arms this session).
 */
export type WarmState = "idle" | "booting" | "ready" | "claimed";

/**
 * Boot a board to Live and resolve with whatever the driver's `start()` returns
 * (the VNC endpoint). The `token` lets `cancel()`/`reset()` abort an in-flight
 * boot's wait loops promptly (mirrors emu:start's BootToken contract).
 */
export type WarmBootFn<T> = (id: PlatformId, token: BootToken) => Promise<T>;

/**
 * Fully kill the emulator stack (qemu/pypkjs/websockify/…). Called by `cancel()`
 * to free the single-instance VNC ports before a DIFFERENT board boots. Must
 * never throw (a teardown error must not block the user's real boot).
 */
export type WarmKillFn = () => Promise<void>;

export interface WarmStandbyDeps<T> {
  /** Whether pre-boot is enabled (Settings → "Pre-boot emulator on app start").
   * Read at `kick()` time; when false, `kick()` is a no-op. */
  enabled: () => boolean;
  boot: WarmBootFn<T>;
  kill: WarmKillFn;
  /** Optional sink for a swallowed pre-boot error (logged, never rethrown to
   * whoever called `kick()` — `backend:init` must never be gated/rejected). */
  onError?: (err: unknown) => void;
}

/**
 * Warm-standby pre-boot + attach (Task 5).
 *
 * `kick(board)` fires a background boot of the last-used board right after
 * `backend:init` finishes provisioning — fire-and-forget, so it never gates the
 * init response and its errors are swallowed to a log line. The first user
 * Launch of that same board calls `claim(board)`, which returns the SAME
 * in-flight (or already-`ready`) boot promise so the emulator boots exactly once
 * and attaches near-instantly. A Launch of a DIFFERENT board gets `null` from
 * `claim()` and must `cancel()` first (flip the warm boot's token + kill the
 * stack, since the VNC ports are single-instance) before its own boot proceeds.
 *
 * The class is pure (driver injected via `deps`), so the state machine is unit-
 * tested with a fake boot/kill; `ipc.ts` wires the real driver in.
 *
 * IMPORTANT: this owns only the boot-to-Live step. Post-live work (battery/time
 * re-assert, bridge monitor, app-log) still runs in `emu:start` after it claims,
 * exactly once per user-visible launch.
 */
export class WarmStandby<T> {
  private _state: WarmState = "idle";
  private _board: PlatformId | null = null;
  private _token: BootToken | null = null;
  private _promise: Promise<T> | null = null;

  constructor(private readonly deps: WarmStandbyDeps<T>) {}

  state(): WarmState {
    return this._state;
  }

  /** The board being pre-booted (or that was claimed), or null when idle. */
  currentBoard(): PlatformId | null {
    return this._board;
  }

  /** The in-flight boot's cancellation token — so `emu:start` can adopt it as the
   * current boot token when it claims (abort/stop then cancel the right boot). */
  currentToken(): BootToken | null {
    return this._token;
  }

  /**
   * Fire-and-forget: begin a background boot of `id`. No-op when pre-boot is
   * disabled or a warm boot is already armed (single-shot per session). Never
   * throws and never returns a promise the caller must await — the boot's outcome
   * is observed later via `claim()`; a failure resets to `idle` and is reported
   * through `onError`.
   */
  kick(id: PlatformId): void {
    if (!this.deps.enabled()) return;
    if (this._state !== "idle") return; // already armed — don't double-boot
    const token: BootToken = { cancelled: false };
    this._board = id;
    this._token = token;
    this._state = "booting";
    this._promise = (async () => {
      try {
        const res = await this.deps.boot(id, token);
        // Only advance to 'ready' if this boot is still the owner (not cancelled
        // out from under us by a reset/cancel while it was in flight).
        if (this._state === "booting" && this._token === token) this._state = "ready";
        return res;
      } catch (err) {
        this.deps.onError?.(err);
        // Reset so a later claim(id) returns null → caller does a normal cold boot.
        if (this._token === token) {
          this._state = "idle";
          this._board = null;
          this._token = null;
        }
        throw err;
      }
    })();
    // The stored promise is what claim() hands to the eventual awaiter; attach a
    // no-op catch to a DERIVED promise so an unclaimed failure never surfaces as
    // an unhandledRejection (backend:init does not await this).
    this._promise.catch(() => {});
  }

  /**
   * If a warm boot for `id` is in flight or ready, mark it claimed (single-shot)
   * and return its boot promise (which may still be pending, or already resolved,
   * or reject if the boot ultimately fails). Otherwise return null — the caller
   * then does a normal cold boot (after `cancel()`-ing any warm boot for a
   * different board).
   */
  claim(id: PlatformId): Promise<T> | null {
    if (
      this._board === id &&
      (this._state === "booting" || this._state === "ready") &&
      this._promise
    ) {
      this._state = "claimed";
      return this._promise;
    }
    return null;
  }

  /**
   * Cancel an UNCLAIMED warm boot (flip its token, then await a full stack kill so
   * the single-instance ports are free before the caller boots a different board).
   * No-op — and crucially NO kill — when idle or already claimed (a claimed boot is
   * the live watch the user is using; tearing it down here would be wrong).
   *
   * IMPORTANT ordering: the abandoned boot fn is awaited to FULL unwind BEFORE
   * this resolves. bootEmulator's BootAborted catch runs its own terminal
   * `killAll()` — a BLANKET sweep of every emulator-image PID — so if cancel()
   * returned while that fn was still mid-flight, the caller's fresh cold boot
   * could spawn and then be blanket-killed by the abandoned boot's late cleanup.
   * Capturing the promise before reset() (which nulls it) and awaiting it here
   * guarantees the stale killAll has already run when the cold boot proceeds.
   */
  async cancel(): Promise<void> {
    const active = this._state === "booting" || this._state === "ready";
    const inflight = this._promise; // capture BEFORE reset() nulls it
    this.reset(); // flips the token → the boot fn's next check throws BootAborted
    if (active) {
      // Wait for the abandoned boot fn to fully unwind (including its own
      // terminal killAll on BootAborted). Rejection is the EXPECTED outcome of a
      // cancelled boot; a resolved ('ready') promise settles instantly.
      if (inflight) await inflight.catch(() => {});
      try {
        await this.deps.kill();
      } catch {
        /* kill must never throw — a teardown error must not block the real boot */
      }
    }
  }

  /**
   * Flip the in-flight boot's token and drop back to `idle` WITHOUT killing the
   * stack. Used by the shared emulator teardown (emu:stop / app quit), which
   * already stops the driver itself — this just clears the warm state so a later
   * claim can't attach to a boot that teardown already killed.
   */
  reset(): void {
    if (this._token) this._token.cancelled = true;
    this._state = "idle";
    this._board = null;
    this._token = null;
    this._promise = null;
  }
}
