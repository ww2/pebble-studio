import type { PlatformId, ButtonId } from "../../shared/types.js";
import { getChrome } from "../chrome/chromeRegistry.js";
import { getPlatform } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import { connectVnc, type VncHandle } from "../vncClient.js";
import { loadBindings, resolveAction, type Bindings } from "../keybindings.js";
import type { TimeConfig } from "../../main/backend/timeController.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/** Format hours/minutes as 12h "h:mm AM/PM" (default) or 24h "HH:MM". */
function fmtHM(h: number, m: number, hour24: boolean): string {
  const mm = String(m).padStart(2, "0");
  if (hour24) return `${String(h).padStart(2, "0")}:${mm}`;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ap}`;
}

const DIAGNOSTICS_KEY = "pebble-studio:diagnostics";

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
  private timelinePeek = false;
  private readonly zoomSelect: HTMLSelectElement;
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
  private state: "stopped" | "booting" | "live" | "stopping" | "unresponsive" = "stopped";
  /**
   * Monotonic boot generation. Each boot captures the current gen; force-close
   * (and each new boot) increments it. A boot's start() goes `live` ONLY if its
   * gen is still current when it resolves — otherwise it bails silently. This is
   * what lets force-close take effect immediately even though a backend start()
   * promise may still be settling.
   */
  private bootGen = 0;

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
  private readonly diagLine: HTMLElement;
  /** Disposer for the boot-progress subscription (active for diagnostics). */
  private bootProgressDispose: (() => void) | null = null;
  /** Disposer for the bridge-dead subscription (always active). */
  private bridgeDeadDispose: (() => void) | null = null;
  /** Latest boot-progress note (shown in the diag line when diagnostics on). */
  private lastBootNote = "";
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
      <div class="emu-actions">
        <button class="emu-action emu-action--subtle" id="emu-tap" type="button">Tap</button>
        <button class="emu-action emu-action--subtle" id="emu-shake" type="button">Shake</button>
        <button class="emu-action emu-action--subtle" id="emu-timeline" type="button" title="Toggle timeline quick view (peek)">Timeline</button>
        <div class="emu-actions-sep" aria-hidden="true"></div>
        <button class="emu-action emu-action--subtle" id="emu-relaunch" type="button" title="Stop and reboot the current platform">Relaunch</button>
        <button class="emu-action emu-action--subtle emu-action--danger" id="emu-force-close" type="button" title="Force-close the emulator">Force-close</button>
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
      <div class="emu-diag" id="emu-diag" hidden></div>
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
    // The zoom select element is kept for compatibility but we use the segmented control
    this.zoomSelect = document.createElement("select"); // hidden, not appended
    this.frameWrapper = this.el.querySelector<HTMLElement>(".emu-frame-wrapper")!;
    this.frame = this.el.querySelector<HTMLElement>(".emu-frame")!;
    this.stage = this.el.querySelector<HTMLElement>("#emu-stage")!;
    this.switchOverlay = this.el.querySelector<HTMLElement>("#emu-switch-overlay")!;
    this.bezelToggle = this.el.querySelector<HTMLElement>("#emu-bezel-toggle")!;
    this.diagLine = this.el.querySelector<HTMLElement>("#emu-diag")!;

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
      setTimeout(() => void window.studio.accelTap(), 120);
    });
    this.timelineBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      this.timelinePeek = !this.timelinePeek;
      this.timelineBtn.classList.toggle("emu-action--on", this.timelinePeek);
      void window.studio.timelineQuickView(this.timelinePeek).catch(() => {});
    });

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
    this.setDiagnostics(localStorage.getItem(DIAGNOSTICS_KEY) === "on");

    // H4: subscribe to bridge-dead notifications from the main-process health
    // monitor. Only transition when live — ignore if already stopping/booting.
    this.bridgeDeadDispose = studioBootProgress().onBridgeDead((reason) => {
      if (this.state !== "live") return;
      console.warn("[emu] bridge-dead received (reason:", reason, ") — entering unresponsive");
      this.state = "unresponsive";
      this.disconnectVnc();
      this.status.textContent = "⚠ Emulator stopped responding — Relaunch";
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
    if (e.ctrlKey || e.altKey || e.metaKey) return;
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
        void window.studio.button(action);
        break;
      case "tap":
        void window.studio.accelTap();
        break;
      case "shake":
        // Mirror the Shake button: a double-tap.
        void window.studio.accelTap();
        setTimeout(() => void window.studio.accelTap(), 120);
        break;
      case "light":
        void window.studio.backlightPulse();
        break;
    }
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
    for (const el of this.buttonEls) el.disabled = !liveActions;

    // J-runtime: the FPS sampler only runs while diagnostics on AND live.
    this.syncFpsSampler();
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
    this.diagLine.hidden = !on;
    if (on) {
      // Subscribe to boot-progress notes only while diagnostics is on.
      if (!this.bootProgressDispose) {
        this.bootProgressDispose = studioBootProgress().onBootProgress((msg) => {
          this.lastBootNote = msg;
          if (this.diagnostics) this.renderDiagLine();
        });
      }
      this.renderDiagLine();
    } else {
      if (this.bootProgressDispose) {
        this.bootProgressDispose();
        this.bootProgressDispose = null;
      }
      this.lastBootNote = "";
    }
    this.syncFpsSampler();
  }

  /** Compose the diagnostics line from the current fps + latest boot note. */
  private renderDiagLine(): void {
    if (!this.diagnostics) return;
    const parts: string[] = [`~${this.fps} fps`];
    if (this.lastBootNote) parts.push(this.lastBootNote);
    this.diagLine.textContent = parts.join("  ·  ");
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
      this.renderDiagLine();
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
    const canvas = this.screenHost.querySelector("canvas");
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
    const N = 8; // sample into an 8×8 thumbnail
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
    this.currentPlatform = platformId;
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
    this.vnc = connectVnc(this.screenHost, ep as { host: string; port: number; wsPath: string }, info.touch);
    this.updateLifecycleButtons();

    // Re-install library apps after boot so a platform switch picks them up.
    try {
      await window.studio.libInstallAll();
    } catch (err) {
      console.error("[emu] libInstallAll failed", err);
    }
    // The loaded-app set just changed — tell the App Library to refresh its
    // "N loaded" count + pills (it only otherwise refreshes on a drop/pick).
    window.dispatchEvent(new Event("pebble-studio:apps-changed"));
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

  /** Relaunch: stop the current emulator then boot the same platform. Only when live or unresponsive. */
  async relaunch(): Promise<void> {
    if ((this.state !== "live" && this.state !== "unresponsive") || !this.currentPlatform) return;
    const id = this.currentPlatform;
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
    if (!opts.boot) {
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
   * Reconnect VNC to the already-running emulator after a wipe+reboot triggered
   * externally (e.g. "Clear emulator"). Unlike `show()` / `boot()`, this
   * does NOT call `start()` (the emulator is already booted) and does NOT call
   * `libInstallAll()` (the whole point of Clear is to leave it empty).
   */
  async reconnectAfterClear(platformId: PlatformId): Promise<void> {
    if ((this.state !== "live" && this.state !== "unresponsive") || !this.currentPlatform) return;
    const info = getPlatform(platformId);
    this.disconnectVnc();
    this.state = "live";
    this.status.textContent = "● Live";
    this.status.classList.remove("emu-status--dead");
    this.status.classList.add("emu-status--live");
    // The IPC handler already rebooted — re-use the same VNC endpoint.
    const ep = { host: "localhost", port: 6080, wsPath: "/" };
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
      el.addEventListener("click", () => void window.studio.button(id));
      this.buttonsOverlay.appendChild(el);
      this.buttonEls.push(el);
    }
  }
}
