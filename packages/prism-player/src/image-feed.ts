// image-feed.ts — headless slideshow.
//
// Owns a single offscreen canvas, preloads a list of image URLs, and
// crossfades between them on a timer. Shaders read the canvas via the
// player's setLiveSource() — same plumbing as a live video element,
// just sourced from a slideshow instead of a camera.
//
// The site's src/landing/slideshow.ts is a richer surface (drag-resize
// card, progress bar, melt transitions); this is the minimum the npm
// package needs so an OSS consumer can pass image: ["a.jpg", "b.jpg"]
// and get a feed for the shader without writing canvas plumbing.

const DEFAULT_HOLD_SECONDS = 6;
const CROSSFADE_SECONDS = 1.0;
const CANVAS_W = 1280;
const CANVAS_H = 720;

export interface SlideshowOptions {
  /** How long (seconds) each image is held on-screen before the
   *  crossfade to the next begins. Defaults to 6. */
  holdSeconds?: number;
}

export class HeadlessSlideshow {
  /** The output canvas — bind this to the shader via setLiveSource. */
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly urls: string[];
  private readonly holdMs: number;
  private readonly images: Array<HTMLImageElement | null>;
  private currentIndex = 0;
  private nextIndex = 1;
  /** Wall-clock time the current crossfade started, or null if we're
   *  in the steady-hold portion of the cycle. */
  private crossfadeStartMs: number | null = null;
  private holdTimer: number | null = null;
  private rafHandle: number | null = null;
  private destroyed = false;

  constructor(urls: string[], opts: SlideshowOptions = {}) {
    if (urls.length === 0) {
      throw new Error("HeadlessSlideshow: urls list cannot be empty");
    }
    this.urls = urls;
    this.holdMs = Math.max(0.5, opts.holdSeconds ?? DEFAULT_HOLD_SECONDS) * 1000;
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("HeadlessSlideshow: 2D canvas context unavailable");
    this.ctx = ctx;
    this.images = urls.map(() => null);
    void this.preload();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.holdTimer != null) clearTimeout(this.holdTimer);
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
  }

  private async preload(): Promise<void> {
    // Load all images in parallel, but start rendering + cycling as
    // soon as the first one's ready so the shader isn't stuck on a
    // black frame waiting on slow tails.
    const promises = this.urls.map((url, i) =>
      loadImage(url).then(
        (img) => {
          if (this.destroyed) return;
          this.images[i] = img;
          if (i === 0) this.start();
        },
        (err: Error) => {
          // Failure to load one image shouldn't kill the whole feed —
          // leave that slot as null; the render loop skips it.
          console.warn(`[prism-player] image-feed: ${url} → ${err.message}`);
        },
      ),
    );
    await Promise.allSettled(promises);
  }

  private start(): void {
    if (this.destroyed) return;
    this.drawFrame();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.destroyed) return;
    this.holdTimer = window.setTimeout(() => this.advance(), this.holdMs);
  }

  private advance(): void {
    if (this.destroyed) return;
    // Pick the next loaded image, skipping any that failed to load.
    let candidate = (this.currentIndex + 1) % this.urls.length;
    for (let i = 0; i < this.urls.length; i++) {
      if (this.images[candidate]) break;
      candidate = (candidate + 1) % this.urls.length;
    }
    if (candidate === this.currentIndex) {
      // Only one loaded image — nothing to cross to, just re-arm.
      this.scheduleNext();
      return;
    }
    this.nextIndex = candidate;
    this.crossfadeStartMs = performance.now();
    this.rafHandle = requestAnimationFrame(() => this.tickCrossfade());
  }

  private tickCrossfade(): void {
    if (this.destroyed) return;
    if (this.crossfadeStartMs == null) return;
    const t = (performance.now() - this.crossfadeStartMs) / 1000 / CROSSFADE_SECONDS;
    if (t >= 1) {
      // Crossfade finished — commit and queue the next hold.
      this.currentIndex = this.nextIndex;
      this.crossfadeStartMs = null;
      this.drawFrame();
      this.scheduleNext();
      return;
    }
    this.drawCrossfade(t);
    this.rafHandle = requestAnimationFrame(() => this.tickCrossfade());
  }

  /** Draw the current image fully opaque. */
  private drawFrame(): void {
    const img = this.images[this.currentIndex];
    if (!img) return;
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    drawCovered(this.ctx, img, CANVAS_W, CANVAS_H);
  }

  /** Draw the current image, then the next one at alpha=t on top. */
  private drawCrossfade(t: number): void {
    const cur = this.images[this.currentIndex];
    const nxt = this.images[this.nextIndex];
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (cur) drawCovered(this.ctx, cur, CANVAS_W, CANVAS_H);
    if (nxt) {
      this.ctx.save();
      this.ctx.globalAlpha = t;
      drawCovered(this.ctx, nxt, CANVAS_W, CANVAS_H);
      this.ctx.restore();
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

/** Draw `img` covering the (w,h) box — like CSS object-fit: cover.
 *  Cropping rather than letterboxing keeps the slideshow visually full
 *  in the shader's iChannel1, which is usually being sampled by uv
 *  coordinates that assume the whole texture is content. */
function drawCovered(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
): void {
  const srcAR = img.naturalWidth / img.naturalHeight;
  const dstAR = w / h;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (srcAR > dstAR) {
    // image is wider — crop horizontally
    sw = img.naturalHeight * dstAR;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / dstAR;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}
