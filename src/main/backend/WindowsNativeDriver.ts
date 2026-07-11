import { promises as fs } from "node:fs";
import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { AppLogHandle, BackendDriver, HealthActivateResult, RunResult, Runner, VncEndpoint } from "./BackendDriver.js";
import { NativeDriver, type BootFn, type StopFn } from "./NativeDriver.js";
import type { BootToken, OnStep } from "./bootEmulator.js";
import type { PebbleCmdBuilder } from "./winBootDeps.js";
import { winPath } from "./winPath.js";
import { winHostPaths } from "./hostPaths.js";
import { winSetTzOffsetArgv } from "./pebbleCli.js";
import * as cli from "./pebbleCli.js";
import type { WinInputChannel } from "./winInputChannel.js";
import { writeWinFakeTime } from "./winTimeShim.js";
import { spawnLineStream } from "./lineStream.js";

/** Fixed id for the demo pin the Timeline button inserts so the peek is visible. */
const SAMPLE_PIN_ID = "studio-sample-pin";

export interface WinTimeHelper {
  /** Python interpreter that has pebble-tool's libpebble2. */
  pythonExe: string;
  /** Deployed pb-set-tz.py helper path. */
  helperPath: string;
}

export interface WindowsNativeDriverDeps {
  run: Runner;
  /** Build the bundled pebble-tool invocation (winRuntime.pebbleCmd). When set,
   * discrete `pebble` commands are rewritten to the bundled python + run_tool()
   * call with the runtime env. When absent, they spawn bare `pebble` on PATH
   * (legacy behavior). */
  pebble?: PebbleCmdBuilder;
  /** Windows boot orchestration (makeWinBootDeps-backed in production). */
  boot?: BootFn;
  /** Windows teardown orchestration. */
  stop?: StopFn;
  /** Startup orphan reaper: force-kill any leftover emulator stack from a prior
   * session (no graceful `pebble kill`). Called once at backend:init before the
   * first boot is enabled. Absent → reap() is a no-op. */
  reap?: () => Promise<void>;
  /** Resolved python + helper paths for the legacy utc_offset time push. When
   * absent, setTzOffset degrades to a no-op (legacy time silently unavailable),
   * mirroring how the POSIX path degrades when the tool isn't found. */
  timeHelper?: WinTimeHelper;
  /** Persistent input channel. When set, button/accelTap go through the long-lived
   * helper (a stdin write, ~0ms) instead of a per-press `pebble emu-button` spawn.
   * Falls back to the inner CLI path when the channel is unavailable (not booted,
   * helper died). Absent → always uses the CLI path (legacy behavior). */
  inputChannel?: WinInputChannel;
  /** Custom-time control file. Custom time is built into the bundled qemu-pebble.exe
   * (the Pebble RTC reads this file directly), so ensureTimeShim is always ready and
   * setFakeTime just writes the %TEMP% control file. Absent → ensureTimeShim=false +
   * setFakeTime=no-op (no custom time). `ftLogPath` (qemu's PEBBLE_FAKETIME_LOG) is
   * truncated once per boot so the diagnostic log can't grow unbounded. */
  timeShim?: { ctlPath: string; ftLogPath?: string };
  /** Injectable delay (tests pass a no-op so health-activation retries don't wait).
   * Defaults to a real setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Streaming spawn for `streamLogs` (injectable for tests). */
  logSpawn?: typeof spawnLineStream;
  /**
   * QEMU snapshot creation hook (Tasks 6+7). Reads the qemu monitor port and
   * drives the SnapshotManager to save a per-board bundle after a cold boot
   * reaches Live. Fire-and-forget + never throws. Absent ⇒ snapshots disabled
   * (no snapshot is ever created). Wired by createDriver from the SnapshotManager.
   */
  snapshotCreate?: (board: PlatformId, isCancelled?: () => boolean) => Promise<void>;
}

/**
 * Health activation races the emulator's readiness: the helper reads the emulator
 * state file for the pypkjs port and connects to pypkjs's libpebble2 websocket, but
 * BOTH can lag the "Live" signal on a slow/retried boot — so a single attempt hits
 * FileNotFound / connection-refused and reports no status (a false "not activated").
 * A READY emulator answers in ~10ms and these not-ready failures fail FAST, so we
 * retry a fast miss a few times. A null result that took longer than the ready
 * threshold means we connected but the watch never answered (the helper's own 3s
 * read timeout) — that is NOT a readiness race, so we stop rather than hang the boot.
 */
export const HEALTH_ACTIVATE_MAX_ATTEMPTS = 8;
export const HEALTH_ACTIVATE_RETRY_MS = 400;
export const HEALTH_ACTIVATE_READY_MS = 1200;

/**
 * Battery pushes (`pebble emu-battery`) open a libpebble2 connection that calls
 * fetch_watch_info() on connect; on first boot the pypkjs bridge + watch-protocol
 * handshake lags the "Live" signal (see bridgeMonitor's startup grace) and that
 * connect times out (libpebble2 TimeoutError) → the CLI exits nonzero and `exec`
 * rethrows the raw Python traceback. Like health activation, we retry across the
 * settling window and surface a short, friendly message instead of the traceback.
 */
export const BATTERY_PUSH_MAX_ATTEMPTS = 5;
export const BATTERY_PUSH_RETRY_MS = 600;

/** Hard bound (ms) for the bare python tz-offset helper. Matches the POSIX path's
 * `timeout -k 2 6` SIGKILL deadline and timeController's TZ_PUSH_TIMEOUT_MS so a
 * wedged pypkjs connection can't hang the push or leave a zombie python. */
export const TZ_PUSH_TIMEOUT_MS = 8000;

/** spawnRunner accepts an optional 4th `timeoutMs` arg beyond the base Runner
 * contract; this widens the injected runner at the one call site that needs it. */
type TimedRunner = (cmd: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => Promise<RunResult>;

/** Pure retry decision for one activation attempt. Exported for testing. */
export function healthRetryDecision(
  status: number | null,
  elapsedMs: number,
): "done" | "retry" {
  if (status !== null) return "done";                  // definitive answer (success or a real code)
  if (elapsedMs >= HEALTH_ACTIVATE_READY_MS) return "done"; // connected but no ack — don't hammer
  return "retry";                                      // fast miss = not-ready race → retry
}

/**
 * WindowsNativeDriver — drives qemu-pebble natively on Windows (no WSL, no bash).
 *
 * Composes an inner NativeDriver with a PLAIN runner: discrete `pebble` commands
 * spawn `pebble.exe` directly (argv, shell:false; Node resolves the `.exe` via
 * PATHEXT). The boot/stop orchestration is injected (Windows tasklist/taskkill +
 * Node fs + net.connect; see winBootDeps). Methods that depend on POSIX-only
 * mechanics are overridden:
 *   - install: winPath() normalization (no /mnt translation).
 *   - ensureTimeShim: false (LD_PRELOAD doesn't exist on Windows; the DLL shim is
 *     a later increment) → timeController uses the legacy utc_offset path.
 *   - setFakeTime: no-op (no shim) — legacy time is driven by setTzOffset.
 *   - setTzOffset: shell-free python-helper argv (best-effort, never throws).
 */
export class WindowsNativeDriver implements BackendDriver {
  private readonly inner: NativeDriver;

  constructor(private readonly deps: WindowsNativeDriverDeps) {
    // The inner NativeDriver builds VNC-agnostic `pebble` commands (cmd "pebble").
    // We wrap its runner so every such command is rewritten to the bundled
    // invocation (python + run_tool() + runtime env). Non-pebble commands (e.g.
    // the python time-helper argv) pass through untouched. Per-command env (e.g.
    // installCmd's PEBBLE_EMULATOR) is merged over the bundled env.
    const run: Runner = deps.pebble
      ? (cmd, args, env) => {
          if (cmd !== "pebble") return deps.run(cmd, args, env);
          const c = deps.pebble!(args);
          return deps.run(c.cmd, c.args, { ...c.env, ...env });
        }
      : deps.run;
    this.inner = new NativeDriver({ run, boot: deps.boot, stop: deps.stop });
  }

  setPlatform(id: PlatformId): void { this.inner.setPlatform(id); }

  async start(id: PlatformId, token?: BootToken, onStep?: OnStep): Promise<VncEndpoint> {
    const ts = this.deps.timeShim;
    if (ts) {
      // Reset the fake-clock control file to real time BEFORE qemu spawns/realizes.
      // A fresh qemu process anchors the fake clock to real time, so "- 1" reads as
      // real — this clears any stale custom/frozen target a prior session left in
      // %TEMP% and keeps the f2xx RTC boot-seed correct while making the runtime
      // absolute System write (timeController.apply) safe across restarts.
      try { await writeWinFakeTime(ts.ctlPath, null, 1); } catch { /* best-effort */ }
      // Truncate qemu's fake-time diagnostic log once per boot so a long session
      // can't grow it without bound (an 11.7 MB pb-qemu-ft.log was seen in the
      // field). Opening in write mode preserves diagnosis for the current boot.
      if (ts.ftLogPath) {
        try { await fs.writeFile(ts.ftLogPath, ""); } catch { /* best-effort */ }
      }
    }
    // qemu-pebble binds to 127.0.0.1 on the Windows host; enforce localhost so
    // callers don't depend on whatever makeWinBootDeps' boot fn returns (mirrors
    // WslDriver, where WSL2 also forwards to the Windows loopback).
    const endpoint = await this.inner.start(id, token, onStep);
    // Pre-warm the persistent input helper now that the emulator is live and the
    // state file holds the pypkjs port. Without this, the helper is spawned lazily
    // on the FIRST button press and the ~300–700ms python-start + connect window
    // swallows those early presses ("takes a few presses to get going"). Best-
    // effort + non-blocking: never delays returning the endpoint.
    this.deps.inputChannel?.warm();
    return { ...endpoint, host: "localhost" };
  }

  async stop(): Promise<void> {
    // Terminate the persistent input helper alongside the emulator so it doesn't
    // linger holding a dead pypkjs connection (the next boot respawns it).
    this.deps.inputChannel?.stop();
    return this.inner.stop();
  }

  /** Quit-path stop. stop()'s killAll probes liveness and offers a graceful
   * `pebble kill` BEFORE the force-kill — under load those bounded steps can add
   * up past before-quit's exit deadline, so the first TerminateProcess would
   * never dispatch and the stack would outlive the app (the historic orphan
   * scenario). Skip the niceties and reap directly: kill sweep first, port
   * settle after. Falls back to stop() when no reaper is wired. */
  async stopFast(): Promise<void> {
    this.deps.inputChannel?.stop();
    if (this.deps.reap) await this.deps.reap();
    else await this.inner.stop();
  }

  /** Reap orphaned emulator processes left by a prior session (startup self-heal).
   * Delegates to the injected reaper; a no-op when none is wired. */
  async reap(): Promise<void> {
    await this.deps.reap?.();
  }

  async install(pbwPath: string): Promise<void> {
    return this.inner.install(winPath(pbwPath));
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> {
    // Fast path: write one line to the persistent helper (~0ms) instead of
    // spawning a fresh `pebble emu-button` per press. The helper sends the same
    // QemuButton relay packet. Map ButtonAction → helper verb: press=click
    // (down+up), hold=hold (down only), release=release.
    const ch = this.deps.inputChannel;
    if (ch) {
      const verb = action === "release" ? "release" : action === "hold" ? `hold ${id}` : `click ${id}`;
      if (ch.send(verb)) return;
    }
    return this.inner.button(id, action);
  }

  async accelTap(): Promise<void> {
    if (this.deps.inputChannel?.send("tap x+")) return;
    return this.inner.accelTap();
  }
  async setTime(value: string, opts?: { utc?: boolean }): Promise<void> { return this.inner.setTime(value, opts); }

  async setTzOffset(offsetMin: number, tzName?: string): Promise<void> {
    const h = this.deps.timeHelper;
    if (!h) return; // legacy time unavailable until python/helper are provisioned
    const c = winSetTzOffsetArgv({ pythonExe: h.pythonExe, helperPath: h.helperPath, offsetMin, tzName });
    try {
      // Bound the bare helper (no coreutils `timeout`, unlike POSIX): a dead pypkjs
      // bridge would otherwise hang forever and strand the caller's in-flight latch.
      const r = await (this.deps.run as TimedRunner)(c.cmd, c.args, c.env, TZ_PUSH_TIMEOUT_MS);
      if (r.code !== 0) console.warn(`[time] win setTzOffset(${offsetMin}) exit ${r.code}: ${r.stderr || r.stdout}`);
    } catch (e) {
      // spawnRunner rejects on the child's `error` event (missing / AV-quarantined
      // interpreter). Degrade silently — this method is documented never to throw.
      console.warn(`[time] win setTzOffset(${offsetMin}) failed to spawn: ${String(e)}`);
    }
  }

  // Custom time is built into the bundled qemu-pebble.exe: the Pebble RTC reads the
  // control file (PEBBLE_FAKETIME_FILE, set in createDriver) directly, applying a
  // fake base + freeze/rate — the in-qemu analog of the Linux LD_PRELOAD shim.
  // It's therefore ALWAYS available (no DLL injection / self-test / AV concern):
  // ensureTimeShim just reports ready, and setFakeTime writes the control file the
  // emulator reads — connection-free, the entire custom/freeze/rate mechanism.
  async ensureTimeShim(): Promise<boolean> {
    return this.deps.timeShim ? true : false;
  }
  async setFakeTime(targetUnix: number | null, rate: number): Promise<void> {
    const ts = this.deps.timeShim;
    if (!ts) return; // no control file wired — no-op
    await writeWinFakeTime(ts.ctlPath, targetUnix, rate);
  }

  async timeFormat(hour24: boolean): Promise<void> { return this.inner.timeFormat(hour24); }
  async bluetooth(connected: boolean): Promise<void> { return this.inner.bluetooth(connected); }
  async battery(percent: number, charging: boolean): Promise<void> {
    // Retry past the first-boot bridge-readiness race (see BATTERY_PUSH_* above):
    // emu-battery's connect can time out for a few seconds after "Live" while the
    // pypkjs bridge/watch handshake settles, exactly as health activation does.
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastErr: unknown;
    for (let attempt = 0; attempt < BATTERY_PUSH_MAX_ATTEMPTS; attempt++) {
      try {
        await this.inner.battery(percent, charging);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < BATTERY_PUSH_MAX_ATTEMPTS - 1) await sleep(BATTERY_PUSH_RETRY_MS);
      }
    }
    // Keep the raw cause for the logs, but never surface the libpebble2 traceback
    // to the user — the SettingsPane shows the thrown message verbatim.
    console.warn(`[battery] push failed after ${BATTERY_PUSH_MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
    throw new Error("Couldn't reach the watch — it may still be starting up. Try setting the battery again in a moment.");
  }

  async activateHealth(): Promise<HealthActivateResult> {
    const h = this.deps.timeHelper;
    if (!h) return { ok: false, status: null, detail: "python helper not provisioned" };
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // Re-deploy the helper once (cheap; self-repairs a stale/corrupt copy), mirroring
    // how the POSIX path re-echoes its base64 helper.
    const helperPath = h.helperPath.replace(/[^\\/]+$/, "pb-activate-health.py");
    try {
      await fs.writeFile(helperPath, cli.activateHealthHelperSource());
    } catch (e) {
      return { ok: false, status: null, detail: String(e) };
    }
    // The helper reads the emulator state file; on native Windows it lives at
    // %TEMP%\pb-emulator.json (NOT the helper's /tmp default → C:\tmp, which is
    // absent and threw FileNotFoundError, so health never activated).
    const c = cli.winActivateHealthArgv(h.pythonExe, helperPath, winHostPaths().emuInfo);
    // Retry past the readiness race (state file / pypkjs websocket lagging "Live").
    // See HEALTH_ACTIVATE_* + healthRetryDecision above.
    let last: HealthActivateResult = { ok: false, status: null, detail: "not attempted" };
    for (let attempt = 0; attempt < HEALTH_ACTIVATE_MAX_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      let status: number | null = null;
      try {
        const r = await this.deps.run(c.cmd, c.args, c.env);
        status = cli.parseHealthStatus(r.stdout);
        last = { ok: status === 1, status, detail: (r.stdout || r.stderr || "").trim() };
      } catch (e) {
        status = null;
        last = { ok: false, status: null, detail: String(e) };
      }
      if (healthRetryDecision(status, Date.now() - t0) === "done") return last;
      if (attempt < HEALTH_ACTIVATE_MAX_ATTEMPTS - 1) await sleep(HEALTH_ACTIVATE_RETRY_MS);
    }
    return last;
  }
  // winPath canonicalizes backslash/forward-slash; outPath is already a Windows
  // path (app-constructed), so this is a no-op slash normalization kept for
  // symmetry with install.
  async screenshot(outPath: string): Promise<void> { return this.inner.screenshot(winPath(outPath)); }
  // Backlight-free framebuffer grab via the persistent input helper's pypkjs
  // socket. Delegates to the input channel when wired; false (caller falls back
  // to the canvas grab) when absent or the channel is unavailable. Never throws.
  async screenshotFramebuffer(outPath: string): Promise<boolean> {
    const ch = this.deps.inputChannel;
    if (!ch) return false;
    return ch.screenshot(winPath(outPath)).catch(() => false);
  }
  async wipe(): Promise<void> { return this.inner.wipe(); }
  async timelineQuickView(on: boolean): Promise<void> { return this.inner.timelineQuickView(on); }

  async insertSamplePin(pinTimeUnix: number, title: string): Promise<void> {
    const ch = this.deps.inputChannel;
    if (!ch) throw new Error("input channel unavailable — cannot insert sample pin");
    const ok = await ch.insertPin(SAMPLE_PIN_ID, pinTimeUnix, title);
    if (!ok) throw new Error("failed to insert sample pin");
  }

  async deleteSamplePin(): Promise<void> {
    // Best-effort: nothing to remove if the channel is gone (emulator stopped).
    await this.deps.inputChannel?.deletePin(SAMPLE_PIN_ID);
  }

  /** Create a QEMU snapshot bundle for the board after a cold boot reached Live.
   * Fire-and-forget + never throws (the hook itself is failure-swallowing); a
   * no-op when no snapshot hook is wired (snapshots disabled). */
  async createSnapshotAfterLive(board: PlatformId, isCancelled?: () => boolean): Promise<void> {
    await this.deps.snapshotCreate?.(board, isCancelled);
  }

  streamLogs(id: PlatformId, onLine: (line: string) => void): AppLogHandle | null {
    // Preferred (#6): ride the persistent input helper's shared pypkjs
    // connection — no second bridge client, so installs need no log pause and
    // the stream can run by default. Falls back to the `pebble logs` process
    // when the channel isn't up (e.g. helper died and nothing respawned it yet).
    const viaChannel = this.deps.inputChannel?.streamAppLogs(onLine) ?? null;
    if (viaChannel) return { kill: viaChannel.kill, viaChannel: true };
    const spawnFn = this.deps.logSpawn ?? spawnLineStream;
    // --vnc is REQUIRED: a `--emulator` command without it makes pebble-tool
    // SIGKILL the running VNC qemu and respawn a non-VNC one (see withVnc in
    // NativeDriver), which tore down the live emulator the instant log capture
    // started — the v3.0.2-test1 boot-crash loop ("reason: pid" every ~4s).
    if (this.deps.pebble) {
      const c = this.deps.pebble(["logs", "--emulator", id, "--vnc"]);
      return spawnFn(c.cmd, c.args, c.env, onLine);
    }
    return spawnFn("pebble", ["logs", "--emulator", id, "--vnc"], undefined, onLine);
  }
}
