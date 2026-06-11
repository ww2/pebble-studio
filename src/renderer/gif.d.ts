declare module "gif.js" {
  interface GIFOptions {
    workers?: number;
    quality?: number;
    width?: number;
    height?: number;
    workerScript?: string;
    repeat?: number;
    transparent?: number | null;
    background?: string;
    debug?: boolean;
    dither?: boolean;
  }
  interface FrameOptions {
    delay?: number;
    copy?: boolean;
  }
  class GIF {
    constructor(options: GIFOptions);
    addFrame(image: HTMLCanvasElement | CanvasRenderingContext2D | ImageData, options?: FrameOptions): void;
    render(): void;
    abort(): void;
    on(event: "finished", cb: (blob: Blob, data: Uint8Array) => void): this;
    on(event: "progress", cb: (fraction: number) => void): this;
    on(event: "start" | "abort", cb: () => void): this;
    running: boolean;
  }
  export = GIF;
}
