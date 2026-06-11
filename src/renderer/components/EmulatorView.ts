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
  private vnc: VncHandle | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "emu-panel";
    this.el.innerHTML = `
      <div class="emu-stage" id="emu-stage">
        <div class="emu-screen" id="emu-screen"></div>
        <div class="emu-buttons" id="emu-buttons"></div>
      </div>
      <div class="emu-actions">
        <button class="emu-action" id="emu-tap" type="button">Tap</button>
        <button class="emu-action" id="emu-shake" type="button">Shake</button>
        <span class="emu-status" id="emu-status"></span>
      </div>
    `;

    this.screenHost = this.el.querySelector<HTMLElement>("#emu-screen")!;
    this.buttonsOverlay = this.el.querySelector<HTMLElement>("#emu-buttons")!;
    this.status = this.el.querySelector<HTMLElement>("#emu-status")!;

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

    this.status.textContent = `Booting ${info.label}…`;

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

    // Position the screen host within the stage.
    Object.assign(this.screenHost.style, {
      left: `${chrome.screen.x}px`,
      top: `${chrome.screen.y}px`,
      width: `${chrome.screen.width}px`,
      height: `${chrome.screen.height}px`,
    });
    this.screenHost.classList.toggle("emu-screen--round", info.round);

    this.renderButtons(platformId);

    let ep;
    try {
      ep = await window.studio.start(platformId);
    } catch (err) {
      this.status.textContent = `Failed to start ${info.label}`;
      console.error("[emu] start failed", err);
      return;
    }

    this.status.textContent = info.label;
    this.vnc = connectVnc(this.screenHost, ep as { host: string; port: number; wsPath: string }, info.touch);
  }

  private renderButtons(platformId: PlatformId): void {
    const chrome = getChrome(platformId);
    this.buttonsOverlay.innerHTML = "";
    for (const b of chrome.buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "emu-hit";
      el.dataset.button = b.id;
      el.title = b.id;
      Object.assign(el.style, {
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.width}px`,
        height: `${b.height}px`,
      });
      el.addEventListener("click", () => void window.studio.button(b.id as ButtonId));
      this.buttonsOverlay.appendChild(el);
    }
  }
}
