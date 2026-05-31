// unsplash-images.ts — image source backed by /api/unsplash.
//
// Calls our server-side proxy (api/unsplash.ts) which talks to the
// Unsplash search API and may fall back to the dev R2 cache when
// rate-limited. Returns hotlink URLs from images.unsplash.com that the
// browser loads directly — TOS-compliant.
//
// Per-photo attribution (artist name + Unsplash link) is exposed via
// `currentAttribution()` so the slideshow card overlay can show
// "Photo by Name on Unsplash" with the appropriate links.

import type { ImageSource } from "./types";

interface Artist {
  name: string;
  username: string;
  profile_url: string;
}

interface PhotoRef {
  id: string;
  url: string;
  fallback_url: string | null;
  width: number;
  height: number;
  color: string | null;
  alt: string | null;
  artist: Artist;
  photo_url: string;
  download_location?: string;
}

interface UnsplashApiResponse {
  query: string;
  source: "unsplash" | "r2";
  policy?: { enabled: boolean; cap: number; size: number };
  photos: PhotoRef[];
}

export interface Attribution {
  artist_name: string;
  artist_profile_url: string;
  photo_url: string;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${url}`));
    img.src = url;
  });
}

/** Loads a photo with a graceful fallback to the cached R2 URL when the
 *  primary hotlink URL fails (deleted photo, network blip, etc.). */
async function loadWithFallback(p: PhotoRef): Promise<HTMLImageElement | null> {
  try {
    return await loadImage(p.url);
  } catch {
    if (!p.fallback_url) return null;
    try {
      return await loadImage(p.fallback_url);
    } catch {
      return null;
    }
  }
}

export class UnsplashImagesSource implements ImageSource {
  readonly id = "unsplash";
  readonly type = "unsplash" as const;

  private photos: PhotoRef[] = [];
  private images: Map<string, HTMLImageElement> = new Map();
  private loading = false;
  private lastIndex = -1;

  /** Begin loading. Resolves once at least one image is ready, or all
   *  attempts have settled. Subsequent calls are no-ops. */
  async ensureLoaded(): Promise<void> {
    if (this.images.size > 0 || this.loading) return;
    this.loading = true;
    try {
      const res = await fetch("/api/unsplash");
      if (!res.ok) {
        console.warn(`[prism] /api/unsplash → ${res.status}`);
        return;
      }
      const data = (await res.json()) as UnsplashApiResponse;
      this.photos = data.photos ?? [];
      if (this.photos.length === 0) {
        console.warn(`[prism] /api/unsplash returned no photos (source=${data.source})`);
        return;
      }
      // Parallel load + dedup-by-id.
      const results = await Promise.allSettled(
        this.photos.map(async (p) => {
          const img = await loadWithFallback(p);
          if (img) this.images.set(p.id, img);
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      if (this.images.size === 0) {
        console.warn(`[prism] Unsplash: all ${this.photos.length} loads failed`);
      } else if (ok < this.photos.length) {
        console.warn(`[prism] Unsplash: ${this.images.size}/${this.photos.length} loaded`);
      }
    } catch (err) {
      console.warn("[prism] /api/unsplash fetch failed:", err);
    } finally {
      this.loading = false;
    }
  }

  isReady(): boolean {
    return this.images.size > 0;
  }

  async sample(target: HTMLCanvasElement | OffscreenCanvas): Promise<boolean> {
    if (!this.isReady()) {
      void this.ensureLoaded();
      return false;
    }
    const loadedPhotos = this.photos.filter((p) => this.images.has(p.id));
    if (loadedPhotos.length === 0) return false;
    let next = Math.floor(Math.random() * loadedPhotos.length);
    if (loadedPhotos.length > 1 && next === this.lastIndex) {
      next = (next + 1) % loadedPhotos.length;
    }
    this.lastIndex = next;
    const photo = loadedPhotos[next];
    const img = this.images.get(photo.id);
    if (!img) return false;

    const ctx = target.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return false;

    const tw = target.width;
    const th = target.height;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const ts = tw / th;
    const is = iw / ih;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (is > ts) { sw = ih * ts; sx = (iw - sw) / 2; }
    else { sh = iw / ts; sy = (ih - sh) / 2; }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, tw, th);

    // Track which photo we last painted so the credit chip can read it.
    this._lastAttribution = {
      artist_name: photo.artist.name,
      artist_profile_url: photo.artist.profile_url,
      photo_url: photo.photo_url,
    };
    // Fire the Unsplash download trigger (gated server-side; off by
    // default). Required by Unsplash TOS when the feature is enabled.
    if (photo.download_location) {
      void fetch(
        `/api/unsplash-track?url=${encodeURIComponent(photo.download_location)}`,
      ).catch(() => undefined);
    }
    return true;
  }

  defaultPeriodMs(): number {
    return 5000;
  }

  /** Returns the attribution for the most-recently-sampled photo so the
   *  slideshow card overlay can show "Photo by X on Unsplash". Null
   *  before the first sample. */
  currentAttribution(): Attribution | null {
    return this._lastAttribution;
  }

  private _lastAttribution: Attribution | null = null;
}
