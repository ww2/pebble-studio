export interface FrameBudgetOptions { fps: number; maxSeconds: number; }

export class FrameBudget {
  private readonly max: number;
  private count = 0;
  constructor(private readonly opts: FrameBudgetOptions) {
    this.max = Math.max(1, Math.floor(opts.fps * opts.maxSeconds));
  }
  tryAdd(): boolean {
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }
  isFull(): boolean { return this.count >= this.max; }
  remaining(): number { return this.max - this.count; }
  frameDelayMs(): number { return Math.round(1000 / this.opts.fps); }
}
