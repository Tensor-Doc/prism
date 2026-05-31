// /api/unsplash — search Unsplash and (optionally) cache to R2.
//
//   GET /api/unsplash?query=aurora
//   GET /api/unsplash                 // picks a random curated query
//
// Response (200):
//   {
//     query: "aurora",
//     source: "unsplash" | "r2",       // where the metadata came from
//     policy: { enabled, cap, size },  // cache policy snapshot, for debugging
//     photos: PhotoRef[]
//   }
//
// CACHE BEHAVIOUR
// ---------------
// The R2 cache is a small (cap 50) dev affordance for surviving rate-limit
// windows while we're on the Unsplash free tier. See
// api/_lib/unsplash-cache.ts for the rationale.
//
// On Unsplash 200, we:
//   - Always return the photos with images.unsplash.com hotlink URLs
//   - If cache is enabled and has room: also persist metadata to R2 so
//     a future 429 can serve cached entries (still hotlinked, plus an
//     R2 bytes fallback if the cron has populated bytes)
//   - If cache is disabled or full: just return; no R2 writes
//
// On Unsplash 429/error:
//   - If cache enabled and non-empty: serve random cached entries (still
//     hotlinked from images.unsplash.com; the R2 fallback URL is populated
//     only when bytes are present in R2)
//   - Otherwise: surface the error (502)

import { exists, getJson, isR2Enabled, listKeys, publicUrl, putJson } from "./_lib/r2";
import { hasRoom, policy } from "./_lib/unsplash-cache";

// Vercel runtime config — Node.js so we can use the @aws-sdk/client-s3
// helpers in api/_lib/r2.ts.
export const config = { runtime: "nodejs20.x" };

const CURATED_QUERIES = [
  "nebula",
  "aurora",
  "bioluminescence",
  "abstract texture",
  "cosmos",
  "ocean depths",
  "macro nature",
  "geometry",
  "minimal landscape",
];

const RESULTS_PER_SEARCH = 30;
const FALLBACK_SAMPLE_SIZE = 24;
const HOTLINK_WIDTH = 1280;
const PRISM_UTM = "?utm_source=prism&utm_medium=referral";

interface UnsplashUser {
  name?: string;
  username?: string;
  links?: { html?: string };
}
interface UnsplashPhoto {
  id?: string;
  description?: string | null;
  alt_description?: string | null;
  width?: number;
  height?: number;
  color?: string;
  urls?: { raw?: string; full?: string; regular?: string; small?: string };
  links?: { html?: string; download_location?: string };
  user?: UnsplashUser;
}
interface UnsplashSearchResponse {
  results?: UnsplashPhoto[];
}

interface Artist {
  name: string;
  username: string;
  profile_url: string;
}

export interface PhotoRef {
  id: string;
  url: string;                 // hotlink (images.unsplash.com)
  fallback_url: string | null; // R2 bytes (null until cached by cron)
  width: number;
  height: number;
  color: string | null;
  alt: string | null;
  artist: Artist;
  photo_url: string;
  download_location?: string;
}

interface CachedMeta extends PhotoRef {
  query: string;
  cached_at: string;
}

interface CacheIndex {
  ids: string[];          // every known short id
  generated_at: string;
}

const INDEX_KEY = "unsplash/index.json";
const metaKey = (id: string) => `unsplash/meta/${id}.json`;
const photoKey = (id: string) => `unsplash/photos/${id}.jpg`;

function randomQuery(): string {
  return CURATED_QUERIES[Math.floor(Math.random() * CURATED_QUERIES.length)];
}

function hotlinkUrl(raw: string | undefined, width = HOTLINK_WIDTH): string | null {
  if (!raw) return null;
  const url = new URL(raw);
  url.searchParams.set("w", String(width));
  url.searchParams.set("fm", "jpg");
  url.searchParams.set("q", "80");
  url.searchParams.set("fit", "max");
  return url.toString();
}

function profileUrl(user: UnsplashUser | undefined): string {
  const username = user?.username ?? "";
  return `https://unsplash.com/@${username}${PRISM_UTM}`;
}

function photoUrl(p: UnsplashPhoto): string {
  return (p.links?.html ?? "https://unsplash.com") + PRISM_UTM;
}

function toPhotoRef(p: UnsplashPhoto, fallback: string | null): PhotoRef | null {
  if (!p.id) return null;
  const url = hotlinkUrl(p.urls?.regular);
  if (!url) return null;
  return {
    id: p.id,
    url,
    fallback_url: fallback,
    width: p.width ?? 0,
    height: p.height ?? 0,
    color: p.color ?? null,
    alt: p.alt_description ?? p.description ?? null,
    artist: {
      name: p.user?.name ?? "Unknown",
      username: p.user?.username ?? "",
      profile_url: profileUrl(p.user),
    },
    photo_url: photoUrl(p),
    download_location: p.links?.download_location,
  };
}

async function loadIndex(): Promise<CacheIndex> {
  return (await getJson<CacheIndex>(INDEX_KEY)) ?? { ids: [], generated_at: new Date(0).toISOString() };
}

/** Append ids to the index, capped at policy().cap. Returns how many
 *  were actually persisted (some may be rejected when the cap is hit). */
async function appendToIndex(newIds: string[]): Promise<number> {
  const { cap } = policy();
  const index = await loadIndex();
  const existing = new Set(index.ids);
  let added = 0;
  for (const id of newIds) {
    if (existing.size >= cap) break;
    if (!existing.has(id)) {
      existing.add(id);
      added++;
    }
  }
  if (added === 0) return 0;
  await putJson(INDEX_KEY, {
    ids: Array.from(existing),
    generated_at: new Date().toISOString(),
  });
  return added;
}

async function fallbackUrlFor(id: string): Promise<string | null> {
  const base = publicUrl(photoKey(id));
  if (!base) return null;
  // Only return a fallback URL if the bytes actually live in R2 — avoids
  // pointing the browser at a 404 when the cron hasn't run yet.
  if (await exists(photoKey(id))) return base;
  return null;
}

interface VercelLikeReq {
  query?: Record<string, string | string[] | undefined>;
  url?: string;
}
interface VercelLikeRes {
  status: (code: number) => VercelLikeRes;
  json: (body: unknown) => void;
}

export default async function handler(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const rawQuery = pickQueryParam(req, "query");
  const query = rawQuery && rawQuery.trim() ? rawQuery.trim() : randomQuery();
  const cachePolicy = policy();

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    res.status(500).json({ error: "UNSPLASH_ACCESS_KEY not configured" });
    return;
  }

  // Try Unsplash first.
  try {
    const search = new URL("https://api.unsplash.com/search/photos");
    search.searchParams.set("query", query);
    search.searchParams.set("per_page", String(RESULTS_PER_SEARCH));
    search.searchParams.set("orientation", "landscape");
    search.searchParams.set("content_filter", "high");

    const resp = await fetch(search, {
      headers: {
        Authorization: `Client-ID ${key}`,
        "Accept-Version": "v1",
      },
    });

    if (resp.status === 429) {
      console.warn("[unsplash] rate-limited — attempting R2 fallback");
      const fallback = await serveFromCache(query, cachePolicy);
      res.status(fallback.photos.length > 0 ? 200 : 503).json(fallback);
      return;
    }
    if (!resp.ok) {
      throw new Error(`Unsplash ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as UnsplashSearchResponse;
    const results = data.results ?? [];

    const photos: PhotoRef[] = [];
    for (const p of results) {
      const ref = toPhotoRef(p, null);
      if (ref) photos.push(ref);
    }

    // Cache to R2 if enabled and there's room. Cap is policy-enforced
    // (50 by default) so we stay clearly within the "dev affordance"
    // shape that's defensible if Unsplash legal ever asks.
    let cacheSize = 0;
    if (cachePolicy.enabled) {
      const room = await hasRoom(INDEX_KEY);
      cacheSize = room?.size ?? 0;
      if (room && room.allowed) {
        const slotsLeft = cachePolicy.cap - room.size;
        const toCache = photos.slice(0, Math.max(0, slotsLeft));
        const cacheTimestamp = new Date().toISOString();
        await Promise.all(toCache.map(async (ref) => {
          const meta: CachedMeta = { ...ref, query, cached_at: cacheTimestamp };
          try {
            await putJson(metaKey(ref.id), meta);
            // Surface the fallback URL if bytes happen to already be present
            // (e.g. seeded by a prior session that did populate bytes).
            ref.fallback_url = await fallbackUrlFor(ref.id);
          } catch (err) {
            console.warn(`[unsplash] meta write failed for ${ref.id}: ${(err as Error).message}`);
          }
        }));
        const added = await appendToIndex(toCache.map((r) => r.id)).catch((err: Error) => {
          console.warn(`[unsplash] index update failed: ${err.message}`);
          return 0;
        });
        cacheSize += added;
      }
    }

    res.status(200).json({
      query,
      source: "unsplash",
      policy: { enabled: cachePolicy.enabled, cap: cachePolicy.cap, size: cacheSize },
      photos,
    });
  } catch (err) {
    console.warn("[unsplash] live call failed, trying R2:", (err as Error).message);
    try {
      const fallback = await serveFromCache(query, cachePolicy);
      res.status(fallback.photos.length > 0 ? 200 : 502).json(fallback);
    } catch (innerErr) {
      res.status(502).json({ error: `unsplash + r2 both failed: ${(innerErr as Error).message}` });
    }
  }
}

async function serveFromCache(query: string, cachePolicy: { enabled: boolean; cap: number }): Promise<{
  query: string;
  source: "r2";
  policy: { enabled: boolean; cap: number; size: number };
  photos: PhotoRef[];
}> {
  if (!cachePolicy.enabled) {
    return { query, source: "r2", policy: { ...cachePolicy, size: 0 }, photos: [] };
  }
  let index = await loadIndex();
  if (index.ids.length === 0) {
    // Lazy seed: walk /meta/ in case the index was lost.
    const ids = (await listKeys("unsplash/meta/", 1000))
      .map((k) => k.replace(/^unsplash\/meta\//, "").replace(/\.json$/, ""))
      .filter(Boolean);
    if (ids.length === 0) {
      return { query, source: "r2", policy: { ...cachePolicy, size: 0 }, photos: [] };
    }
    await putJson(INDEX_KEY, { ids, generated_at: new Date().toISOString() });
    index = { ids, generated_at: new Date().toISOString() };
  }
  const sample = sampleN(index.ids, FALLBACK_SAMPLE_SIZE);
  const photos = (await Promise.all(sample.map(async (id) => {
    const meta = await getJson<CachedMeta>(metaKey(id));
    if (!meta) return null;
    meta.fallback_url = await fallbackUrlFor(id);
    return meta;
  })))
    .filter((p): p is CachedMeta => p !== null);
  return { query, source: "r2", policy: { ...cachePolicy, size: index.ids.length }, photos };
}

function sampleN<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const pool = items.slice();
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

function pickQueryParam(req: VercelLikeReq, name: string): string | null {
  const v = req.query?.[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? null;
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost");
      return u.searchParams.get(name);
    } catch { /* ignore */ }
  }
  return null;
}
