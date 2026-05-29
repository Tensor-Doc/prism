// spectrum.ts — multi-band FFT bar display.
// Reads pre-computed log-binned bars from AudioFeatures.bars[], draws them as
// cyan vertical bars with subtle peak markers. Pure ambient state — has its
// own RAF loop that decays bars when no update arrives.

export class Spectrum {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);
  private w = 0;
  private h = 0;
  private bars: number[] = [];
  private peaks: number[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas2D unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", this.resize, { passive: true });
    requestAnimationFrame(this.loop);
  }

  update(bars: number[]): void {
    if (this.bars.length !== bars.length) {
      this.bars = new Array(bars.length).fill(0);
      this.peaks = new Array(bars.length).fill(0);
    }
    for (let i = 0; i < bars.length; i++) {
      this.bars[i] = bars[i];
      if (bars[i] > this.peaks[i]) this.peaks[i] = bars[i];
    }
  }

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    if (this.w <= 0 || this.h <= 0) return;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  private loop = (): void => {
    if (this.w > 0 && this.h > 0) this.draw();
    // peak decay even with no update
    for (let i = 0; i < this.peaks.length; i++) this.peaks[i] *= 0.97;
    requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const { ctx, w, h, bars, peaks } = this;
    ctx.clearRect(0, 0, w, h);
    if (bars.length === 0) return;
    const n = bars.length;
    const gap = 2;
    const barW = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const v = bars[i];
      const bh = Math.max(1, v * h);
      const x = i * (barW + gap);
      const y = h - bh;
      // body
      ctx.fillStyle = `rgba(61, 255, 229, ${(0.22 + v * 0.65).toFixed(3)})`;
      ctx.fillRect(x, y, barW, bh);
      // peak marker
      const py = h - peaks[i] * h;
      ctx.fillStyle = `rgba(245, 243, 238, ${(0.35 + peaks[i] * 0.35).toFixed(3)})`;
      ctx.fillRect(x, py, barW, 1);
    }
  }
}
