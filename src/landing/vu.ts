// vu.ts — a tiny VU bar widget for the SOURCES panel.
// Each instance draws into its own canvas, runs its own animation frame
// loop, and exposes push(value 0..1). Bars decay automatically so the
// row keeps moving even if pushes stop.

const COLOR_RGB = {
  cyan: "61, 255, 229",
  orange: "255, 120, 71",
  lime: "183, 255, 92",
  hot: "255, 46, 99",
} as const;

export type VuColor = keyof typeof COLOR_RGB;

export class Vu {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);
  private readonly samples: number[] = new Array(24).fill(0);
  private readonly rgb: string;
  private w = 0;
  private h = 0;
  private active = false;
  private decay = 0.94;

  constructor(canvas: HTMLCanvasElement, color: VuColor = "cyan") {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas2D unavailable");
    this.ctx = ctx;
    this.rgb = COLOR_RGB[color];
    this.resize();
    window.addEventListener("resize", this.resize, { passive: true });
    requestAnimationFrame(this.loop);
  }

  push(v: number): void {
    this.active = true;
    this.samples.shift();
    this.samples.push(Math.max(0, Math.min(1, v)));
  }

  setActive(active: boolean): void { this.active = active; }

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
    if (this.active) {
      for (let i = 0; i < this.samples.length; i++) this.samples[i] *= this.decay;
    }
    requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const { ctx, w, h, samples } = this;
    ctx.clearRect(0, 0, w, h);
    const n = samples.length;
    const gap = 1;
    const barW = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const v = samples[i];
      const bh = Math.max(1, v * h);
      const x = i * (barW + gap);
      const y = h - bh;
      const alpha = this.active ? 0.16 + v * 0.75 : 0.07;
      ctx.fillStyle = `rgba(${this.rgb}, ${alpha.toFixed(3)})`;
      ctx.fillRect(x, y, barW, bh);
    }
  }
}
