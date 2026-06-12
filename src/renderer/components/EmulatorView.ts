import type { PlatformId, ButtonId } from "../../shared/types.js";
import { getChrome } from "../chrome/chromeRegistry.js";
import { getPlatform } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import { connectVnc, type VncHandle } from "../vncClient.js";

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
  private readonly caption: HTMLElement;
  private readonly relaunchBtn: HTMLButtonElement;
  private readonly forceCloseBtn: HTMLButtonElement;
  private readonly tapBtn: HTMLButtonElement;
  private readonly shakeBtn: HTMLButtonElement;
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
  private state: "stopped" | "booting" | "live" | "stopping" = "stopped";
  /**
   * Monotonic boot generation. Each boot captures the current gen; force-close
   * (and each new boot) increments it. A boot's start() goes `live` ONLY if its
   * gen is still current when it resolves — otherwise it bails silently. This is
   * what lets force-close take effect immediately even though a backend start()
   * promise may still be settling.
   */
  private bootGen = 0;

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
        <button class="emu-action emu-action--filled" id="emu-tap" type="button">Tap</button>
        <button class="emu-action emu-action--subtle" id="emu-shake" type="button">Shake</button>
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
        <span class="emu-status" id="emu-status"></span>
      </div>
    `;

    this.screenHost = this.el.querySelector<HTMLElement>("#emu-screen")!;
    this.buttonsOverlay = this.el.querySelector<HTMLElement>("#emu-buttons")!;
    this.status = this.el.querySelector<HTMLElement>("#emu-status")!;
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

    // Create the four physical button nubs ONCE. They persist across model
    // switches; applyGeometry only toggles the square/round classes so CSS can
    // animate their positions (morph). Order matters only for DOM stacking.
    this.createButtons();

    // Tap / Shake — no-op unless the emulator is live (don't fire IPC at a dead one).
    const tapBtn = this.el.querySelector<HTMLButtonElement>("#emu-tap")!;
    const shakeBtn = this.el.querySelector<HTMLButtonElement>("#emu-shake")!;
    this.tapBtn = tapBtn;
    this.shakeBtn = shakeBtn;
    tapBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      void window.studio.accelTap();
    });
    shakeBtn.addEventListener("click", () => {
      if (this.state !== "live") return;
      void window.studio.accelTap();
      setTimeout(() => void window.studio.accelTap(), 120);
    });

    // Lifecycle buttons. The single Launch/Relaunch button routes to relaunch()
    // when live and launch() otherwise.
    this.relaunchBtn.addEventListener("click", () => {
      if (this.state === "live") void this.relaunch();
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

    // Start disabled until something is running
    this.updateLifecycleButtons();
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
   * C3 (v0.0.5 — real fit): scale the watch to fill the stage column. The old
   * version measured `frameWrapper.clientWidth`, but the wrapper shrinks to the
   * frame (avail ≈ natural → scale ≈ 1, no effect). Instead we measure the PANEL
   * (`this.el`) and subtract the non-stage rows (caption + actions + zoom) plus
   * the wrapper's vertical margins to get the height available for the watch,
   * then take the min of width/height fit so it stays fully visible.
   */
  private applyFitScale(): void {
    const availW = this.el.clientWidth;
    if (availW <= 0) return; // panel not laid out yet — observer will retry

    // Available height = panel height minus every sibling row of the wrapper and
    // the wrapper's own vertical margins. Summing actual row heights keeps this
    // correct regardless of how the rows wrap.
    let usedH = 0;
    for (const child of Array.from(this.el.children) as HTMLElement[]) {
      if (child === this.frameWrapper) continue;
      usedH += child.offsetHeight;
      const cs = getComputedStyle(child);
      usedH += parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    }
    const wrapCs = getComputedStyle(this.frameWrapper);
    usedH += parseFloat(wrapCs.marginTop) + parseFloat(wrapCs.marginBottom);
    const availH = this.el.clientHeight - usedH;
    if (availH <= 0) return;

    // Natural (unscaled) frame size: clear the transform so offset* reflects the
    // true size regardless of the previous scale.
    const prev = this.frame.style.transform;
    this.frame.style.transform = "";
    const naturalW = this.frame.offsetWidth;
    const naturalH = this.frame.offsetHeight;
    this.frame.style.transform = prev;
    if (naturalW <= 0 || naturalH <= 0) return; // not measurable yet

    const scale = Math.max(0.25, Math.min(availW / naturalW, availH / naturalH, 4));
    this.setScale(scale);
  }

  /** Lazily create the fit ResizeObserver (only used while zoom === "fit"). */
  private ensureFitObserver(): void {
    if (this.fitObserver) return;
    this.fitObserver = new ResizeObserver(() => {
      if (this.zoom === "fit") this.applyFitScale();
    });
    // Observe the PANEL (not the inner wrapper) so it re-fits on window resize.
    this.fitObserver.observe(this.el);
  }

  /** Disconnect/ignore the fit observer when a non-fit zoom is selected. */
  private disconnectFitObserver(): void {
    if (this.fitObserver) {
      this.fitObserver.disconnect();
      this.fitObserver = null;
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
    this.relaunchBtn.textContent = s === "live" ? "Relaunch" : "Launch";
    this.relaunchBtn.disabled = !((s === "stopped" && this.currentPlatform) || s === "live");
    this.forceCloseBtn.disabled = !(s === "booting" || s === "live");

    const liveActions = s === "live";
    this.tapBtn.disabled = !liveActions;
    this.shakeBtn.disabled = !liveActions;
    for (const el of this.buttonEls) el.disabled = !liveActions;
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
    this.disconnectVnc();
    this.beginSwitch();
    this.applyGeometry(platformId);
    this.status.textContent = `Booting ${info.label}…`;
    this.status.classList.remove("emu-status--live");
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
      console.error("[emu] start failed", err);
      this.updateLifecycleButtons();
      return;
    }

    // Superseded while start() was settling (force-close or another boot) — bail
    // silently; the owner of the new gen already drives the UI.
    if (gen !== this.bootGen) return;

    this.state = "live";
    this.status.textContent = "● Live";
    this.status.classList.add("emu-status--live");
    this.vnc = connectVnc(this.screenHost, ep as { host: string; port: number; wsPath: string }, info.touch);
    this.updateLifecycleButtons();

    // Re-install library apps after boot so a platform switch picks them up.
    try {
      await window.studio.libInstallAll();
    } catch (err) {
      console.error("[emu] libInstallAll failed", err);
    }
  }

  /**
   * Launch: boot the currently-selected platform. Only valid from `stopped` with
   * a platform selected; ignored otherwise (spam/re-entrancy guard).
   */
  async launch(): Promise<void> {
    if (this.state !== "stopped" || !this.currentPlatform) return;
    await this.boot(this.currentPlatform);
  }

  /** Relaunch: stop the current emulator then boot the same platform. Only when live. */
  async relaunch(): Promise<void> {
    if (this.state !== "live" || !this.currentPlatform) return;
    const id = this.currentPlatform;
    this.state = "stopping";
    this.disconnectVnc();
    this.status.textContent = "Stopping…";
    this.status.classList.remove("emu-status--live");
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
    this.bootGen++; // invalidate any in-flight boot
    this.state = "stopping";
    this.status.textContent = "Stopping…";
    this.status.classList.remove("emu-status--live");
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

    // B5: bezel-color toggle is only meaningful for round models; re-apply the
    // persisted color when switching to a round watch, hide the control otherwise.
    this.bezelToggle.hidden = !info.round;
    if (info.round) this.applyScreenBezelColor(this.bezelColor);

    // Reveal new frame + buttons + screen together.
    this.frame.classList.remove("emu-frame--switching");

    // C3: the natural frame size just changed; re-fit if Fit is the active zoom.
    if (this.zoom === "fit") this.applyFitScale();
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
    if (this.state !== "live" || !this.currentPlatform) return;
    const info = getPlatform(platformId);
    this.disconnectVnc();
    this.state = "live";
    this.status.textContent = "● Live";
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
