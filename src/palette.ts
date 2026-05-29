// NASA image palette atlas — N images composited as a horizontal strip.
// CPU samples (used for emitter colors) and the full strip is uploaded as a
// GPU texture (used for full-surface paint injection in the compute shader).

const SLOT_W = 256;
const SLOT_H = 256;
const N_SLOTS = 4;
const STRIP_W = SLOT_W * N_SLOTS;

const FALLBACK_HUES = [200, 320, 35, 270];

export interface PaletteStrip {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export class Palette {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private imageData: ImageData;
  public version = 0;
  public sourceLabels: string[] = new Array(N_SLOTS).fill("fallback");

  constructor() {
    this.canvas = new OffscreenCanvas(STRIP_W, SLOT_H);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    this.ctx = ctx;
    this.drawFallback();
    this.imageData = this.ctx.getImageData(0, 0, STRIP_W, SLOT_H);
    this.version++;
  }

  private drawFallback(): void {
    const ctx = this.ctx;
    for (let i = 0; i < N_SLOTS; i++) {
      const hue = FALLBACK_HUES[i];
      const grad = ctx.createLinearGradient(i * SLOT_W, 0, (i + 1) * SLOT_W, SLOT_H);
      grad.addColorStop(0, `hsl(${hue}, 80%, 18%)`);
      grad.addColorStop(0.5, `hsl(${(hue + 25) % 360}, 80%, 55%)`);
      grad.addColorStop(1, `hsl(${(hue + 55) % 360}, 80%, 30%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(i * SLOT_W, 0, SLOT_W, SLOT_H);

      // Soft radial nebula-ish bursts in each slot.
      for (let b = 0; b < 4; b++) {
        const cx = i * SLOT_W + (Math.sin(b * 1.7 + i) * 0.35 + 0.5) * SLOT_W;
        const cy = (Math.cos(b * 2.3 + i) * 0.35 + 0.5) * SLOT_H;
        const r = 40 + b * 22;
        const burst = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const bh = (hue + b * 30) % 360;
        burst.addColorStop(0, `hsla(${bh}, 90%, 75%, 0.45)`);
        burst.addColorStop(1, `hsla(${bh}, 90%, 40%, 0)`);
        ctx.fillStyle = burst;
        ctx.fillRect(0, 0, STRIP_W, SLOT_H);
      }
    }
  }

  async loadIntoSlot(index: number, url: string, label?: string): Promise<boolean> {
    if (index < 0 || index >= N_SLOTS) return false;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load ${url}`));
        img.src = url;
      });
      // Scale and copy into the slot region.
      this.ctx.clearRect(index * SLOT_W, 0, SLOT_W, SLOT_H);
      this.ctx.drawImage(img, index * SLOT_W, 0, SLOT_W, SLOT_H);
      this.imageData = this.ctx.getImageData(0, 0, STRIP_W, SLOT_H);
      this.sourceLabels[index] = label ?? "image";
      this.version++;
      return true;
    } catch (e) {
      console.warn(`[prism] palette slot ${index} load failed:`, e);
      return false;
    }
  }

  /** Sample at (u, v) in [0, 1] across the FULL strip. */
  sample(u: number, v: number): [number, number, number] {
    const x = Math.max(0, Math.min(STRIP_W - 1, Math.floor(u * STRIP_W)));
    const y = Math.max(0, Math.min(SLOT_H - 1, Math.floor(v * SLOT_H)));
    const i = (y * STRIP_W + x) * 4;
    const d = this.imageData.data;
    return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
  }

  getStrip(): PaletteStrip {
    return { data: this.imageData.data, width: STRIP_W, height: SLOT_H };
  }

  getSourceCanvas(): OffscreenCanvas {
    return this.canvas;
  }

  get slotCount(): number {
    return N_SLOTS;
  }

  get slotWidth(): number {
    return SLOT_W;
  }

  get slotHeight(): number {
    return SLOT_H;
  }
}

const NASA_API_KEY = (import.meta.env.VITE_NASA_API_KEY as string | undefined) ?? "DEMO_KEY";

// NASA's CDNs don't send Access-Control-Allow-Origin, so we route image URLs
// through images.weserv.nl which re-serves them with proper CORS headers.
function corsProxy(url: string): string {
  const stripped = url.replace(/^https?:\/\//, "");
  return `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}&w=512&h=512&fit=cover&output=jpg`;
}

const FALLBACK_URLS: Array<{ url: string; label: string }> = [
  { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/NGC_6357.jpg/600px-NGC_6357.jpg", label: "NGC 6357" },
  { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Carina_Nebula.jpg/600px-Carina_Nebula.jpg", label: "Carina Nebula" },
  { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/68/NGC_4414_%28NASA-med%29.jpg/600px-NGC_4414_%28NASA-med%29.jpg", label: "NGC 4414" },
  { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Pillars_2014_HST_WFC3-UVIS_full-res_denoised.jpg/600px-Pillars_2014_HST_WFC3-UVIS_full-res_denoised.jpg", label: "Pillars of Creation" },
];

interface ApodItem {
  media_type?: string;
  url?: string;
  hdurl?: string;
  title?: string;
}

async function fetchApod(count: number): Promise<Array<{ url: string; label: string }>> {
  try {
    const apiUrl = `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}&count=${count * 3}`;
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const items = (await res.json()) as ApodItem[];
    return items
      .filter((i) => i.media_type === "image" && typeof i.url === "string")
      .slice(0, count)
      .map((i) => ({
        url: corsProxy(i.url as string),
        label: (i.title ?? "APOD").slice(0, 30),
      }));
  } catch (e) {
    console.warn("[prism] APOD fetch failed:", e);
    return [];
  }
}

export async function loadDefaultPalette(palette: Palette): Promise<void> {
  // Try APOD API first for fresh random NASA images (proxied for CORS).
  const apod = await fetchApod(N_SLOTS);
  if (apod.length >= N_SLOTS) {
    const results = await Promise.all(
      apod.map((c, i) => palette.loadIntoSlot(i, c.url, c.label)),
    );
    const loaded = results.filter(Boolean).length;
    if (loaded === N_SLOTS) {
      console.log(`[prism] palette loaded ${loaded} APOD images: ${apod.map((a) => a.label).join(", ")}`);
      return;
    }
  }
  // Fall back to known stable Wikipedia NASA images (also proxied for sizing).
  const results = await Promise.all(
    FALLBACK_URLS.map((c, i) => palette.loadIntoSlot(i, corsProxy(c.url), c.label)),
  );
  const loaded = results.filter(Boolean).length;
  console.log(`[prism] palette loaded ${loaded}/${FALLBACK_URLS.length} fallback NASA images`);
}
