import type { PlatformId, ButtonId } from "../../shared/types.js";
import { getChrome } from "../chrome/chromeRegistry.js";
import { getPlatform } from "../../main/backend/emulatorRegistry.js"; // pure module, bundled by Vite
import { connectVnc, type VncHandle } from "../vncClient.js";

/**
 * Emulator panel: a watch "stage" hosting the live noVNC display, an overlay of
 * the four physical buttons (mapped from chromeRegistry geometry), plus tap/shake
 * accelerometer action buttons.
 */
export class EmulatorView {
  readonly el: HTMLElement;
  private readonly screenHost: HTMLElement;
  private readonly buttonsOverlay: HTMLElement;
  private readonly status: HTMLElement;
  private readonly caption: HTMLElement;
  private vnc: VncHandle | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "emu-panel";
    this.el.innerHTML = `
      <div class="emu-frame">
        <div class="emu-buttons" id="emu-buttons"></div>
        <div class="emu-stage" id="emu-stage">
          <div class="emu-screen" id="emu-screen"></div>
        </div>
      </div>
      <div class="emu-caption" id="emu-caption"></div>
      <div class="emu-actions">
        <button class="emu-action emu-action--filled" id="emu-tap" type="button">Tap</button>
        <button class="emu-action emu-action--subtle" id="emu-shake" type="button">Shake</button>
      </div>
      <span class="emu-status" id="emu-status"></span>
    `;

    this.screenHost = this.el.querySelector<HTMLElement>("#emu-screen")!;
    this.buttonsOverlay = this.el.querySelector<HTMLElement>("#emu-buttons")!;
    this.status = this.el.querySelector<HTMLElement>("#emu-status")!;
    this.caption = this.el.querySelector<HTMLElement>("#emu-caption")!;

    const tapBtn = this.el.querySelector<HTMLButtonElement>("#emu-tap")!;
    const shakeBtn = this.el.querySelector<HTMLButtonElement>("#emu-shake")!;
    tapBtn.addEventListener("click", () => void window.studio.accelTap());
    // A "shake" is a couple of taps in quick succession.
    shakeBtn.addEventListener("click", () => {
      void window.studio.accelTap();
      setTimeout(() => void window.studio.accelTap(), 120);
    });
  }

  async show(platformId: PlatformId): Promise<void> {
    const info = getPlatform(platformId);
    const chrome = getChrome(platformId);

    this.caption.textContent = `${info.label} · ${info.width}×${info.height}`;
    const frame = this.el.querySelector<HTMLElement>(".emu-frame")!;
    frame.classList.toggle("emu-frame--round", info.round);
    this.status.textContent = `Booting ${info.label}…`;
    this.status.classList.remove("emu-status--live");

    // Disconnect any prior session before starting a new platform.
    if (this.vnc) {
      this.vnc.disconnect();
      this.vnc = null;
    }
    this.screenHost.innerHTML = "";

    // Size the stage to the chrome body so the button overlay aligns.
    const stage = this.el.querySelector<HTMLElement>("#emu-stage")!;
    stage.style.width = `${chrome.bodyWidth}px`;
    stage.style.height = `${chrome.bodyHeight}px`;

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
