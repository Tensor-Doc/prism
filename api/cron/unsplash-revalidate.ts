// /api/cron/unsplash-revalidate — Vercel Cron.
//
// Walks unsplash/meta/<id>.json, drops entries older than 30 days, and
// keeps unsplash/index.json in sync.
//
// Unsplash TOS allows caching for ~30 days; this cron enforces that
// limit even if no one looks. Schedule it daily via vercel.json:
//
//   "crons": [
//     { "path": "/api/cron/unsplash-revalidate", "schedule": "0 4 * * *" }
//   ]
//
// Vercel requires the cron handler to be a GET endpoint. It also passes
// an Authorization header containing CRON_SECRET if the env var is set;
// we use that as a simple gate against drive-by invocations.

import {
  exists,
  getJson,
  isR2Enabled,
  listKeys,
  putJson,
} from "../_lib/r2";
import { policy } from "../_lib/unsplash-cache";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type {} from "../_lib/r2";

export const config = { runtime: "nodejs" };

const INDEX_KEY = "unsplash/index.json";
const META_PREFIX = "unsplash/meta/";
const PHOTOS_PREFIX = "unsplash/photos/";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface CachedMeta {
  id: string;
  cached_at: string;
}

interface VercelLikeReq {
  headers?: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status: (code: number) => VercelLikeRes;
  json: (body: unknown) => void;
}

function authOk(req: VercelLikeReq): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not enforced
  const header = req.headers?.["authorization"];
  const got = Array.isArray(header) ? header[0] : header;
  return got === `Bearer ${secret}`;
}

export default async function handler(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  if (!authOk(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!isR2Enabled()) {
    res.status(200).json({ ok: true, skipped: "R2 not configured" });
    return;
  }
  const p = policy();
  if (!p.enabled) {
    res.status(200).json({ ok: true, skipped: "cache disabled" });
    return;
  }

  const now = Date.now();
  const metaKeys = await listKeys(META_PREFIX, 1000);
  const survivors: string[] = [];
  const stats = { scanned: 0, expired: 0, kept: 0, missing: 0, byteFiles: 0 };

  for (const key of metaKeys) {
    stats.scanned++;
    const id = key.replace(/^unsplash\/meta\//, "").replace(/\.json$/, "");
    const meta = await getJson<CachedMeta>(key);
    if (!meta || !meta.cached_at) {
      // Corrupt entry — treat as expired.
      stats.missing++;
      // Note: we don't have DELETE in the helper yet; we leave the
      // orphan in place. Future cleanup would delete here.
      continue;
    }
    const age = now - Date.parse(meta.cached_at);
    if (age > MAX_AGE_MS) {
      stats.expired++;
      // Same caveat — no delete yet. The id is dropped from the index,
      // which makes the entry unreachable in the search-endpoint fallback.
      // Bytes (if present) also become orphaned; future delete pass can
      // sweep them.
      if (await exists(`${PHOTOS_PREFIX}${id}.jpg`)) stats.byteFiles++;
      continue;
    }
    stats.kept++;
    survivors.push(id);
  }

  // Rewrite the index with only the surviving ids.
  await putJson(INDEX_KEY, {
    ids: survivors,
    generated_at: new Date().toISOString(),
  });

  res.status(200).json({ ok: true, ...stats, survivors_count: survivors.length });
}
