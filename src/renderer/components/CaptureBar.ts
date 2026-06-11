import GIF from "gif.js";
import { FrameBudget } from "../../capture/gifRecorder.js";
import { grabUpscaled, rgbaToBlob, applyCircularMask } from "../captureCanvas.js";
import type { RgbaImage } from "../../capture/upscale.js";

/** Magenta key color used as the transparent index in round GIFs. */
const GIF_TRANSPARENT_COLOR = 0xff00ff;

export class CaptureBar {
  readonly el: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly shotBtn: HTMLButtonElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly status: HTMLSpanElement;

  private recording = false;
  private gif: InstanceType<typeof GIF> | null = null;
  private recTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getHost: () => HTMLElement | null,
    private readonly isRound: () => boolean = () => false,
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

    // Screenshot button
    this.shotBtn = document.createElement("button");
    this.shotBtn.type = "button";
    this.shotBtn.className = "capture-btn";
    this.shotBtn.dataset.act = "screenshot";
    this.shotBtn.textContent = "Screenshot";
    this.shotBtn.addEventListener("click", () => void this.takeScreenshot());

    // GIF record toggle
    this.recBtn = document.createElement("button");
    this.recBtn.type = "button";
    this.recBtn.className = "capture-btn capture-btn--rec";
    this.recBtn.textContent = "Record GIF";
    this.recBtn.addEventListener("click", () => void this.toggleRecord());

    // Status span
    this.status = document.createElement("span");
    this.status.className = "capture-status";

    this.el.appendChild(label);
    this.el.appendChild(this.select);
    this.el.appendChild(this.shotBtn);
    this.el.appendChild(this.recBtn);
    this.el.appendChild(this.status);
  }

  private factor(): number {
    return parseInt(this.select.value, 10);
  }

  private stamp(): string {
    return String(Date.now());
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
      const raw = grabUpscaled(host, this.factor());
      const frame = this.maybeCircularMask(raw);
      const blob = await rgbaToBlob(frame);
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const name = `pebble-shot-${this.stamp()}.png`;
      const saved = await window.studio.saveCapture(name, bytes);
      this.status.textContent = `Saved: ${saved}`;
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

    const budget = new FrameBudget({ fps: 15, maxSeconds: 8 });
    const stamp = this.stamp();
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
      void blob.arrayBuffer().then((ab) => {
        const bytes = new Uint8Array(ab);
        const name = `pebble-rec-${stamp}.gif`;
        return window.studio.saveCapture(name, bytes).then((saved) => {
          this.status.textContent = `GIF saved: ${saved}`;
        });
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
    if (this.gif) {
      this.gif.render();
      this.gif = null;
      this.status.textContent = "Encoding GIF…";
    }
  }
}
