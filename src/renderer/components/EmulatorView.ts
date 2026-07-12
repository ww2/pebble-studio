import type { PlatformId, ButtonId } from "../../shared/types.js";
import { getChrome } from "../chrome/chromeRegistry.js";
import { getPlatform } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import { connectVnc, type VncHandle } from "../vncClient.js";
import { loadBindings, resolveAction, type Bindings } from "../keybindings.js";
import type { TimeConfig } from "../../main/backend/timeController.js";
import { SessionLog } from "../sessionLog.js";
import { applySunlightLut } from "../sunlightLut.js";
import {
  shouldRunLiveSunlight,
  LIVE_SUNLIGHT_KEY,
  LIVE_SUNLIGHT_EVENT,
  hideCanvasForSunlightOverlay,
  restoreCanvasFromSunlightOverlay,
} from "../liveSunlight.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/** Format hours/minutes as 12h "h:mm AM/PM" (default) or 24h "HH:MM". */
function fmtHM(h: number, m: number, hour24: boolean): string {
  const mm = String(m).padStart(2, "0");
  if (hour24) return `${String(h).padStart(2, "0")}:${mm}`;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ap}`;
}

/** Best-effort short message from an unknown thrown value (for the session log). */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const DIAGNOSTICS_KEY = "pebble-studio:diagnostics";
/** When "true", auto-reboot the emulator on a bridge crash (SettingsPane writes this). */
const AUTO_RELAUNCH_KEY = "pebble-studio:auto-relaunch";
const EMU_LOGS_KEY = "pebble-studio:emu-logs";
const EMU_LOGS_EVENT = "pebble-studio:emu-logs-changed";
const EMU_LOGS_CAP = 2000; // mirror the main-side AppLogStream cap
/**
 * How the main-page "Backlight" button wakes the screen (SettingsPane writes
 * this). "back" = a Back-button press (reliable wake, can navigate inside an
 * app); "shake" = an accelerometer nudge (like a real Pebble's motion trigger,
 * won't navigate). Default "back".
 */
const BACKLIGHT_ACTIVATION_KEY = "pebble-studio:backlight-activation";

/** The two ways the Backlight button can wake the screen. */
export type BacklightActivation = "shake" | "back";

/** Emulator lifecycle state for the live preview. */
export type EmuState = "stopped" | "booting" | "live" | "stopping" | "unresponsive";

/**
 * Map the persisted backlight-activation setting to a concrete action. Only the
 * exact string "shake" selects the motion nudge; everything else (null, unknown,
 * legacy values) falls back to the safe default "back". Pure + unit-tested.
 */
export function backlightActivationFromSetting(raw: string | null): BacklightActivation {
  return raw === "shake" ? "shake" : "back";
}

/**
 * Decide whether reconnectAfterClear should actually rewire the VNC canvas.
 * Pure + unit-tested.
 *   - Always need a current platform (nothing to reconnect to otherwise).
 *   - If WE drove the reboot externally (weather refresh), bridge-dead was
 *     suppressed for its duration, so `state` stayed "live" and we reconnect
 *     regardless of the exact state — guarding against a stray transition that
 *     would otherwise leave the canvas black.
 *   - Otherwise (the "Clear emulator" path) only reconnect a live/unresponsive
 *     emulator; a stopped/booting one is mid-lifecycle and owns its own canvas.
 */
export function shouldReconnectAfterReboot(
  wasExternalReboot: boolean,
  state: EmuState,
  hasCurrentPlatform: boolean,
): boolean {
  if (!hasCurrentPlatform) return false;
  if (wasExternalReboot) return true;
  return state === "live" || state === "unresponsive";
}

/**
 * Decide whether a `show()` call is a redundant re-selection of the board that is
 * already the active one, and therefore a no-op (no teardown, no reboot). True
 * only when the requested platform matches the current one AND that emulator is
 * either already `live` or has a boot in flight (`booting`) — re-selecting it
 * would otherwise force-close a perfectly good backend, or fire a duplicate boot.
 * A `stopped`/`stopping`/`unresponsive` same-board select is NOT skipped: those
 * are relaunch/recovery requests that must fall through to the normal boot path.
 * (Only model-selection and startup call `show()`; explicit Relaunch/retry and
 * the weather-apply reboot drive `boot()`/`reconnectAfterClear()` directly, so
 * they are never suppressed by this guard.)
 */
export function shouldSkipReselect(
  currentPlatform: PlatformId | null,
  requestedPlatform: PlatformId,
  state: EmuState,
): boolean {
  if (currentPlatform !== requestedPlatform) return false;
  return state === "live" || state === "booting";
}

/**
 * Decide which action-button GROUPS should draw their leading divider, given each
 * group's vertical offset (offsetTop). A divider sits BETWEEN two groups, so it's
 * only wanted when a group shares a row with the one before it. The first group
 * never has a leading divider; any group that wrapped onto a new row (its top
 * differs from the previous group's) drops its divider since it's now at a row
 * start. Pure + unit-tested; the DOM caller toggles a class from this result.
 */
export function actionDividerFlags(groupTops: number[]): boolean[] {
  return groupTops.map((top, i) => i > 0 && top === groupTops[i - 1]);
}
/**
 * Max consecutive auto-relaunches before falling back to the manual "Relaunch"
 * button. The bridge crash is an upstream pypkjs fragility (see
 * bridge-crash-root-cause): if it dies again and again within a short window we
 * stop auto-rebooting so the app can't thrash in a relaunch loop.
 */
const AUTO_RELAUNCH_CAP = 2;
/**
 * If the emulator stays live this long after an auto-relaunch, the run counts as
 * "recovered" and the consecutive-crash budget resets — so an occasional crash
 * hours apart always gets a fresh set of auto-recovery attempts.
 */
const AUTO_RELAUNCH_HEALTHY_MS = 45_000;

/**
 * Width of the `.emu-frame` casing border (px). The frame is `box-sizing:
 * border-box` with a 1px border (app.css `.emu-frame { border: 1px ... }`), so a
 * model-switch's settled frame size is `bodyWidth + 2*frame-pad + 2*border`.
 */
const FRAME_BORDER_PX = 1;

/**
 * Pure Fit-scale math (extracted so it's unit-testable and timing-independent):
 * the largest uniform scale that fits a natural-size frame into the available
 * box, clamped to [0.25, 6]. Returns 0 for non-positive inputs (caller bails).
 *
 * Kept side-effect-free and DOM-free on purpose — `applyFitScale` does the
 * measuring and feeds the numbers here. The clamp ceiling (6) matches the
 * historical Fit cap.
 */
export function fitScale(
  availW: number,
  availH: number,
  naturalW: number,
  naturalH: number,
): number {
  if (availW <= 0 || availH <= 0 || naturalW <= 0 || naturalH <= 0) return 0;
  return Math.max(0.25, Math.min(availW / naturalW, availH / naturalH, 6));
}

/**
 * The renderer's StudioApi (declared in main.ts, owned by Wave 2b) doesn't yet
 * list the v0.0.6 boot-progress channel that the preload exposes. Until Wave 2b
 * extends that interface, narrow `window.studio` to the extra method at the call
 * site via this typed accessor — no change to main.ts required.
 */
interface BootProgressApi {
  onBootProgress(cb: (msg: string) => void): () => void;
  onBridgeDead(cb: (reason: string) => void): () => void;
}
function studioBootProgress(): BootProgressApi {
  return window.studio as unknown as BootProgressApi;
}

type ZoomLevel = "1" | "1.5" | "2" | "3" | "fit";
const ZOOM_KEY = "pebble-studio:emu-zoom";

type BezelColor = "black" | "white";
const SCREEN_BEZEL_KEY = "pebble-studio:screen-bezel";
/** Concrete --screen-bezel-color values for the round-only black/white toggle. */
const BEZEL_COLORS: Record<BezelColor, string> = { black: "#0a0a0a", white: "#f5f5f5" };

/**
 * Emulator panel: a watch "stage" hosting the live noVNC display, an overlay of
 * the four physical buttons (mapped from chromeRegistry geometry), plus tap/shake
 * accelerometer action buttons.
 *
 * D1: Fully stops the current emulator before switching platforms.
 * D2: Relaunch + Force-close lifecycle buttons.
 * C2: Zoom / resize control (1×, 1.5×, 2×, 3×).
 */
export class EmulatorView {
  readonly el: HTMLElement;
  private readonly screenHost: HTMLElement;
  private readonly buttonsOverlay: HTMLElement;
  private readonly status: HTMLElement;
  /** Badge surfacing a non-system time config (frozen/accelerated/non-host-tz/custom). */
  private readonly timeBadge: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly relaunchBtn: HTMLButtonElement;
  private readonly forceCloseBtn: HTMLButtonElement;
  private readonly tapBtn: HTMLButtonElement;
  private readonly shakeBtn: HTMLButtonElement;
  private readonly timelineBtn: HTMLButtonElement;
  private readonly backlightBtn: HTMLButtonElement;
  private timelinePeek = false;
  private readonly frameWrapper: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly switchOverlay: HTMLElement;
  private readonly bezelToggle: HTMLElement;
  /** The four persistent button nubs, created once so model-switch morphs animate. */
  private readonly buttonEls: HTMLButtonElement[] = [];
  /** Current zoom level; "fit" engages the ResizeObserver-driven auto-fit. */
  private zoom: ZoomLevel = "1";
  /** Observer used only while zoom === "fit"; disconnected otherwise. */
  private fitObserver: ResizeObserver | null = null;
  /** The element the fit observer is currently watching (column once attached). */
  private fitObserverTarget: Element | null = null;
  /** The action-button row; watched so group dividers update when buttons wrap. */
  private readonly actionsRow: HTMLElement;
  /** The logical button groups (Tap/Shake, Timeline/Backlight, Relaunch/Force-close). */
  private readonly actionGroups: HTMLElement[];
  /** Always-on observer: recomputes which groups draw a divider as the row wraps. */
  private actionsObserver: ResizeObserver | null = null;
  /** Selected screen-bezel color (B5); persisted, applied to round models. */
  private bezelColor: BezelColor = "black";
  /** True while the current platform is round (gates the bezel toggle + bezel color). */
  private isRound = false;
  private vnc: VncHandle | null = null;
  /** The platform currently running (or last attempted). null = nothing booted yet. */
  private currentPlatform: PlatformId | null = null;
  /**
   * Lifecycle state machine (v0.0.5). `stopped` = chrome idle, Launch shown;
   * `booting` = a start() is in flight; `live` = VNC connected; `stopping` =
   * a stop/abort is in flight. Drives button labels/enablement and gates IPC.
   */
  private state: EmuState = "stopped";
  /**
   * Monotonic boot generation. Each boot captures the current gen; force-close
   * (and each new boot) increments it. A boot's start() goes `live` ONLY if its
   * gen is still current when it resolves — otherwise it bails silently. This is
   * what lets force-close take effect immediately even though a backend start()
   * promise may still be settling.
   */
  private bootGen = 0;
  /**
   * The VNC endpoint returned by the last successful boot's start(). Cached so an
   * external-reboot reconnect (reconnectAfterClear) reuses the real endpoint
   * instead of assuming the backend's pinned host/port (this project has a
   * documented history of port 6080 conflicts). null until the first boot.
   */
  private lastEp: { host: string; port: number; wsPath: string } | null = null;
  /** One-shot guard for the first-load pop-out: the frame-wrapper starts scaled
   * down + transparent so the watch isn't shown at a default size before its
   * geometry is known; the first applyGeometry reveals it (scale→1, opacity→1).
   * The pop is a transform (not a layout change), so it never perturbs fit zoom. */
  private framePopped = false;

  /** Current keyboard bindings (I-runtime); re-read on the change event. */
  private bindings: Bindings = loadBindings();
  /** Bound keydown handler so it can be added/removed against `window`. */
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);
  /** Listeners re-reading bindings / diagnostics flag on Settings changes. */
  private readonly onBindingsChanged = (): void => { this.bindings = loadBindings(); };
  private readonly onDiagnosticsChanged = (): void => {
    this.setDiagnostics(localStorage.getItem(DIAGNOSTICS_KEY) === "on");
  };

  /** Diagnostics overlay (J-runtime): created lazily, surfaces FPS + boot notes. */
  private diagnostics = false;
  /** Whether the diagnostics panel body is expanded. Collapsed by default. */
  private diagExpanded = false;
  /** Collapsible diagnostics panel parts. */
  private readonly diagEl: HTMLElement;
  private readonly diagSummary: HTMLElement;
  private readonly diagBody: HTMLElement;
  private readonly diagLog: HTMLElement;
  private readonly diagToggle: HTMLButtonElement;
  private readonly diagCopyBtn: HTMLButtonElement;
  /** Disposer for the boot-progress subscription (active for diagnostics). */
  private bootProgressDispose: (() => void) | null = null;
  /** Disposer for the bridge-dead subscription (always active). */
  private bridgeDeadDispose: (() => void) | null = null;
  /**
   * Count of externally-driven reboots (the weather-refresh flow, which
   * stops+reboots the emulator entirely in the main process) currently in
   * flight. The renderer's state machine isn't driving those reboots, so the
   * bridge-health monitor will briefly see the emulator vanish and come back.
   * While this is > 0 we suppress the crash / auto-relaunch path so it can't
   * (a) flip the canvas to "unresponsive" mid-refresh or (b) kick off a second,
   * colliding reboot. A COUNT (not a bool) so overlapping applies — e.g. two
   * quick clicks of Apply — stay suppressed until the LAST one settles.
   * Incremented by beginExternalReboot(), decremented by endExternalReboot().
   */
  private externalRebootDepth = 0;
  /** Consecutive auto-relaunches since the last sustained-healthy run (cap guard). */
  private autoRelaunchCount = 0;
  /** Timer that resets autoRelaunchCount once a run has stayed live long enough. */
  private autoRelaunchResetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest boot-progress note (shown in the diag summary when diagnostics on). */
  private lastBootNote = "";
  /**
   * Persistent session log: boot steps + lifecycle markers (Live, crash reason,
   * auto-relaunch) + boot errors, each timestamped. Unlike the old `bootLog` it is
   * NEVER wiped on launch or crash — only on app close or an explicit Clear — so a
   * "loads then crashes" event can be read (and copied) after the fact. Boot ticks
   * for the same phase collapse onto one updating entry (see SessionLog). It records
   * across the whole app session regardless of the diagnostics flag, which only
   * controls visibility — so a crash is captured even before the panel is opened.
   */
  private readonly sessionLog = new SessionLog();
  /** rAF id for the FPS sampler; non-null only while diagnostics on + live. */
  private fpsRaf: number | null = null;
  /** Most recent measured fps (changed-frames-per-second). */
  private fps = 0;
  /** Per-second accumulator: changed-frame count + window-start timestamp. */
  private fpsChanged = 0;
  private fpsWindowStart = 0;
  /** Previous sampled-region signature, to detect canvas changes between frames. */
  private fpsPrevSig = -1;
  /** Tiny offscreen 2D context used to read a sample region of the noVNC canvas. */
  private fpsSampleCtx: CanvasRenderingContext2D | null = null;

  /** Live sunlight overlay (Issue 2): enabled flag, rAF id, and the offscreen
   * native-resolution scratch canvas reused each frame. The visible overlay
   * canvas lives inside #emu-screen and is (re)created on demand. */
  private liveSunlight = localStorage.getItem(LIVE_SUNLIGHT_KEY) === "true";
  private sunlightRaf: number | null = null;
  private sunlightScratch: HTMLCanvasElement | null = null;
  private readonly onLiveSunlightChanged = (): void => {
    this.liveSunlight = localStorage.getItem(LIVE_SUNLIGHT_KEY) === "true";
    this.syncSunlightOverlay();
  };

  /** Issue 3: emulator app-log panel state. Default ON since v3.0.7 (#6): the
   * stream rides the input helper's shared pypkjs connection, so showing logs
   * no longer costs an extra bridge client. */
  private emuLogsEnabled = localStorage.getItem(EMU_LOGS_KEY) !== "false";
  private emuLogsExpanded = false;
  private readonly emuLogLines: string[] = [];
  private appLogDispose: (() => void) | null = null;
  /** Throttle for the collapsed-panel line-count summary (coalesces bursts). */
  private emuLogSummaryThrottle: ReturnType<typeof setTimeout> | null = null;
  /** Guards the one-shot history back-fill so overlapping syncEmuLogsPanel calls
   * can't inject the history twice. Reset when the line buffer is cleared (boot). */
  private emuLogsBackfilled = false;
  private readonly onEmuLogsChanged = (): void => {
    this.emuLogsEnabled = localStorage.getItem(EMU_LOGS_KEY) !== "false";
    // Tell main to start/stop the actual `pebble logs` stream. The stream only runs
    // while this is on, so the default (off) keeps the pypkjs bridge uncontended.
    void window.studio.setLogCapture(this.emuLogsEnabled);
    this.syncEmuLogsPanel();
  };

  /** Last time config received via setTimeBadge; null = hidden. */
  private timeCfg: TimeConfig | null = null;
  /** Interval id for the live-clock ticker in the time badge. */
  private badgeTimer: ReturnType<typeof setInterval> | null = null;
  /** Host timezone string last passed to setTimeBadge (used by the ticker). */
  private hostTz = "";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "emu-panel";
    this.el.innerHTML = `
      <div class="emu-frame-wrapper">
        <div class="emu-frame">
          <div class="emu-buttons" id="emu-buttons"></div>
          <div class="emu-stage" id="emu-stage">
            <div class="emu-screen" id="emu-screen"></div>
          </div>
          <div class="emu-switch-overlay" id="emu-switch-overlay">Switching…</div>
        </div>
      </div>
      <div class="emu-caption" id="emu-caption"></div>
      <div class="emu-actions" id="emu-actions">
        <div class="emu-action-group">
          <button class="emu-action emu-action--subtle" id="emu-tap" type="button">Tap</button>
          <button class="emu-action emu-action--subtle" id="emu-shake" type="button">Shake</button>
        </div>
        <div class="emu-action-group">
          <button class="emu-action emu-action--subtle" id="emu-timeline" type="button" title="Toggle timeline quick view (peek)">Timeline</button>
          <button class="emu-action emu-action--subtle" id="emu-backlight" type="button" title="Wake the backlight (method set in Settings)">Backlight</button>
        </div>
        <div class="emu-action-group">
          <button class="emu-action emu-action--subtle" id="emu-relaunch" type="button" title="Stop and reboot the current platform">Relaunch</button>
          <button class="emu-action emu-action--subtle emu-action--danger" id="emu-force-close" type="button" title="Force-close the emulator">Force-close</button>
        </div>
      </div>
      <div class="emu-zoom-row">
        <span class="emu-zoom-label">Zoom</span>
        <div class="emu-zoom-segmented" id="emu-zoom-seg" role="group" aria-label="Display zoom">
          <button class="emu-zoom-opt" data-zoom="1" type="button">1×</button>
          <button class="emu-zoom-opt" data-zoom="1.5" type="button">1.5×</button>
          <button class="emu-zoom-opt" data-zoom="2" type="button">2×</button>
          <button class="emu-zoom-opt" data-zoom="3" type="button">3×</button>
          <button class="emu-zoom-opt" data-zoom="fit" type="button">Fit</button>
        </div>
        <div class="emu-bezel-toggle" id="emu-bezel-toggle" hidden>
          <span class="emu-bezel-label">Bezel</span>
          <div class="emu-bezel-segmented" id="emu-bezel-seg" role="group" aria-label="Screen bezel color">
            <button class="emu-bezel-opt" data-bezel="black" type="button">Black</button>
            <button class="emu-bezel-opt" data-bezel="white" type="button">White</button>
          </div>
        </div>
      </div>
      <div class="emu-status-row">
        <span class="emu-status" id="emu-status"></span>
      </div>
      <div class="emu-diag" id="emu-diag" hidden>
        <button class="emu-diag-header" id="emu-diag-toggle" type="button" aria-expanded="false" title="Show/hide the diagnostics session log">
          <span class="emu-diag-caret" aria-hidden="true">▸</span>
          <span class="emu-diag-summary" id="emu-diag-summary">Diagnostics</span>
        </button>
        <div class="emu-diag-body" id="emu-diag-body" hidden>
          <pre class="emu-diag-log" id="emu-diag-log"></pre>
          <div class="emu-diag-actions">
            <button class="emu-diag-btn" id="emu-diag-copy" type="button">Copy log</button>
            <button class="emu-diag-btn" id="emu-diag-clear" type="button">Clear</button>
          </div>
        </div>
      </div>
      <div class="emu-diag emu-logs" id="emu-logs" hidden>
        <button class="emu-diag-header" id="emu-logs-toggle" type="button" aria-expanded="false" title="Show/hide the emulator app logs (pebble logs)">
          <span class="emu-diag-caret" aria-hidden="true">▸</span>
          <span class="emu-diag-summary" id="emu-logs-summary">Emulator logs</span>
        </button>
        <div class="emu-diag-body" id="emu-logs-body" hidden>
          <pre class="emu-diag-log" id="emu-logs-log"></pre>
          <div class="emu-diag-actions">
            <button class="emu-diag-btn" id="emu-logs-copy" type="button">Copy log</button>
          </div>
        </div>
      </div>
    `;

    this.screenHost = this.el.querySelector<HTMLElement>("#emu-screen")!;
    this.buttonsOverlay = this.el.querySelector<HTMLElement>("#emu-buttons")!;
    this.status = this.el.querySelector<HTMLElement>("#emu-status")!;
    // Non-system-time badge: lives right after the ● Live status in the zoom-row.
    // Styled by .emu-time-badge (added in a later task); functional/unstyled now.
    const badge = document.createElement("span");
    badge.className = "emu-time-badge";
    badge.hidden = true;
    this.timeBadge = badge;
    this.status.insertAdjacentElement("afterend", badge);
    this.caption = this.el.querySelector<HTMLElement>("#emu-caption")!;
    this.relaunchBtn = this.el.querySelector<HTMLButtonElement>("#emu-relaunch")!;
    this.forceCloseBtn = this.el.querySelector<HTMLButtonElement>("#emu-force-close")!;
    this.frameWrapper = this.el.querySelector<HTMLElement>(".emu-frame-wrapper")!;
    this.frame = this.el.querySelector<HTMLElement>(".emu-frame")!;
    this.stage = this.el.querySelector<HTMLElement>("#emu-stage")!;
    // First-load pop-out: start the whole device shrunk + hidden so the screen +
    // button nubs don't flash at a default size before the first model's geometry
    // is applied. The pop is a TRANSFORM on the frame-wrapper (not a layout-size
    // change), so it never perturbs the fit-zoom measurement (which reads the
    // frame's offsetWidth — unaffected by transforms). The first applyGeometry()
    // reveals it (scale→1, opacity→1). transform-origin matches the zoom origin.
    this.frameWrapper.style.transformOrigin = "center top";
    this.frameWrapper.style.transform = "scale(0.25)";
    this.frameWrapper.style.opacity = "0";
    this.switchOverlay = this.el.querySelector<HTMLElement>("#emu-switch-overlay")!;
    this.bezelToggle = this.el.querySelector<HTMLElement>("#emu-bezel-toggle")!;
    this.diagEl = this.el.querySelector<HTMLElement>("#emu-diag")!;
    this.diagSummary = this.el.querySelector<HTMLElement>("#emu-diag-summary")!;
    this.diagBody = this.el.querySelector<HTMLElement>("#emu-diag-body")!;
    this.diagLog = this.el.querySelector<HTMLElement>("#emu-diag-log")!;
    this.diagToggle = this.el.querySelector<HTMLButtonElement>("#emu-diag-toggle")!;
    this.diagCopyBtn = this.el.querySelector<HTMLButtonElement>("#emu-diag-copy")!;
    this.diagToggle.addEventListener("click", () => this.setDiagExpanded(!this.diagExpanded));
    this.diagCopyBtn.addEventListener("click", () => void this.copySessionLog());
    this.el.querySelector<HTMLButtonElement>("#emu-diag-clear")!
      .addEventListener("click", () => {
        this.sessionLog.clear();
        this.renderDiag();
      });

    const logsToggle = this.el.querySelector<HTMLButtonElement>("#emu-logs-toggle")!;
    const logsCopy = this.el.querySelector<HTMLButtonElement>("#emu-logs-copy")!;
    logsToggle.addEventListener("click", () => this.setEmuLogsExpanded(!this.emuLogsExpanded));
    logsCopy.addEventListener("click", () => void this.copyEmuLog());
    window.addEventListener(EMU_LOGS_EVENT, this.onEmuLogsChanged);
    // Always subscribe to live lines (cheap); the panel visibility is separate.
    this.appLogDispose = window.studio.onAppLog((line) => {
      this.emuLogLines.push(line);
      const overflow = this.emuLogLines.length - EMU_LOGS_CAP;
      if (overflow > 0) this.emuLogLines.splice(0, overflow);
      if (this.emuLogsEnabled && this.emuLogsExpanded) this.renderEmuLog();
      // Keep the collapsed header's "· N lines" count live as lines stream in —
      // it's the "is anything happening?" affordance. Throttled so a burst of
      // lines doesn't thrash layout (renderEmuLog already refreshes it when open).
      else if (this.emuLogsEnabled) this.scheduleEmuLogSummary();
    });
    // Push the persisted toggle state to main so the stream's on/off matches the UI
    // from the first boot (main defaults to off until told otherwise).
    void window.studio.setLogCapture(this.emuLogsEnabled);
    this.syncEmuLogsPanel();

    // Create the four physical button nubs ONCE. They persist across model
    // switches; applyGeometry only toggles the square/round classes so CSS can
    // animate their positions (morph). Order matters only for DOM stacking.
    this.createButtons();

    // Tap / Shake — no-op unless the emulator is live (don't fire IPC at a dead one).
    const tapBtn = this.el.querySelector<HTMLButtonElement>("#emu-tap")!;
    const shakeBtn = this.el.querySelector<HTMLButtonElement>("#emu-shake")!;
    this.tapBtn = tapBtn;
    this.shakeBtn = shakeBtn;
    this.timelineBtn = this.el.querySelector<HTMLButtonElement>("#emu-timeline")!;
    tapBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      void window.studio.accelTap();
    });
    shakeBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      void window.studio.accelTap();
      // Re-check live before the delayed second tap: the emulator may have stopped
      // within 120ms, and firing IPC at a dead backend is a no-op at best.
      setTimeout(() => { if (this.state === "live") void window.studio.accelTap(); }, 120);
    });
    this.timelineBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      const next = !this.timelinePeek;
      // Optimistic toggle for instant feedback; confirm or revert on the result.
      this.timelinePeek = next;
      this.timelineBtn.classList.toggle("emu-action--on", next);
      window.studio.timelineQuickView(next)
        .then(() => {
          // Guard the async status write: a Relaunch/Force-close between the click
          // and this resolution must keep its "Stopping…"/"Stopped" — don't clobber.
          if (this.state !== "live") return;
          this.status.textContent = next ? "Timeline peek on — sample pin added" : "Timeline peek off";
        })
        .catch((e: unknown) => {
          // Roll back the optimistic toggle and surface why — but only while still
          // live, so a lifecycle status (Stopping…/Stopped) isn't overwritten.
          this.timelinePeek = !next;
          this.timelineBtn.classList.toggle("emu-action--on", !next);
          if (this.state !== "live") return;
          this.status.textContent = `Timeline peek failed: ${e instanceof Error ? e.message : String(e)}`;
        });
    });
    // Backlight — wake the screen once. The activation method (Back-button press
    // vs accelerometer shake) is chosen in Settings; we read it fresh on each
    // click so a change applies immediately. Both routes reuse existing IPC.
    this.backlightBtn = this.el.querySelector<HTMLButtonElement>("#emu-backlight")!;
    this.backlightBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      const how = backlightActivationFromSetting(localStorage.getItem(BACKLIGHT_ACTIVATION_KEY));
      if (how === "shake") void window.studio.accelTap();
      else void window.studio.button("back");
    });

    // Group dividers: each logical group wraps as a unit (CSS), and the row
    // centers when it wraps. The 1px divider between groups is drawn as a
    // zero-layout ::before on each follower group, so toggling it never changes
    // wrapping (no oscillation). syncActionDividers() decides which groups are
    // row-followers and shows their divider; an always-on ResizeObserver re-runs
    // it as the window/row width changes.
    this.actionsRow = this.el.querySelector<HTMLElement>("#emu-actions")!;
    this.actionGroups = Array.from(this.actionsRow.querySelectorAll<HTMLElement>(".emu-action-group"));
    this.actionsObserver = new ResizeObserver(() => this.syncActionDividers());
    this.actionsObserver.observe(this.actionsRow);
    this.syncActionDividers();

    // Lifecycle buttons. The single Launch/Relaunch button routes to relaunch()
    // when live and launch() otherwise.
    this.relaunchBtn.addEventListener("click", () => {
      if (this.state === "live" || this.state === "unresponsive") void this.relaunch();
      else void this.launch();
    });
    this.forceCloseBtn.addEventListener("click", () => void this.forceClose());

    // Zoom segmented control
    const zoomSeg = this.el.querySelector<HTMLElement>("#emu-zoom-seg")!;
    zoomSeg.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".emu-zoom-opt");
      if (!btn) return;
      const z = btn.dataset.zoom as ZoomLevel | undefined;
      if (z) this.applyZoom(z);
    });

    // B5: screen-bezel color toggle (shown only for round models).
    const bezelSeg = this.el.querySelector<HTMLElement>("#emu-bezel-seg")!;
    bezelSeg.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".emu-bezel-opt");
      if (!btn) return;
      const c = btn.dataset.bezel as BezelColor | undefined;
      if (c) this.applyScreenBezelColor(c);
    });

    // Restore saved bezel color (default black) before applying any platform.
    const savedBezel = localStorage.getItem(SCREEN_BEZEL_KEY);
    this.bezelColor = savedBezel === "white" ? "white" : "black";
    this.applyScreenBezelColor(this.bezelColor);

    // Restore saved zoom
    const savedZoom = this.normalizeZoom(localStorage.getItem(ZOOM_KEY));
    this.applyZoom(savedZoom);

    // I-runtime: keyboard shortcuts (only fire when live). Bound to window so a
    // press anywhere drives the emulator; re-read bindings on the change event.
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("pebble-studio:keybindings-changed", this.onBindingsChanged);

    // J-runtime: diagnostics overlay. Restore the persisted flag; re-read on the
    // change event so the Settings toggle (Wave 2b) reflects live.
    window.addEventListener("pebble-studio:diagnostics-changed", this.onDiagnosticsChanged);
    // Issue 2: live sunlight overlay. Re-read the setting and restart/stop the
    // overlay loop whenever the toggle in Settings changes.
    window.addEventListener(LIVE_SUNLIGHT_EVENT, this.onLiveSunlightChanged);
    // Record boot-progress into the persistent session log for the WHOLE app
    // session — NOT just while diagnostics is visible — so a "loads then crashes"
    // event is captured even if the panel was never opened. The diagnostics flag
    // only controls visibility (and the costly FPS sampler) below.
    this.bootProgressDispose = studioBootProgress().onBootProgress((msg) => {
      this.lastBootNote = msg;
      this.sessionLog.appendBootStep(msg);
      if (this.diagnostics) this.renderDiag();
    });
    this.setDiagnostics(localStorage.getItem(DIAGNOSTICS_KEY) === "on");

    // H4: subscribe to bridge-dead notifications from the main-process health
    // monitor. Only transition when live — ignore if already stopping/booting.
    this.bridgeDeadDispose = studioBootProgress().onBridgeDead((reason) => {
      // An external reboot (weather refresh) is tearing the emulator down and
      // back up in the main process; the monitor naturally sees it disappear.
      // Ignore — that flow owns the lifecycle and reconnects when it's done.
      if (this.externalRebootDepth > 0) return;
      if (this.state !== "live") return;
      // A run just ended — cancel the pending "recovered" reset so a crash
      // before the healthy window elapses still counts toward the cap.
      this.clearAutoRelaunchResetTimer();
      // Record the crash in the persistent session log (this is the event that was
      // invisible before — the watch "loaded then crashed" and the log was empty).
      this.logEvent("crash", `⚠ Emulator stopped responding (reason: ${reason})`);

      const autoEnabled = localStorage.getItem(AUTO_RELAUNCH_KEY) === "true";
      if (autoEnabled && this.autoRelaunchCount < AUTO_RELAUNCH_CAP) {
        this.autoRelaunchCount++;
        this.logEvent("relaunch", `↻ Auto-relaunch (${this.autoRelaunchCount}/${AUTO_RELAUNCH_CAP})`);
        console.warn(
          "[emu] bridge-dead (reason:", reason, ") — auto-relaunching",
          `(${this.autoRelaunchCount}/${AUTO_RELAUNCH_CAP})`,
        );
        this.disconnectVnc();
        this.status.textContent = `⚠ Emulator crashed — reconnecting… (${this.autoRelaunchCount}/${AUTO_RELAUNCH_CAP})`;
        this.status.classList.remove("emu-status--live");
        this.status.classList.add("emu-status--dead");
        // relaunch() runs from "unresponsive"; it stops + reboots + reinstalls.
        this.state = "unresponsive";
        this.updateLifecycleButtons();
        void this.relaunch({ auto: true });
        return;
      }

      // Auto-relaunch off, or the cap is exhausted → surface the manual recovery.
      console.warn(
        "[emu] bridge-dead (reason:", reason, ") — entering unresponsive",
        autoEnabled ? "(auto-relaunch cap reached)" : "(auto-relaunch off)",
      );
      this.state = "unresponsive";
      this.disconnectVnc();
      this.status.textContent = autoEnabled
        ? "⚠ Emulator keeps crashing — Relaunch"
        : "⚠ Emulator stopped responding — Relaunch";
      this.status.classList.remove("emu-status--live");
      this.status.classList.add("emu-status--dead");
      this.updateLifecycleButtons();
    });

    // Start disabled until something is running
    this.updateLifecycleButtons();
  }

  /**
   * I-runtime: map a key press to an emulator action and fire it — only when the
   * emulator is `live`. Ignores keys typed into form controls/contentEditable and
   * any chord with a modifier (ctrl/alt/meta) so app shortcuts aren't hijacked.
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (this.state !== "live") return;
    // A modal (e.g. the What's New / changelog dialog) owns the keyboard while
    // open — don't let a key press leak through and drive the watch behind it.
    if (document.querySelector(".cl-overlay")) return;
    // Any modifier chord (incl. Shift) belongs to app shortcuts, not the emulator —
    // Shift+ArrowUp must not drive the watch's Up button.
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t.isContentEditable) return;
    }
    const action = resolveAction(e.key, this.bindings);
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case "back":
      case "up":
      case "select":
      case "down":
        this.flashButton(action);
        void window.studio.button(action);
        break;
      case "tap":
        void window.studio.accelTap();
        break;
      case "shake":
        // Mirror the Shake button: a double-tap. Re-check live before the delayed
        // second tap so it doesn't fire IPC at an emulator stopped within 120ms.
        void window.studio.accelTap();
        setTimeout(() => { if (this.state === "live") void window.studio.accelTap(); }, 120);
        break;
      case "light":
        void window.studio.backlightPulse();
        break;
      case "screenshot":
        // Drive the Capture bar via a window event so the shortcut works even when
        // the Capture pane isn't the visible inspector. (Event name mirrored in
        // CaptureBar.) Only reached when live (guarded above).
        window.dispatchEvent(new Event("pebble-studio:capture-screenshot"));
        break;
      case "record":
        window.dispatchEvent(new Event("pebble-studio:capture-record"));
        break;
    }
  }

  /** Per-button flash timers, so a held key (keydown auto-repeat) keeps the nub
   * lit instead of flickering — each repeat re-arms the same timer. */
  private readonly flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 4c: briefly light the on-screen watch button for a keyboard-driven press,
   * since key presses (unlike mouse clicks) never trigger the :active style. */
  private flashButton(id: ButtonId): void {
    const el = this.buttonEls.find((b) => b.dataset.button === id);
    if (!el) return;
    el.classList.add("emu-hit--pressed");
    const prev = this.flashTimers.get(id);
    if (prev) clearTimeout(prev);
    this.flashTimers.set(id, setTimeout(() => {
      el.classList.remove("emu-hit--pressed");
      this.flashTimers.delete(id);
    }, 140));
  }

  /** Coerce a stored zoom string to a valid ZoomLevel, defaulting to "1". */
  private normalizeZoom(raw: string | null): ZoomLevel {
    return raw === "1.5" || raw === "2" || raw === "3" || raw === "fit" ? raw : "1";
  }

  /** Apply zoom level to the frame wrapper and persist choice. */
  private applyZoom(z: ZoomLevel): void {
    this.zoom = z;
    // Update active state + persist the selection (incl. "fit").
    const seg = this.el.querySelector<HTMLElement>("#emu-zoom-seg")!;
    seg.querySelectorAll<HTMLButtonElement>(".emu-zoom-opt").forEach((btn) => {
      btn.classList.toggle("emu-zoom-opt--active", btn.dataset.zoom === z);
      btn.setAttribute("aria-pressed", String(btn.dataset.zoom === z));
    });
    localStorage.setItem(ZOOM_KEY, z);

    if (z === "fit") {
      // C3: re-fit on container resize; compute once now (guards zero-size).
      this.ensureFitObserver();
      this.applyFitScale();
    } else {
      this.disconnectFitObserver();
      this.setScale(parseFloat(z));
    }
  }

  /** Apply a concrete numeric scale to the frame + reserve wrapper height. */
  private setScale(scale: number): void {
    this.frame.style.transform = scale === 1 ? "" : `scale(${scale})`;
    this.frame.style.transformOrigin = "center top";
    // Reserve layout space so scaled frame doesn't bleed over other panels.
    this.frameWrapper.style.setProperty("--zoom-scale", String(scale));
  }

  /**
   * A (v0.0.6 — Fit actually adapts to window size): scale the watch to fill the
   * available STAGE COLUMN, not the panel. The panel (`this.el`) is centered in
   * `.stage-col` with `place-items:center`, so it shrinks to its content — a
   * panel-relative measurement gives avail ≈ natural → scale stuck ≈ 1.5. Instead
   * we measure the panel's PARENT (`.stage-col`, the real available box), then:
   *   availW = stage-col width  − panel horizontal padding
   *   availH = stage-col height − (non-frame rows: caption + actions + zoom +
   *            diag) − panel vertical padding − the inter-row gaps
   * and fit the NATURAL (unscaled) frame into that box. This grows the watch in a
   * large window and shrinks it (keeping the rows on-screen) in a small one. The
   * row heights are included in the budget so the zoom row is never cut off.
   */
  private applyFitScale(naturalOverride?: { w: number; h: number }): void {
    const col = this.el.parentElement; // .stage-col (place-items:center container)
    if (!col) return;
    // If the observer was created before the panel was attached, it may be
    // watching the panel as a fallback — retarget it to the column now.
    if (this.fitObserver && this.fitObserverTarget !== col) {
      this.fitObserver.disconnect();
      this.fitObserver.observe(col);
      this.fitObserverTarget = col;
    }
    const colW = col.clientWidth;
    const colH = col.clientHeight;
    if (colW <= 0 || colH <= 0) return; // not laid out yet — observer will retry

    // Subtract the panel's own padding (horizontal from width, vertical from
    // height) so the watch + its rows fit inside the panel box.
    const panelCs = getComputedStyle(this.el);
    const padX = parseFloat(panelCs.paddingLeft) + parseFloat(panelCs.paddingRight);
    const padY = parseFloat(panelCs.paddingTop) + parseFloat(panelCs.paddingBottom);
    const gap = parseFloat(panelCs.rowGap || panelCs.gap) || 0;

    // Height needed by every non-frame row (caption, actions, zoom, diag) plus
    // the flex gaps between all rows — reserve it so those rows stay visible.
    let rowsH = 0;
    const children = Array.from(this.el.children) as HTMLElement[];
    for (const child of children) {
      if (child === this.frameWrapper) continue;
      if (child.offsetParent === null && child.hidden) continue; // skip hidden rows
      rowsH += child.offsetHeight;
    }
    // One gap between each adjacent pair of (visible) children.
    const visibleCount = children.filter(
      (c) => !(c.offsetParent === null && c.hidden),
    ).length;
    const gapsH = gap * Math.max(0, visibleCount - 1);

    const availW = colW - padX;
    const availH = colH - padY - rowsH - gapsH;
    if (availW <= 0 || availH <= 0) return;

    // Natural (unscaled) frame size. Two sources:
    //  - naturalOverride: the SETTLED target size, computed from known chrome
    //    values by applyGeometry. Used on a model switch because the stage/frame
    //    are mid-morph (a 420ms CSS width/height/padding transition), so reading
    //    offset* here would return the OLD model's transient size and over-scale
    //    (worst on aplite→gabbro). Passing the target removes the timing race.
    //  - otherwise (window-resize via the ResizeObserver, or numeric→Fit): the
    //    geometry is already settled, so measure the live frame. Clear the
    //    transform first so offset* reflects the unscaled size, not the prior scale.
    let naturalW: number;
    let naturalH: number;
    if (naturalOverride) {
      naturalW = naturalOverride.w;
      naturalH = naturalOverride.h;
    } else {
      const prev = this.frame.style.transform;
      this.frame.style.transform = "";
      naturalW = this.frame.offsetWidth;
      naturalH = this.frame.offsetHeight;
      this.frame.style.transform = prev;
    }
    const scale = fitScale(availW, availH, naturalW, naturalH);
    if (scale <= 0) return; // not measurable yet
    this.setScale(scale);
  }

  /** Lazily create the fit ResizeObserver (only used while zoom === "fit"). */
  private ensureFitObserver(): void {
    if (this.fitObserver) return;
    this.fitObserver = new ResizeObserver(() => {
      if (this.zoom === "fit") this.applyFitScale();
    });
    // Observe the STAGE COLUMN (the panel's parent), not the inner wrapper or the
    // panel itself — that's the box that grows/shrinks with the window, so Fit
    // re-fits live after the window is resized.
    const target = this.el.parentElement ?? this.el;
    this.fitObserver.observe(target);
    this.fitObserverTarget = target;
  }

  /** Disconnect/ignore the fit observer when a non-fit zoom is selected. */
  private disconnectFitObserver(): void {
    if (this.fitObserver) {
      this.fitObserver.disconnect();
      this.fitObserver = null;
      this.fitObserverTarget = null;
    }
  }

  /**
   * Recompute which action groups draw their leading divider. A divider is only
   * wanted between two groups on the SAME row, so we read each group's offsetTop
   * and let actionDividerFlags() (pure, tested) decide; a group that has wrapped
   * to a new row drops its divider. Dividers are zero-layout ::before elements,
   * so toggling `has-divider` never re-triggers wrapping.
   */
  private syncActionDividers(): void {
    const flags = actionDividerFlags(this.actionGroups.map((g) => g.offsetTop));
    this.actionGroups.forEach((g, i) => g.classList.toggle("has-divider", flags[i]));
  }

  /**
   * B5 (v0.0.5): apply the SCREEN-bezel color (the dark area inside the stage,
   * between the live screen and the stage edge) by setting `--screen-bezel-color`
   * on `.emu-stage`. Persisted so it survives relaunch and re-applies when
   * switching back to a round model. Only exposed/meaningful for round frames.
   */
  private applyScreenBezelColor(c: BezelColor): void {
    this.bezelColor = c;
    this.stage.style.setProperty("--screen-bezel-color", BEZEL_COLORS[c]);
    const seg = this.el.querySelector<HTMLElement>("#emu-bezel-seg")!;
    seg.querySelectorAll<HTMLButtonElement>(".emu-bezel-opt").forEach((btn) => {
      btn.classList.toggle("emu-bezel-opt--active", btn.dataset.bezel === c);
      btn.setAttribute("aria-pressed", String(btn.dataset.bezel === c));
    });
    localStorage.setItem(SCREEN_BEZEL_KEY, c);
  }

  /**
   * Reflect the lifecycle state on the buttons:
   *  - Launch/Relaunch: label is "Relaunch" when live, "Launch" otherwise;
   *    enabled iff (stopped && a platform is selected) || live — disabled while
   *    booting/stopping so it can't be spammed.
   *  - Force-close: enabled while booting or live (something to cancel).
   *  - Tap/Shake + the four nubs: disabled unless live (no IPC at a dead emu).
   */
  private updateLifecycleButtons(): void {
    const s = this.state;
    // "Relaunch" label for live or unresponsive; "Launch" otherwise.
    this.relaunchBtn.textContent = (s === "live" || s === "unresponsive") ? "Relaunch" : "Launch";
    this.relaunchBtn.disabled = !((s === "stopped" && this.currentPlatform) || s === "live" || s === "unresponsive");
    // Force-close enabled while booting, live, or unresponsive (something to kill).
    this.forceCloseBtn.disabled = !(s === "booting" || s === "live" || s === "unresponsive");

    // Attention highlight on Relaunch only in unresponsive; clear for all other states.
    if (s === "unresponsive") {
      this.relaunchBtn.classList.add("emu-action--attn");
    } else {
      this.relaunchBtn.classList.remove("emu-action--attn");
    }

    const liveActions = s === "live";
    this.tapBtn.disabled = !liveActions;
    this.shakeBtn.disabled = !liveActions;
    this.timelineBtn.disabled = !liveActions;
    this.backlightBtn.disabled = !liveActions;
    for (const el of this.buttonEls) el.disabled = !liveActions;

    // J-runtime: the FPS sampler only runs while diagnostics on AND live.
    this.syncFpsSampler();
    // Issue 2: the live sunlight overlay only runs while the setting is on AND live.
    this.syncSunlightOverlay();
  }

  /** E: remove the launch-failure highlight ring from the Launch button. */
  private clearLaunchAttn(): void {
    this.relaunchBtn.classList.remove("emu-action--attn");
  }

  /** Reset the timeline quick-view toggle to off (called on any teardown from live). */
  private resetTimelinePeek(): void {
    this.timelinePeek = false;
    this.timelineBtn.classList.remove("emu-action--on");
  }

  /**
   * Reflect the current time config in the non-system-time badge. Hidden for a
   * plain System / 1x / host-tz config; otherwise shows the custom date+time (for
   * a custom anchor) or a compact summary of divergence (frozen/accelerated/non-home-tz)
   * plus a live system-clock readout updated every 10 s. Driven by the
   * `pebble-studio:time-changed` window event (wired in main.ts).
   */
  setTimeBadge(cfg: TimeConfig | null, hostTz: string): void {
    this.timeCfg = cfg;
    this.hostTz = hostTz;
    this.renderTimeBadge();
    // Safety guard: a time-config change (system or custom) must never disturb
    // the live indicator. Re-assert the green "● Live" status/class iff live, so
    // the requirement holds even if some other path were to perturb it. Only the
    // separate badge element should reflect time config — never `this.status`.
    if (this.state === "live") {
      this.status.textContent = "● Live";
      this.status.classList.remove("emu-status--dead");
      this.status.classList.add("emu-status--live");
    }
  }

  private renderTimeBadge(): void {
    const cfg = this.timeCfg;
    if (!cfg) { this.hideTimeBadge(); return; }
    const parts: string[] = [];
    if (cfg.source === "custom") {
      const d = new Date(cfg.customWallMs); // UTC-naive → read via getUTC*
      const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()} ` +
        fmtHM(d.getUTCHours(), d.getUTCMinutes(), cfg.hour24);
      const icon = cfg.rate === "frozen" ? "❄" : cfg.rate !== "1x" ? `⏩ ${cfg.rate}` : "🕒";
      parts.push(`${icon} ${label}`);
    } else if (cfg.rate !== "1x" || cfg.timezone !== this.hostTz) {
      if (cfg.rate === "frozen") parts.push("❄");
      else if (cfg.rate !== "1x") parts.push(`⏩ ${cfg.rate}`);
      if (cfg.timezone !== this.hostTz) parts.push(`🌐 ${cfg.timezone.split("/").pop()?.replace(/_/g, " ") ?? cfg.timezone}`);
    }
    if (parts.length === 0) { this.hideTimeBadge(); return; }
    const now = new Date();
    parts.push(`sys ${fmtHM(now.getHours(), now.getMinutes(), cfg.hour24)}`);
    this.timeBadge.textContent = parts.join(" · ");
    this.timeBadge.hidden = false;
    this.startBadgeTicker();
  }

  private startBadgeTicker(): void {
    if (this.badgeTimer) return;
    this.badgeTimer = setInterval(() => this.renderTimeBadge(), 10_000);
  }

  private hideTimeBadge(): void {
    if (this.badgeTimer) { clearInterval(this.badgeTimer); this.badgeTimer = null; }
    this.timeBadge.hidden = true;
  }

  /**
   * J-runtime: toggle the diagnostics overlay (FPS + boot notes). Public so
   * main.ts/Settings can flip it live; also driven by the
   * `pebble-studio:diagnostics-changed` window event. When off, the overlay is
   * hidden, the rAF FPS sampler is stopped (zero overhead), and boot-progress
   * notes are dropped.
   */
  setDiagnostics(on: boolean): void {
    this.diagnostics = on;
    this.diagEl.hidden = !on;
    // Recording is permanent (subscribed in the constructor) — diagnostics only
    // controls visibility and the costly FPS sampler.
    if (on) this.renderDiag();
    this.syncFpsSampler();
  }

  /** Expand/collapse the diagnostics panel body (collapsed by default). */
  private setDiagExpanded(expanded: boolean): void {
    this.diagExpanded = expanded;
    this.diagBody.hidden = !expanded;
    this.diagToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const caret = this.diagToggle.querySelector(".emu-diag-caret");
    if (caret) caret.textContent = expanded ? "▾" : "▸";
    if (expanded) this.renderDiag();
    // Toggling the diag body resizes a sibling inside `.stage-col`, not the
    // column's own box, so the fit ResizeObserver doesn't fire. Recompute "fit"
    // here so collapsing restores the full fit scale (was stuck small until a
    // window resize).
    if (this.zoom === "fit") this.applyFitScale();
  }

  /**
   * Record a discrete lifecycle/event entry (Live, crash reason, auto-relaunch,
   * boot error) into the persistent session log. Never collapses; re-renders the
   * panel if it's visible. Recording happens regardless of the diagnostics flag.
   */
  private logEvent(kind: "live" | "crash" | "relaunch" | "error" | "info", text: string): void {
    this.sessionLog.append(kind, text);
    if (this.diagnostics) this.renderDiag();
  }

  /**
   * Render the collapsible diagnostics panel: a one-line summary (always visible —
   * `~fps · N log lines · <latest note>`) plus, when expanded, the full timestamped
   * session log. Cheap; called on each fps tick and on every log change.
   */
  private renderDiag(): void {
    if (!this.diagnostics) return;
    const n = this.sessionLog.size;
    const summary = `~${this.fps} fps · ${n} log ${n === 1 ? "line" : "lines"}`;
    this.diagSummary.textContent = this.lastBootNote
      ? `${summary} · ${this.lastBootNote.split(" · ")[0]}`
      : summary;
    if (this.diagExpanded) {
      this.diagLog.textContent = this.sessionLog.toText() || "(empty)";
      // Keep the newest entries in view as the log grows.
      this.diagLog.scrollTop = this.diagLog.scrollHeight;
    }
  }

  /**
   * Copy text to the clipboard, returning whether it succeeded. `navigator.
   * clipboard.writeText` needs the `clipboard-write` permission, which the app's
   * blanket permission-check deny (main/index.ts — hardening for untrusted Clay
   * pages) refuses, so it rejects here. We fall back to a hidden-textarea
   * `execCommand("copy")`, which runs on the click's user gesture and doesn't go
   * through the permission system. Shared by both copy buttons.
   */
  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  /** Copy the full session log to the clipboard, with brief button feedback. */
  private async copySessionLog(): Promise<void> {
    const ok = await this.writeClipboard(this.sessionLog.toText());
    const btn = this.diagCopyBtn;
    const prev = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }

  /** Show/hide the emulator-logs panel per the setting; back-fill from history
   * the first time it is shown so the user sees prior lines retroactively. */
  private syncEmuLogsPanel(): void {
    const el = this.el.querySelector<HTMLElement>("#emu-logs")!;
    el.hidden = !this.emuLogsEnabled;
    if (this.emuLogsEnabled && !this.emuLogsBackfilled && this.emuLogLines.length === 0) {
      this.emuLogsBackfilled = true; // set optimistically so a second sync can't re-query
      void window.studio.getAppLogHistory().then((lines) => {
        // Live lines can stream in (via onAppLog) between this query being issued
        // and it resolving. The old `length === 0` recheck then dropped the whole
        // history; instead PREPEND the (older) history in front of any live lines
        // so nothing is lost, then re-apply the cap.
        if (lines.length > 0) {
          this.emuLogLines.unshift(...lines);
          const overflow = this.emuLogLines.length - EMU_LOGS_CAP;
          if (overflow > 0) this.emuLogLines.splice(0, overflow);
        }
        if (this.emuLogsExpanded) this.renderEmuLog();
        this.renderEmuLogSummary();
      });
    }
    this.renderEmuLogSummary();
    if (this.zoom === "fit") this.applyFitScale();
  }

  /** Refresh the collapsed emu-logs line-count summary at most ~every 250ms. */
  private scheduleEmuLogSummary(): void {
    if (this.emuLogSummaryThrottle !== null) return;
    this.emuLogSummaryThrottle = setTimeout(() => {
      this.emuLogSummaryThrottle = null;
      this.renderEmuLogSummary();
    }, 250);
  }

  private setEmuLogsExpanded(expanded: boolean): void {
    this.emuLogsExpanded = expanded;
    const body = this.el.querySelector<HTMLElement>("#emu-logs-body")!;
    const toggle = this.el.querySelector<HTMLButtonElement>("#emu-logs-toggle")!;
    body.hidden = !expanded;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const caret = toggle.querySelector(".emu-diag-caret");
    if (caret) caret.textContent = expanded ? "▾" : "▸";
    if (expanded) this.renderEmuLog();
    if (this.zoom === "fit") this.applyFitScale(); // sibling resize; observer won't fire
  }

  private renderEmuLogSummary(): void {
    const n = this.emuLogLines.length;
    const summary = this.el.querySelector<HTMLElement>("#emu-logs-summary")!;
    summary.textContent = `Emulator logs · ${n} ${n === 1 ? "line" : "lines"}`;
  }

  private renderEmuLog(): void {
    const pre = this.el.querySelector<HTMLElement>("#emu-logs-log")!;
    pre.textContent = this.emuLogLines.join("\n") || "(no logs yet)";
    pre.scrollTop = pre.scrollHeight;
    this.renderEmuLogSummary();
  }

  private async copyEmuLog(): Promise<void> {
    const ok = await this.writeClipboard(this.emuLogLines.join("\n"));
    const btn = this.el.querySelector<HTMLButtonElement>("#emu-logs-copy")!;
    const prev = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }

  /**
   * J-runtime: start/stop the rAF FPS sampler so it runs ONLY while diagnostics
   * is on and the emulator is live (no overhead otherwise). Each frame we read a
   * small region of the noVNC canvas, hash it, and compare to the previous frame;
   * the count of CHANGED frames over a 1s window is the "~fps" (QEMU VNC only
   * pushes on change, so this is a best-effort liveness rate, not vsync).
   */
  private syncFpsSampler(): void {
    const shouldRun = this.diagnostics && this.state === "live";
    if (shouldRun && this.fpsRaf === null) {
      this.fpsChanged = 0;
      this.fpsWindowStart = performance.now();
      this.fpsPrevSig = -1;
      this.fpsRaf = requestAnimationFrame(this.sampleFps);
    } else if (!shouldRun && this.fpsRaf !== null) {
      cancelAnimationFrame(this.fpsRaf);
      this.fpsRaf = null;
      this.fps = 0;
    }
  }

  /** One rAF tick of the FPS sampler (bound; re-schedules itself while running). */
  private readonly sampleFps = (now: number): void => {
    if (!this.diagnostics || this.state !== "live") {
      this.fpsRaf = null;
      return;
    }
    const sig = this.sampleCanvasSignature();
    if (sig !== null && sig !== this.fpsPrevSig) {
      this.fpsChanged++;
      this.fpsPrevSig = sig;
    }
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = this.fpsChanged;
      this.fpsChanged = 0;
      this.fpsWindowStart = now;
      this.renderDiag();
    }
    this.fpsRaf = requestAnimationFrame(this.sampleFps);
  };

  /**
   * Read a small region of the noVNC canvas and reduce it to a cheap integer
   * signature for frame-change detection. Returns null if no canvas is present
   * yet. Uses a tiny reusable offscreen 2D context (drawImage-downscale) so it's
   * a fixed, small per-frame cost regardless of screen size.
   */
  private sampleCanvasSignature(): number | null {
    // Exclude #emu-sunlight — it's the overlay we write, not the noVNC source.
    const canvas = this.findVncCanvas();
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
    // 32×32 (was 8×8): a coarse 8×8 downscale averages small updates — a single
    // ticking digit or a few-pixel animation step — into unchanged cells, so the
    // hash misses them and "~fps" under-reads. A finer grid registers those
    // changes and still costs ~1k pixels per tick (negligible).
    const N = 32;
    if (!this.fpsSampleCtx) {
      const off = document.createElement("canvas");
      off.width = N;
      off.height = N;
      this.fpsSampleCtx = off.getContext("2d", { willReadFrequently: true });
    }
    const ctx = this.fpsSampleCtx;
    if (!ctx) return null;
    try {
      ctx.drawImage(canvas, 0, 0, N, N);
      const data = ctx.getImageData(0, 0, N, N).data;
      // FNV-1a-ish hash over the downscaled pixels.
      let h = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 4) {
        h ^= data[i] + (data[i + 1] << 3) + (data[i + 2] << 6);
        h = Math.imul(h, 0x01000193);
      }
      return h | 0;
    } catch {
      // Cross-origin/tainted canvas (shouldn't happen for noVNC) → bail.
      return null;
    }
  }

  /**
   * Issue 2: start/stop the live sunlight overlay. Runs ONLY when the setting is
   * on AND the emulator is live (mirrors syncFpsSampler — zero cost otherwise).
   * The overlay canvas re-draws the noVNC canvas through applySunlightLut every
   * frame, so it is pixel-identical to the screenshot/GIF correction. It lives
   * inside #emu-screen (the scaled .emu-frame), so it inherits the zoom transform.
   */
  private syncSunlightOverlay(): void {
    const run = shouldRunLiveSunlight(this.state, this.liveSunlight);
    if (run && this.sunlightRaf === null) {
      this.sunlightRaf = requestAnimationFrame(this.drawSunlightFrame);
    } else if (!run && this.sunlightRaf !== null) {
      cancelAnimationFrame(this.sunlightRaf);
      this.sunlightRaf = null;
      this.teardownSunlightOverlay();
    }
  }

  /** Remove the overlay canvas and un-hide the noVNC canvas. The overlay is
   * REMOVED (not just `hidden`): `.emu-screen canvas { display: block }` outranks
   * the `[hidden]` attribute, so hiding it left the last corrected frame frozen on
   * top of the live (still-updating) noVNC canvas. drawSunlightFrame re-creates the
   * overlay on demand when correction is re-enabled. */
  private teardownSunlightOverlay(): void {
    const overlay = this.screenHost.querySelector<HTMLCanvasElement>("#emu-sunlight");
    if (overlay) overlay.remove();
    const vncCanvas = this.findVncCanvas();
    if (vncCanvas) restoreCanvasFromSunlightOverlay(vncCanvas);
  }

  /** The noVNC-rendered canvas (the overlay canvas is excluded by id). */
  private findVncCanvas(): HTMLCanvasElement | null {
    const all = Array.from(this.screenHost.querySelectorAll("canvas"));
    return (all.find((c) => c.id !== "emu-sunlight") as HTMLCanvasElement) ?? null;
  }

  /** One rAF tick: correct the noVNC frame onto the overlay. Re-schedules itself. */
  private readonly drawSunlightFrame = (): void => {
    if (!shouldRunLiveSunlight(this.state, this.liveSunlight)) { this.sunlightRaf = null; return; }
    const src = this.findVncCanvas();
    let overlay = this.screenHost.querySelector<HTMLCanvasElement>("#emu-sunlight");
    if (!overlay) {
      overlay = document.createElement("canvas");
      overlay.id = "emu-sunlight";
      overlay.className = "emu-sunlight";
      this.screenHost.appendChild(overlay);
    }
    if (src && src.width > 0 && src.height > 0) {
      const w = src.width, h = src.height;
      if (overlay.width !== w) overlay.width = w;
      if (overlay.height !== h) overlay.height = h;
      if (!this.sunlightScratch) this.sunlightScratch = document.createElement("canvas");
      const scratch = this.sunlightScratch;
      if (scratch.width !== w) scratch.width = w;
      if (scratch.height !== h) scratch.height = h;
      const sctx = scratch.getContext("2d", { willReadFrequently: true });
      const octx = overlay.getContext("2d");
      if (sctx && octx) {
        try {
          sctx.drawImage(src, 0, 0);
          const img = sctx.getImageData(0, 0, w, h);
          applySunlightLut(img.data as unknown as Uint8Array);
          octx.putImageData(img, 0, 0);
          // Show the corrected overlay instead of the raw frame, but keep the
          // source canvas hit-testable so noVNC still receives touch/click input
          // (the overlay is pointer-events:none and events fall through to it).
          hideCanvasForSunlightOverlay(src);
        } catch { /* tainted/transient — skip this frame */ }
      }
    }
    this.sunlightRaf = requestAnimationFrame(this.drawSunlightFrame);
  };

  /**
   * Morph to a new platform's chrome WITHOUT booting. Used by manual mode (both
   * startup and model switches): apply the new geometry, leave the emulator
   * stopped, and show "Launch". Any live VNC is torn down first.
   */
  loadChrome(platformId: PlatformId): void {
    // A new boot generation invalidates any in-flight boot from a prior model.
    this.bootGen++;
    this.currentPlatform = platformId;
    this.disconnectVnc();
    this.beginSwitch();
    this.applyGeometry(platformId);
    this.state = "stopped";
    this.status.textContent = "Ready";
    this.status.classList.remove("emu-status--live");
    this.status.classList.remove("emu-status--dead");
    this.updateLifecycleButtons();
  }

  /**
   * Boot a platform: capture a fresh boot generation, morph to its geometry, and
   * start the backend. When start() resolves, connect VNC and go `live` ONLY if
   * this boot's gen is still current — otherwise a force-close (or a newer boot)
   * superseded us, so bail silently without touching state. Assumes any previous
   * emulator is already stopped (the caller handles that).
   */
  private async boot(platformId: PlatformId): Promise<void> {
    const info = getPlatform(platformId);
    const gen = ++this.bootGen;

    this.state = "booting";
    this.emuLogLines.length = 0;
    this.emuLogsBackfilled = false; // fresh boot → allow a re-backfill if re-shown
    if (this.emuLogsEnabled && this.emuLogsExpanded) this.renderEmuLog();
    this.currentPlatform = platformId;
    // The session log is NOT wiped on boot (it persists across launch/crash so a
    // crash can be inspected after the fact) — just mark the start of this attempt.
    this.logEvent("info", `▶ Booting ${info.label}`);
    this.clearLaunchAttn(); // E: a new attempt clears any prior failure highlight
    this.disconnectVnc();
    this.beginSwitch();
    this.applyGeometry(platformId);
    this.status.textContent = `Booting ${info.label}…`;
    this.status.classList.remove("emu-status--live");
    this.status.classList.remove("emu-status--dead");
    this.updateLifecycleButtons();

    let ep;
    try {
      ep = await window.studio.start(platformId);
    } catch (err) {
      // start() failed or was aborted. Only react if we're still the current
      // boot; otherwise a force-close/newer boot owns the state now.
      if (gen !== this.bootGen) return;
      this.state = "stopped";
      this.status.textContent = `Failed to start ${info.label}`;
      this.status.classList.remove("emu-status--live");
      this.status.classList.remove("emu-status--dead");
      // E: draw the eye to the Launch button with an accent/danger glow ring.
      this.relaunchBtn.classList.add("emu-action--attn");
      console.error("[emu] start failed", err);
      this.logEvent("error", `✖ Failed to start ${info.label}: ${errText(err)}`);
      this.updateLifecycleButtons();
      return;
    }

    // Superseded while start() was settling (force-close or another boot) — bail
    // silently; the owner of the new gen already drives the UI.
    if (gen !== this.bootGen) return;

    this.state = "live";
    this.clearLaunchAttn(); // E: success clears the failure highlight
    this.status.textContent = "● Live";
    this.status.classList.remove("emu-status--dead");
    this.status.classList.add("emu-status--live");
    this.lastEp = ep as { host: string; port: number; wsPath: string };
    this.vnc = connectVnc(this.screenHost, this.lastEp, info.touch);
    this.updateLifecycleButtons();
    // Fit was computed during applyGeometry() while the boot-time rows (status
    // "Booting…", etc.) were transient, which over-subtracted their height and
    // over-scaled the watch — and the column ResizeObserver won't fire for row
    // changes. Re-fit now that we're "● Live" and the rows have settled. No-op
    // unless Fit is the active zoom.
    if (this.zoom === "fit") {
      requestAnimationFrame(() => { if (this.zoom === "fit") this.applyFitScale(); });
    }
    // If this boot followed an auto-relaunch, give it a chance to prove healthy:
    // staying live past AUTO_RELAUNCH_HEALTHY_MS resets the consecutive-crash
    // budget (a crash before then keeps counting, capping a thrash loop).
    this.armAutoRelaunchReset();
    // Boot succeeded — mark it in the session log (NOT cleared; the boot steps stay
    // so a "loads then crashes" sequence shows the boot + the crash together).
    this.logEvent("live", "● Live");

    // Install library apps FIRST so the user's watchface appears on screen as
    // soon as possible after "Live" — `pebble install` launches the app it pushes.
    // Health activation used to run BEFORE this and AWAIT a retry loop of up to
    // ~10s, which delayed the watchface (and let its bridge traffic crowd out the
    // install's auto-launch, so the watch sat on the launcher and the user had to
    // open the watchface by hand). Health is a system-level BlobDB pref that needs
    // no app installed, so it can safely follow the install and run in the
    // background without blocking the watchface.
    try {
      await window.studio.libInstallAll();
    } catch (err) {
      console.error("[emu] libInstallAll failed", err);
    }
    // The loaded-app set just changed — tell the App Library to refresh its
    // "N loaded" count + pills (it only otherwise refreshes on a drop/pick).
    window.dispatchEvent(new Event("pebble-studio:apps-changed"));

    // Activate Pebble Health in the BACKGROUND (not awaited) so it never delays
    // the watchface. The modern boards (emery/gabbro/flint) ALSO need this runtime
    // activation — modern PebbleOS ships Health tracking OFF by default
    // (ACTIVITY_DEFAULT_PREFERENCES.tracking_enabled = false), so the Health app
    // shows "Enable Pebble Health" until we insert the activityPreferences pref.
    // They always activate; the "Activate Pebble Health on boot" toggle only
    // governs the legacy boards.
    const MODERN_HEALTH_BOARDS = new Set<PlatformId>(["emery", "gabbro", "flint"]);
    const healthOnBoot =
      (this.currentPlatform != null && MODERN_HEALTH_BOARDS.has(this.currentPlatform)) ||
      localStorage.getItem("pebble-studio:health-activate-on-boot") !== "false";
    if (healthOnBoot) void this.activateHealthOnBoot(gen);
  }

  /**
   * Idempotently activate Pebble Health after a boot, retrying until it lands.
   * Runs in the BACKGROUND (callers must NOT await it) so it never delays the
   * watchface. `window.studio.activateHealth()` already retries internally with a
   * fast, early-exit loop (~3s worst case per call); a single bridge-not-ready
   * miss can still happen on a slow boot, so we make a few spaced attempts. Bails
   * the moment the boot is superseded (force-close / relaunch) so a stale boot
   * never writes to the new emulator.
   */
  private async activateHealthOnBoot(gen: number): Promise<void> {
    const HEALTH_BOOT_ATTEMPTS = 4;
    const HEALTH_BOOT_RETRY_MS = 1500;
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < HEALTH_BOOT_ATTEMPTS; attempt++) {
      if (gen !== this.bootGen || this.state !== "live") return; // superseded — stop
      try {
        const r = await window.studio.activateHealth();
        lastStatus = r.status;
        if (r.ok) {
          this.logEvent("live", "● Pebble Health activated");
          return;
        }
      } catch (e) {
        console.warn("[health] activate failed", e);
      }
      if (attempt < HEALTH_BOOT_ATTEMPTS - 1) {
        await new Promise<void>((res) => setTimeout(res, HEALTH_BOOT_RETRY_MS));
      }
    }
    if (gen !== this.bootGen) return;
    if (lastStatus != null) this.logEvent("info", `Pebble Health activation returned status ${lastStatus}`);
    else this.logEvent("info", "Pebble Health: activation not confirmed (bridge never became ready)");
  }

  /** Whether the emulator is currently live (VNC connected). Injected into
   * AppLibrary so it can queue installs instead of hitting a dead emulator. */
  isLive(): boolean {
    return this.state === "live";
  }

  /**
   * Launch: boot the currently-selected platform. Only valid from `stopped` with
   * a platform selected; ignored otherwise (spam/re-entrancy guard).
   */
  async launch(): Promise<void> {
    if (this.state !== "stopped" || !this.currentPlatform) return;
    await this.boot(this.currentPlatform);
  }

  /**
   * Arm (or re-arm) the healthy-stretch timer: if no auto-relaunches are pending
   * (count 0) there is nothing to reset, so skip. Otherwise schedule a reset of
   * the consecutive-crash budget once the run has stayed live long enough.
   */
  private armAutoRelaunchReset(): void {
    this.clearAutoRelaunchResetTimer();
    if (this.autoRelaunchCount === 0) return;
    this.autoRelaunchResetTimer = setTimeout(() => {
      this.autoRelaunchResetTimer = null;
      this.autoRelaunchCount = 0;
    }, AUTO_RELAUNCH_HEALTHY_MS);
  }

  /** Cancel any pending healthy-stretch reset. */
  private clearAutoRelaunchResetTimer(): void {
    if (this.autoRelaunchResetTimer !== null) {
      clearTimeout(this.autoRelaunchResetTimer);
      this.autoRelaunchResetTimer = null;
    }
  }

  /**
   * Relaunch: stop the current emulator then boot the same platform. Only when
   * live or unresponsive. `auto` distinguishes an automatic crash-recovery
   * relaunch (keeps the consecutive-crash count) from a user-initiated one (a
   * deliberate click is a fresh start, so the count resets).
   */
  async relaunch(opts?: { auto?: boolean }): Promise<void> {
    if ((this.state !== "live" && this.state !== "unresponsive") || !this.currentPlatform) return;
    if (!opts?.auto) {
      this.autoRelaunchCount = 0; // manual relaunch → fresh recovery budget
      this.clearAutoRelaunchResetTimer();
    }
    const id = this.currentPlatform;
    // Capture the boot generation up front so a force-close during the "Stopping…"
    // phase (which bumps bootGen) cancels the reboot: boot() re-captures the
    // generation on entry, so without this guard the awaited stop() would always be
    // followed by an un-cancellable boot of the emulator the user just killed.
    const gen = this.bootGen;
    this.resetTimelinePeek();
    this.state = "stopping";
    this.disconnectVnc();
    this.status.textContent = "Stopping…";
    this.status.classList.remove("emu-status--live");
    this.status.classList.remove("emu-status--dead");
    this.updateLifecycleButtons();
    try {
      await window.studio.stop();
    } catch (err) {
      console.warn("[emu] stop() during relaunch failed (ignored):", err);
    }
    // A force-close (or another boot) superseded this relaunch while stop() was in
    // flight — abandon the reboot; the new owner already drives the UI/backend.
    if (gen !== this.bootGen) return;
    // Backend cleared "loaded" on stop — clear the pills now; the reboot's
    // libInstallAll will repopulate them once the apps re-install.
    window.dispatchEvent(new Event("pebble-studio:apps-changed"));
    await this.boot(id);
  }

  /**
   * Force-close: the override. Allowed from booting/live/stopping (no-op when
   * already stopped). Increments bootGen so any in-flight boot bails when its
   * start() finally settles, then aborts + stops the backend (ignoring errors)
   * and returns to a stopped idle state. Works even mid-boot/mid-relaunch — it
   * is the interrupt that reaps hung processes.
   */
  async forceClose(): Promise<void> {
    if (this.state === "stopped") return;
    this.resetTimelinePeek();
    // A deliberate force-close ends any crash-recovery cycle — reset the budget.
    this.autoRelaunchCount = 0;
    this.clearAutoRelaunchResetTimer();
    this.bootGen++; // invalidate any in-flight boot
    this.state = "stopping";
    this.status.textContent = "Stopping…";
    this.status.classList.remove("emu-status--live");
    this.status.classList.remove("emu-status--dead");
    this.updateLifecycleButtons();
    try {
      await window.studio.abort();
    } catch (err) {
      console.warn("[emu] abort() during force-close failed (ignored):", err);
    }
    try {
      await window.studio.stop();
    } catch (err) {
      console.warn("[emu] stop() during force-close failed (ignored):", err);
    }
    this.disconnectVnc();
    this.state = "stopped";
    this.status.textContent = "Stopped";
    this.status.classList.remove("emu-status--live");
    this.status.classList.remove("emu-status--dead");
    this.updateLifecycleButtons();
    // The backend cleared its "loaded" set in teardown — refresh the App Library
    // so the "● loaded" pills disappear now that nothing is running.
    window.dispatchEvent(new Event("pebble-studio:apps-changed"));
  }

  /** Disconnect VNC without stopping the backend. */
  private disconnectVnc(): void {
    if (this.vnc) {
      this.vnc.disconnect();
      this.vnc = null;
    }
    this.screenHost.innerHTML = "";
  }

  /**
   * v0.0.5 morph — Enter the "switching" state WITHOUT collapsing to a neutral
   * box: the old frame/stage/buttons stay in place and CSS transitions animate
   * them to the new geometry once applyGeometry() runs. We only blank the live
   * screen (it's torn down / re-booting anyway) so old + new pixels never overlap;
   * the shape/size/button morph itself is the transition. The four button nubs
   * are persistent (never rebuilt), so toggling their classes in applyGeometry
   * slides them to their new positions.
   */
  private beginSwitch(): void {
    this.frame.classList.add("emu-frame--switching");
    this.caption.textContent = "";
    this.screenHost.innerHTML = "";
  }

  /**
   * A4 — Apply the NEW watch's geometry as a single grouped mutation, then reveal
   * the frame + buttons + screen together by leaving the switching state.
   */
  private applyGeometry(platformId: PlatformId): void {
    const info = getPlatform(platformId);
    const chrome = getChrome(platformId);

    this.isRound = info.round;
    this.caption.textContent = `${info.label} · ${info.width}×${info.height}`;
    this.frame.classList.toggle("emu-frame--round", info.round);

    // Size the stage to the chrome body so the button overlay aligns.
    this.stage.style.width = `${chrome.bodyWidth}px`;
    this.stage.style.height = `${chrome.bodyHeight}px`;

    // Reserve layout space in the wrapper for the scaled frame.
    this.frameWrapper.style.setProperty("--stage-height", `${chrome.bodyHeight + 2 * 16}px`);

    // Position the screen host within the stage. For round devices the screen is
    // centered in the (square) stage; for square devices the registry offset is used.
    if (info.round) {
      Object.assign(this.screenHost.style, {
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: `${chrome.screen.width}px`,
        height: `${chrome.screen.height}px`,
      });
    } else {
      Object.assign(this.screenHost.style, {
        left: `${chrome.screen.x}px`,
        top: `${chrome.screen.y}px`,
        transform: "none",
        width: `${chrome.screen.width}px`,
        height: `${chrome.screen.height}px`,
      });
    }
    this.screenHost.classList.toggle("emu-screen--round", info.round);

    // Morph: toggle the round class on the PERSISTENT button overlay so the four
    // nubs animate (via CSS transitions) from their old positions to the new ones
    // rather than being rebuilt. (renderButtons is not called per-switch anymore.)
    this.buttonsOverlay.classList.toggle("emu-buttons--round", info.round);

    // C (v0.0.6): place round Up/Down ON the case circle with their LONG (tall)
    // edge TANGENT to the rim. The CSS .emu-buttons--round rules put them in the
    // empty corner outside the case; we override with a JS-computed inline
    // transform here (and CLEAR it for square so the CSS classes take over).
    this.applyRoundUpDownPlacement(info.round, chrome.bodyWidth);

    // B (v0.0.6): square models are black-only. Force the SCREEN bezel to black
    // regardless of the persisted (round-scoped) preference so a white bezel from
    // a round watch doesn't leak onto a square one. For round, apply the persisted
    // color. The white preference stays round-scoped and is restored on return.
    this.bezelToggle.hidden = !info.round;
    if (info.round) {
      this.applyScreenBezelColor(this.bezelColor);
    } else {
      this.stage.style.setProperty("--screen-bezel-color", BEZEL_COLORS.black);
    }

    // Reveal new frame + buttons + screen together.
    this.frame.classList.remove("emu-frame--switching");

    // C3: the natural frame size just changed; re-fit if Fit is the active zoom.
    // The stage/frame are mid-morph here (CSS animates width/height/padding over
    // 420ms — see .emu-stage / .emu-frame transitions in app.css), so reading the
    // frame's live offsetWidth/Height would return the OLD model's transient size
    // and over-scale (worst aplite→gabbro). Instead pass the SETTLED target size,
    // computed from the known chrome body + the frame's box-model chrome:
    //   border-box frame = stage body (bodyWidth/Height) + 2×frame-pad + 2×border
    // frame-pad is 16px square / 18px round (app.css .emu-frame{--frame-pad}); the
    // frame has a 1px border. This makes Fit timing-independent on model switches.
    if (this.zoom === "fit") {
      const framePad = info.round ? 18 : 16;
      const chromePx = 2 * framePad + 2 * FRAME_BORDER_PX;
      this.applyFitScale({
        w: chrome.bodyWidth + chromePx,
        h: chrome.bodyHeight + chromePx,
      });
    }

    // First-load pop-out reveal: the constructor shrank + hid the frame-wrapper
    // (transform scale + opacity 0). Now that the real geometry is set, scale it up
    // and fade it in on the next paint so the watch pops out instead of appearing
    // at a default size and then morphing. The transform never touched layout, so
    // the fit-zoom math above measured the true frame size. One-shot: subsequent
    // model switches keep the existing size→size morph.
    if (!this.framePopped) {
      this.framePopped = true;
      requestAnimationFrame(() => {
        this.frameWrapper.style.transform = "scale(1)";
        this.frameWrapper.style.opacity = "1";
      });
    }
  }

  /**
   * C (v0.0.6): position the round Up/Down nubs ON the outer case circle so each
   * sits with its LONG (tall) edge TANGENT to the rim — riding the arc like the
   * Back/Select nubs do at 9- and 3-o'clock.
   *
   * Circle-placement pattern: the overlay (`.emu-buttons`) is `inset:0` over the
   * frame, so its center is the watch center. We center the nub there and push it
   * out along a rotated radius:
   *   left:50%; top:50%; transform: translate(-50%,-50%) rotate(θ) translateX(R)
   * At θ=0 a tall rectangle is tangent at 3-o'clock (exactly like Select);
   * rotating by θ rides it around the arc keeping the long edge tangent.
   *
   *   R ≈ bodyWidth/2 + framePad(18 for round) + ~2px   (the outer rim radius)
   *   θ = -38° for Up (up the right arc), +38° for Down (negative = upward).
   *
   * R is derived from the REAL chrome.bodyWidth so chalk (208) AND gabbro (288)
   * both land on their own rim. For square we clear the inline transform so the
   * CSS .emu-hit--up/--down rules take over. θ/R eye-tuned against screenshots.
   */
  private applyRoundUpDownPlacement(round: boolean, bodyWidth: number): void {
    const up = this.buttonEls.find((b) => b.dataset.button === "up");
    const down = this.buttonEls.find((b) => b.dataset.button === "down");
    if (!up || !down) return;

    if (!round) {
      // Clear inline left/top/transform so the square CSS classes position them.
      for (const el of [up, down]) {
        el.style.left = "";
        el.style.top = "";
        el.style.transform = "";
      }
      return;
    }

    // Outer rim radius: half the body + the round frame padding (18px, matches
    // .emu-frame--round { --frame-pad:18px }) + a ~2px nudge so the nub root tucks
    // just under the rim edge rather than floating clear of it.
    const ROUND_FRAME_PAD = 18;
    const R = bodyWidth / 2 + ROUND_FRAME_PAD + 2;
    const placeAt = (el: HTMLElement, thetaDeg: number): void => {
      el.style.left = "50%";
      el.style.top = "50%";
      el.style.transform = `translate(-50%, -50%) rotate(${thetaDeg}deg) translateX(${R}px)`;
    };
    placeAt(up, -38); // up the right arc (~1-2 o'clock)
    placeAt(down, 38); // down the right arc (~4-5 o'clock)
  }

  /**
   * Switch to a platform's chrome. With `opts.boot` (auto mode) stop any current
   * emulator then boot the new one; without it (manual mode) just morph to the
   * new chrome idle, leaving "Launch" for the user. This is the single entry
   * point used by startup and model switches.
   */
  async show(platformId: PlatformId, opts: { boot: boolean }): Promise<void> {
    // Re-selecting the board that is already live (or mid-boot) is a no-op: don't
    // tear down and reboot a perfectly good backend, and don't fire a duplicate
    // boot for one already in flight. Applies to both manual and auto — the
    // manual path also force-closes on a same-board select, which is just as
    // disruptive. Relaunch/retry and weather-apply reboots don't route through
    // show(), so they are never suppressed here (see shouldSkipReselect).
    if (shouldSkipReselect(this.currentPlatform, platformId, this.state)) return;
    if (!opts.boot) {
      // Manual mode: switching the model must not orphan a running backend.
      // loadChrome() only disconnects VNC — it leaves qemu/pypkjs/websockify alive
      // holding the VNC ports, and updateLifecycleButtons() then disables
      // Force-close (state goes "stopped"), so the user loses all control of it.
      // Fully stop it first. forceClose() no-ops when already stopped and swallows
      // errors if the backend is already down, so it can't wedge the switch.
      if (this.state !== "stopped") await this.forceClose();
      this.loadChrome(platformId);
      return;
    }
    // Auto: tear down any current emulator (force-close also invalidates any
    // in-flight boot via bootGen) before booting the new chrome.
    if (this.state !== "stopped") {
      await this.forceClose();
    }
    await this.boot(platformId);
  }

  /**
   * Arm bridge-dead suppression ahead of a reboot driven entirely by the main
   * process (the weather-refresh flow). Must be called BEFORE the round-trip
   * that triggers the reboot, because the health monitor can emit bridge-dead
   * while the emulator is mid-restart. MUST be paired 1:1 with endExternalReboot
   * (call it from a `finally` so every begin is balanced on every exit path).
   */
  beginExternalReboot(): void {
    this.externalRebootDepth++;
  }

  /**
   * Balance one beginExternalReboot(). Suppression lifts only when the last
   * in-flight external reboot ends, so overlapping applies stay covered. Floored
   * at 0 so an unbalanced extra call can't wrap into a stuck-suppressed state.
   */
  endExternalReboot(): void {
    this.externalRebootDepth = Math.max(0, this.externalRebootDepth - 1);
  }

  /**
   * Reconnect VNC to the already-running emulator after a wipe+reboot triggered
   * externally (e.g. "Clear emulator", or applying simulated weather). Unlike
   * `show()` / `boot()`, this does NOT call `start()` (the emulator is already
   * booted) and does NOT call `libInstallAll()` (Clear leaves it empty; the
   * weather flow reinstalls in the main process).
   */
  async reconnectAfterClear(platformId: PlatformId): Promise<void> {
    // If we drove an external reboot, bridge-dead was suppressed throughout so
    // `state` stayed "live"; accept that case explicitly rather than depending on
    // the live/unresponsive guard, which a stray transition could otherwise have
    // tripped (black canvas). We only READ the depth here — the caller's `finally`
    // balances the begin/end, so suppression survives until the reconnect is done.
    const wasExternalReboot = this.externalRebootDepth > 0;
    if (!shouldReconnectAfterReboot(wasExternalReboot, this.state, !!this.currentPlatform)) return;
    const info = getPlatform(platformId);
    this.disconnectVnc();
    this.state = "live";
    this.status.textContent = "● Live";
    this.status.classList.remove("emu-status--dead");
    this.status.classList.add("emu-status--live");
    // The IPC handler already rebooted — re-use the endpoint from the last boot's
    // start() (falls back to the backend's pinned default only if we never booted).
    const ep = this.lastEp ?? { host: "localhost", port: 6080, wsPath: "/" };
    this.vnc = connectVnc(this.screenHost, ep, info.touch);
    this.updateLifecycleButtons();
  }

  /**
   * Create the four physical buttons ONCE (constructor). Placement is driven by
   * CSS classes keyed on side + shape (not registry pixel coords): the buttons
   * hug the (square or round) frame edge and — on round devices — angle radially
   * toward the center. Keeping them persistent (vs. rebuilding innerHTML on every
   * model switch) lets CSS transitions animate them into place during a morph.
   * applyGeometry toggles `.emu-buttons--round` on the overlay to switch shape.
   */
  private createButtons(): void {
    this.buttonsOverlay.innerHTML = "";
    this.buttonEls.length = 0;
    const ids: ButtonId[] = ["back", "up", "select", "down"];
    for (const id of ids) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `emu-hit emu-hit--${id}`;
      el.dataset.button = id;
      el.title = id;
      let pressed = false;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // don't leave the nub focused (avoids a stray focus ring)
        pressed = true;
        void window.studio.button(id, "hold");
      });
      const release = (): void => {
        if (!pressed) return;
        pressed = false;
        void window.studio.button(id, "release");
      };
      el.addEventListener("mouseup", release);
      el.addEventListener("mouseleave", release); // dragging off the nub releases
      this.buttonsOverlay.appendChild(el);
      this.buttonEls.push(el);
    }
  }
}
