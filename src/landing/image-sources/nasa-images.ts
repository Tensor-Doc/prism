// nasa-images.ts — image source backed by the NASA Image Library.
// Fetches real image references via images-api.nasa.gov (no key required,
// CORS-enabled) and constructs the asset URLs at images-assets.nasa.gov.
// On each construction we pick a random search query so different sessions
// get different sets of images.

import type { ImageSource } from "./types";

const SEARCH_QUERIES = [
  "hubble nebula",
  "james webb deep field",
  "carina nebula",
  "andromeda galaxy",
  "ring nebula",
  "horsehead nebula",
  "pillars of creation",
  "orion nebula",
];

interface NasaSearchResponse {
  collection?: {
    items?: Array<{
      data?: Array<{ nasa_id?: string; title?: string }>;
    }>;
  };
}

/** images-assets.nasa.gov serves the asset files but doesn't include
 *  Access-Control-Allow-Origin headers, so cross-origin Image loads with
 *  crossOrigin="anonymous" fail. We proxy through our own Vercel Edge
 *  function (see /api/image-proxy.ts) which fetches the asset and adds
 *  the CORS headers. Same-origin (the API is on the deployed domain)
 *  so the browser is happy. */
const proxy = (rawUrl: string): string => {
  return `/api/image-proxy?url=${encodeURIComponent(rawUrl)}`;
};

async function fetchNasaImageUrls(): Promise<string[]> {
  try {
    const q = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
    const apiUrl =
      `https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}` +
      `&media_type=image&page_size=24`;
    const res = await fetch(apiUrl);
    if (!res.ok) return [];
    const data = (await res.json()) as NasaSearchResponse;
    const items = data.collection?.items;
    if (!Array.isArray(items)) return [];
    const urls: string[] = [];
    for (const item of items) {
      const id = item.data?.[0]?.nasa_id;
      if (typeof id === "string" && id.length > 0) {
        // ~medium is generally available; CORS-proxied through weserv so the
        // Image element can use crossOrigin="anonymous" successfully.
        urls.push(proxy(`https://images-assets.nasa.gov/image/${id}/${id}~medium.jpg`));
      }
    }
    return urls;
  } catch (err) {
    console.warn("[prism] NASA image library fetch failed:", err);
    return [];
  }
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

export class NasaImagesSource implements ImageSource {
  readonly id = "nasa-deep-space";
  readonly type = "nasa-apod" as const;

  private images: HTMLImageElement[] = [];
  private loading = false;
  private lastIndex = -1;

  /** Begin loading. Resolves once at least one image is available, or all
   *  attempts have settled (whichever first). Subsequent calls are no-ops. */
  async ensureLoaded(): Promise<void> {
    if (this.images.length > 0 || this.loading) return;
    this.loading = true;
    try {
      const urls = await fetchNasaImageUrls();
      if (urls.length === 0) {
        console.warn("[prism] NASA image library returned no results");
        return;
      }
      // Fire all loads in parallel; failures are silently filtered out so
      // we end up with whichever subset actually returned 200 OK.
      const results = await Promise.allSettled(urls.map((u) => loadImage(u)));
      for (const r of results) {
        if (r.status === "fulfilled") this.images.push(r.value);
      }
      if (this.images.length === 0) {
        console.warn("[prism] NASA images: all loads failed");
      }
    } finally {
      this.loading = false;
    }
  }

  isReady(): boolean { return this.images.length > 0; }

  async sample(target: HTMLCanvasElement | OffscreenCanvas): Promise<boolean> {
    if (!this.isReady()) {
      void this.ensureLoaded();
      return false;
    }
    // Pick a different image from last time when possible.
    let next = Math.floor(Math.random() * this.images.length);
    if (this.images.length > 1 && next === this.lastIndex) {
      next = (next + 1) % this.images.length;
    }
    this.lastIndex = next;
    const img = this.images[next];

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
    return true;
  }

  defaultPeriodMs(): number { return 4500; }
}
