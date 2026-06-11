import type { PlatformId, ButtonId } from "../../shared/types.js";
import { getChrome } from "../chrome/chromeRegistry.js";
import { getPlatform } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import { connectVnc, type VncHandle } from "../vncClient.js";

type ZoomLevel = "1" | "1.5" | "2" | "3";
const ZOOM_KEY = "pebble-studio:emu-zoom";

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
  private readonly zoomSelect: HTMLSelectElement;
  private readonly frameWrapper: HTMLElement;
  private vnc: VncHandle | null = null;
  /** The platform currently running (or last attempted). null = nothing booted yet. */
  private currentPlatform: PlatformId | null = null;
  /** True while a boot or stop operation is in progress. */
  private busy = false;
  /** True once the emulator has been started at least once (stop() is safe to call). */
  private started = false;

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

    // Tap / Shake
    const tapBtn = this.el.querySelector<HTMLButtonElement>("#emu-tap")!;
    const shakeBtn = this.el.querySelector<HTMLButtonElement>("#emu-shake")!;
    tapBtn.addEventListener("click", () => void window.studio.accelTap());
    shakeBtn.addEventListener("click", () => {
      void window.studio.accelTap();
      setTimeout(() => void window.studio.accelTap(), 120);
    });

    // Lifecycle buttons
    this.relaunchBtn.addEventListener("click", () => void this.relaunch());
    this.forceCloseBtn.addEventListener("click", () => void this.forceClose());

    // Zoom segmented control
    const zoomSeg = this.el.querySelector<HTMLElement>("#emu-zoom-seg")!;
    zoomSeg.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".emu-zoom-opt");
      if (!btn) return;
      const z = btn.dataset.zoom as ZoomLevel | undefined;
      if (z) this.applyZoom(z);
    });

    // Restore saved zoom
    const savedZoom = (localStorage.getItem(ZOOM_KEY) ?? "1") as ZoomLevel;
    this.applyZoom(savedZoom);

    // Start disabled until something is running
    this.updateLifecycleButtons();
  }

  /** Apply zoom level to the frame wrapper and persist choice. */
  private applyZoom(z: ZoomLevel): void {
    const frame = this.el.querySelector<HTMLElement>(".emu-frame")!;
    const scale = parseFloat(z);
    frame.style.transform = scale === 1 ? "" : `scale(${scale})`;
    frame.style.transformOrigin = "center top";
    // Reserve layout space so scaled frame doesn't bleed over other panels.
    // We set the wrapper height as a multiple of the natural height via a CSS variable.
    this.frameWrapper.style.setProperty("--zoom-scale", String(scale));
    // Update active state
    const seg = this.el.querySelector<HTMLElement>("#emu-zoom-seg")!;
    seg.querySelectorAll<HTMLButtonElement>(".emu-zoom-opt").forEach((btn) => {
      btn.classList.toggle("emu-zoom-opt--active", btn.dataset.zoom === z);
      btn.setAttribute("aria-pressed", String(btn.dataset.zoom === z));
    });
    localStorage.setItem(ZOOM_KEY, z);
  }

  /** Update the enabled/disabled state of lifecycle buttons. */
  private updateLifecycleButtons(): void {
    const canAct = this.started && !this.busy;
    this.relaunchBtn.disabled = !canAct;
    this.forceCloseBtn.disabled = !canAct;
  }

  /** Relaunch: stop the current emulator then boot the same platform. */
  async relaunch(): Promise<void> {
    if (this.busy || !this.started || !this.currentPlatform) return;
    const id = this.currentPlatform;
    this.busy = true;
    this.updateLifecycleButtons();
    try {
      this.disconnectVnc();
      this.status.textContent = "Stopping…";
      this.status.classList.remove("emu-status--live");
      try {
        await window.studio.stop();
      } catch (err) {
        console.warn("[emu] stop() during relaunch failed (ignored):", err);
      }
      await this.bootPlatform(id);
    } finally {
      this.busy = false;
      this.updateLifecycleButtons();
    }
  }

  /** Force-close: stop the emulator and show an idle state. */
  async forceClose(): Promise<void> {
    if (this.busy || !this.started) return;
    this.busy = true;
    this.updateLifecycleButtons();
    try {
      this.disconnectVnc();
      this.status.textContent = "Stopping…";
      this.status.classList.remove("emu-status--live");
      try {
        await window.studio.stop();
      } catch (err) {
        console.warn("[emu] stop() during force-close failed (ignored):", err);
      }
      this.started = false;
      this.status.textContent = "Stopped";
      this.screenHost.innerHTML = "";
    } finally {
      this.busy = false;
      this.updateLifecycleButtons();
    }
  }

  /** Disconnect VNC without stopping the backend. */
  private disconnectVnc(): void {
    if (this.vnc) {
      this.vnc.disconnect();
      this.vnc = null;
    }
    this.screenHost.innerHTML = "";
  }

  async show(platformId: PlatformId): Promise<void> {
    const info = getPlatform(platformId);

    this.caption.textContent = `${info.label} · ${info.width}×${info.height}`;
    const frame = this.el.querySelector<HTMLElement>(".emu-frame")!;
    frame.classList.toggle("emu-frame--round", info.round);
    this.status.textContent = `Booting ${info.label}…`;
    this.status.classList.remove("emu-status--live");

    // D1 — Fully stop the current emulator before switching to a new platform.
    this.disconnectVnc();
    if (this.started) {
      try {
        await window.studio.stop();
      } catch (err) {
        // Nothing was running yet, or stop failed — don't block the boot.
        console.warn("[emu] stop() before platform switch failed (ignored):", err);
      }
    }

    this.currentPlatform = platformId;
    this.busy = true;
    this.updateLifecycleButtons();

    try {
      await this.bootPlatform(platformId);
    } finally {
      this.busy = false;
      this.updateLifecycleButtons();
    }
  }

  /** Internal: size the stage and start the emulator. Assumes VNC is already disconnected. */
  private async bootPlatform(platformId: PlatformId): Promise<void> {
    const info = getPlatform(platformId);
    const chrome = getChrome(platformId);

    this.status.textContent = `Booting ${info.label}…`;
    this.status.classList.remove("emu-status--live");

    const frame = this.el.querySelector<HTMLElement>(".emu-frame")!;
    frame.classList.toggle("emu-frame--round", info.round);

    // Size the stage to the chrome body so the button overlay aligns.
    const stage = this.el.querySelector<HTMLElement>("#emu-stage")!;
    stage.style.width = `${chrome.bodyWidth}px`;
    stage.style.height = `${chrome.bodyHeight}px`;

    // Reserve layout space in the wrapper for the scaled frame.
    this.frameWrapper.style.setProperty("--stage-height", `${chrome.bodyHeight + 2 * 16}px`);

    // Position the screen host within the stage. For round devices the screen
    // is centered in the (square) stage so it sits dead-center of the circular
    // frame; for square devices the registry's screen offset is used.
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

    this.renderButtons(info.round);

    let ep;
    try {
      ep = await window.studio.start(platformId);
      this.started = true;
      this.currentPlatform = platformId;
    } catch (err) {
      this.status.textContent = `Failed to start ${info.label}`;
      console.error("[emu] start failed", err);
      return;
    }

    this.status.textContent = "● Live";
    this.status.classList.add("emu-status--live");
    this.vnc = connectVnc(this.screenHost, ep as { host: string; port: number; wsPath: string }, info.touch);

    // Re-install library apps after boot so a platform switch picks them up.
    try {
      await window.studio.libInstallAll();
    } catch (err) {
      console.error("[emu] libInstallAll failed", err);
    }
  }

  /**
   * Reconnect VNC to the already-running emulator after a wipe+reboot triggered
   * externally (e.g. "Clear emulator"). Unlike `show()` / `bootPlatform()`, this
   * does NOT call `start()` (the emulator is already booted) and does NOT call
   * `libInstallAll()` (the whole point of Clear is to leave it empty).
   */
  async reconnectAfterClear(platformId: PlatformId): Promise<void> {
    if (!this.started || !this.currentPlatform) return;
    const info = getPlatform(platformId);
    this.disconnectVnc();
    this.status.textContent = "● Live";
    this.status.classList.add("emu-status--live");
    // The IPC handler already rebooted — re-use the same VNC endpoint.
    const ep = { host: "localhost", port: 6080, wsPath: "/" };
    this.vnc = connectVnc(this.screenHost, ep, info.touch);
  }

  /**
   * Render the four physical buttons as nubs tucked into the frame edge. Placement
   * is driven purely by CSS classes keyed on side + shape (not registry pixel
   * coords), so the buttons hug the (square or round) frame edge and — on round
   * devices — angle radially toward the center. The registry geometry is still
   * used for hit-testing in tests; here we only need the button ids/order.
   */
  private renderButtons(round: boolean): void {
    this.buttonsOverlay.innerHTML = "";
    this.buttonsOverlay.classList.toggle("emu-buttons--round", round);
    const ids: ButtonId[] = ["back", "up", "select", "down"];
    for (const id of ids) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `emu-hit emu-hit--${id}`;
      el.dataset.button = id;
      el.title = id;
      el.addEventListener("click", () => void window.studio.button(id));
      this.buttonsOverlay.appendChild(el);
    }
  }
}
