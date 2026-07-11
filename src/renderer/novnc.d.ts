// Minimal type surface for @novnc/novnc core/rfb.js (no bundled declarations).
declare module "@novnc/novnc" {
  export interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    /** JPEG quality hint for Tight (0..9, 9 = best/least lossy). */
    qualityLevel: number;
    /** zlib level hint for Tight (0..9, 0 = store, least CPU). */
    compressionLevel: number;
    disconnect(): void;
  }
}
