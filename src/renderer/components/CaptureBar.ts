import GIF from "gif.js";
import { FrameBudget } from "../../capture/gifRecorder.js";
import { grabUpscaled, rgbaToBlob, applyCircularMask } from "../captureCanvas.js";
import type { RgbaImage } from "../../capture/upscale.js";

/** Magenta key color used as the transparent index in round GIFs. */
const GIF_TRANSPARENT_COLOR = 0xff00ff;

/**
 * Hard cap (seconds) on any single GIF recording. Sized to allow the longest
 * 15s preset to complete; manual recordings are bounded by this too so files
 * can't grow unbounded.
 */
const GIF_MAX_SECONDS = 15;

/** Pref key: briefly wake the backlight during a capture (default ON when unset). */
const BACKLIGHT_CAPTURE_KEY = "pebble-studio:backlight-capture";

/** Beat (ms) to let the backlight rise before grabbing an instant screenshot. */
const BACKLIGHT_RISE_MS = 250;

export class CaptureBar {
  readonly el: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly durationSelect: HTMLSelectElement;
  private readonly shotBtn: HTMLButtonElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly lightBtn: HTMLButtonElement;
  private readonly status: HTMLSpanElement;

  private recording = false;
  private gif: InstanceType<typeof GIF> | null = null;
  private recTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getHost: () => HTMLElement | null,
    private readonly isRound: () => boolean = () => false,
    private readonly getPlatformId: () => string = () => "unknown",
  ) {
    this.el = document.createElement("div");
    this.el.className = "capture-bar";

    // Upscale factor selector
    const label = document.createElement("label");
    label.className = "capture-label";
    label.textContent = "Upscale:";

    this.select = document.createElement("select");
    this.select.className = "capture-select";
    for (const v of [1, 2, 4, 8]) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = `${v}\xD7`;
      if (v === 1) opt.selected = true;
      this.select.appendChild(opt);
    }

    // GIF duration selector: Manual / 5s / 10s / 15s. Manual (value "0") = today's
    // behavior (record until Stop or the cap). A preset auto-stops after N seconds.
    const durLabel = document.createElement("label");
    durLabel.className = "capture-label";
    durLabel.textContent = "Duration:";

    this.durationSelect = document.createElement("select");
    this.durationSelect.className = "capture-select";
    for (const [value, text] of [["0", "Manual"], ["5", "5s"], ["10", "10s"], ["15", "15s"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      if (value === "0") opt.selected = true;
      this.durationSelect.appendChild(opt);
    }

    // Screenshot button
    this.shotBtn = document.createElement("button");
    this.shotBtn.type = "button";
    this.shotBtn.className = "capture-btn capture-btn--neutral";
    this.shotBtn.dataset.act = "screenshot";
    this.shotBtn.textContent = "Screenshot";
    this.shotBtn.addEventListener("click", () => void this.takeScreenshot());

    // GIF record toggle
    this.recBtn = document.createElement("button");
    this.recBtn.type = "button";
    this.recBtn.className = "capture-btn capture-btn--rec";
    this.recBtn.textContent = "Record GIF";
    this.recBtn.addEventListener("click", () => void this.toggleRecord());

    // "Light now": fire a single backlight pulse on demand (always available,
    // independent of the automatic capture keepalive).
    this.lightBtn = document.createElement("button");
    this.lightBtn.type = "button";
    this.lightBtn.className = "capture-btn";
    this.lightBtn.dataset.act = "light";
    this.lightBtn.textContent = "Backlight";
    this.lightBtn.addEventListener("click", () => void window.studio.backlightPulse());

    // Status span
    this.status = document.createElement("span");
    this.status.className = "capture-status";

    this.el.appendChild(label);
    this.el.appendChild(this.select);
    this.el.appendChild(durLabel);
    this.el.appendChild(this.durationSelect);
    this.el.appendChild(this.shotBtn);
    this.el.appendChild(this.recBtn);
    this.el.appendChild(this.lightBtn);
    this.el.appendChild(this.status);
  }

  /** Selected duration in seconds, or 0 for Manual. */
  private durationSeconds(): number {
    return parseInt(this.durationSelect.value, 10);
  }

  private factor(): number {
    return parseInt(this.select.value, 10);
  }

  /** K: true when "backlight during capture" is enabled (default ON when unset). */
  private backlightDuringCapture(): boolean {
    return localStorage.getItem(BACKLIGHT_CAPTURE_KEY) !== "false";
  }

  /**
   * K: hold/release the capture backlight, swallowing any failure so a backlight
   * hiccup never breaks the capture itself. No-op when the pref is off.
   */
  private async setBacklightHold(on: boolean): Promise<void> {
    if (!this.backlightDuringCapture()) return;
    try {
      await window.studio.backlightCaptureHold(on);
    } catch (err) {
      console.warn("[capture] backlightCaptureHold failed (ignored):", err);
    }
  }

  /**
   * Apply mask to frame when on a round platform.
   * For GIF frames also replace masked pixels with the transparent key color
   * so gif.js can index them as transparent.
   */
  private maybeCircularMask(frame: RgbaImage, forGif = false): RgbaImage {
    if (!this.isRound()) return frame;
    const masked = applyCircularMask(frame);
    if (!forGif) return masked;

    // Replace alpha-0 pixels with the GIF transparent key color so gif.js
    // can use them as the transparent index.
    const out = new Uint8Array(masked.data);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] === 0) {
        out[i]     = (GIF_TRANSPARENT_COLOR >> 16) & 0xff; // R
        out[i + 1] = (GIF_TRANSPARENT_COLOR >> 8) & 0xff;  // G
        out[i + 2] = GIF_TRANSPARENT_COLOR & 0xff;          // B
        out[i + 3] = 255; // make opaque so gif.js sees the color
      }
    }
    return { data: out, width: masked.width, height: masked.height };
  }

  private async takeScreenshot(): Promise<void> {
    const host = this.getHost();
    if (!host) { this.status.textContent = "No emulator screen"; return; }
    try {
      // K: wake the backlight, give it a beat to rise, then grab — so the shot
      // isn't dim. try/finally guarantees the hold is always released.
      await this.setBacklightHold(true);
      try {
        if (this.backlightDuringCapture()) {
          await new Promise((r) => setTimeout(r, BACKLIGHT_RISE_MS));
        }
        const raw = grabUpscaled(host, this.factor());
        const frame = this.maybeCircularMask(raw);
        const blob = await rgbaToBlob(frame);
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        // G: pebble-shot-<codename>-<n>.png (n = next free integer from main).
        const base = `pebble-shot-${this.getPlatformId()}`;
        const name = await window.studio.nextCaptureName(base, "png");
        const saved = await window.studio.saveCapture(name, bytes);
        this.status.textContent = `Saved: ${saved}`;
      } finally {
        await this.setBacklightHold(false);
      }
    } catch (err) {
      this.status.textContent = `Screenshot failed: ${String(err)}`;
      console.error("[capture] screenshot error", err);
    }
  }

  private async toggleRecord(): Promise<void> {
    if (this.recording) {
      this.stopRecord();
    } else {
      await this.startRecord();
    }
  }

  private async startRecord(): Promise<void> {
    const host = this.getHost();
    if (!host) { this.status.textContent = "No emulator screen"; return; }

    // Grab a first frame to determine dimensions
    let firstFrame: RgbaImage;
    try {
      firstFrame = grabUpscaled(host, this.factor());
    } catch (err) {
      this.status.textContent = `Grab failed: ${String(err)}`;
      return;
    }

    this.recording = true;
    this.recBtn.textContent = "Stop GIF";
    this.recBtn.classList.add("capture-btn--recording");

    // K: hold the backlight on for the whole recording so frames aren't dim;
    // released in stopRecord(). Fire-and-forget — a failure must not break record.
    void this.setBacklightHold(true);

    // A preset (5/10/15s) caps the budget at exactly that many seconds so the
    // existing isFull() path auto-stops. Manual uses the full hard cap.
    const preset = this.durationSeconds();
    const maxSeconds = preset > 0 ? preset : GIF_MAX_SECONDS;
    const budget = new FrameBudget({ fps: 15, maxSeconds });
    const platformId = this.getPlatformId();
    const round = this.isRound();

    const gifOptions: ConstructorParameters<typeof GIF>[0] = {
      workers: 2,
      quality: 10,
      width: firstFrame.width,
      height: firstFrame.height,
      workerScript: "./gif.worker.js",
    };
    if (round) {
      gifOptions.transparent = GIF_TRANSPARENT_COLOR;
      gifOptions.background = "#ff00ff";
    }

    this.gif = new GIF(gifOptions);

    const gifRef = this.gif;

    gifRef.on("finished", (blob: Blob) => {
      void blob.arrayBuffer().then(async (ab) => {
        const bytes = new Uint8Array(ab);
        // G: pebble-rec-<codename>-<n>.gif (n = next free integer from main).
        const base = `pebble-rec-${platformId}`;
        const name = await window.studio.nextCaptureName(base, "gif");
        const saved = await window.studio.saveCapture(name, bytes);
        this.status.textContent = `GIF saved: ${saved}`;
      }).catch((err: unknown) => {
        this.status.textContent = `GIF save failed: ${String(err)}`;
        console.error("[capture] gif save error", err);
      });
    });

    // Add the first frame immediately
    if (budget.tryAdd()) {
      const maskedFirst = this.maybeCircularMask(firstFrame, true);
      const canvas = this.imageToCanvas(maskedFirst);
      gifRef.addFrame(canvas, { delay: budget.frameDelayMs(), copy: true });
    }

    this.recTimer = setInterval(() => {
      if (!this.recording || budget.isFull()) {
        this.stopRecord();
        return;
      }
      try {
        const raw = grabUpscaled(host, this.factor());
        if (budget.tryAdd()) {
          const frame = this.maybeCircularMask(raw, true);
          const canvas = this.imageToCanvas(frame);
          gifRef.addFrame(canvas, { delay: budget.frameDelayMs(), copy: true });
          this.status.textContent = `Recording… ${budget.remaining()} frames left`;
        }
      } catch (err) {
        console.error("[capture] gif frame error", err);
      }
      if (budget.isFull()) {
        this.stopRecord();
      }
    }, budget.frameDelayMs());
  }

  private imageToCanvas(image: RgbaImage): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    const clampedData = new Uint8ClampedArray(image.data.length);
    clampedData.set(image.data);
    const imageData = new ImageData(clampedData, image.width, image.height);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  private stopRecord(): void {
    if (this.recTimer !== null) {
      clearInterval(this.recTimer);
      this.recTimer = null;
    }
    this.recording = false;
    this.recBtn.textContent = "Record GIF";
    this.recBtn.classList.remove("capture-btn--recording");
    // K: release the recording's backlight hold (fire-and-forget, never throws).
    void this.setBacklightHold(false);
    if (this.gif) {
      this.gif.render();
      this.gif = null;
      this.status.textContent = "Encoding GIF…";
    }
  }
}
