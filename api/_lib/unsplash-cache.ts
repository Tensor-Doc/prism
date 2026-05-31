// unsplash-cache.ts — toggle + capacity policy for the dev R2 cache.
//
// PURPOSE & LEGAL POSTURE
// -----------------------
// While we're building Prism on the Unsplash free tier (50 search calls/hr,
// strict hotlink-only TOS), we cache a small bounded number of photo
// metadata entries in our own R2 bucket so the app can keep showing
// imagery during rate-limit windows in development.
//
// The cache is intentionally **capped at 50 entries**. This is small
// enough that the intent is unambiguous — a development affordance,
// not a redistribution mechanism. Once Prism qualifies for a paid
// Unsplash production tier (5,000 calls/hr), this cache is meant to be
// disabled entirely by setting UNSPLASH_R2_ENABLED=false.
//
// CONTROLS
// --------
//   UNSPLASH_R2_ENABLED   "true" / "1" → cache on (default if R2 is configured)
//                         "false" / "0" → cache off (graceful, hot path becomes
//                                         Unsplash-only; 429s surface as errors)
//   UNSPLASH_R2_CAP       Numeric cap on photo metadata entries.
//                         Defaults to 50; do not raise without explicit
//                         legal sign-off.

import { getJson, isR2Enabled } from "./r2";

const DEFAULT_CAP = 50;

export interface CachePolicy {
  enabled: boolean;
  cap: number;
}

let cachedPolicy: CachePolicy | null = null;
export function policy(): CachePolicy {
  if (cachedPolicy) return cachedPolicy;
  const r2Up = isR2Enabled();
  const explicit = (process.env.UNSPLASH_R2_ENABLED ?? "").toLowerCase().trim();
  const enabled = r2Up && (explicit === "" ? true : explicit === "true" || explicit === "1");
  const capStr = process.env.UNSPLASH_R2_CAP;
  const capNum = capStr ? Number(capStr) : DEFAULT_CAP;
  const cap = Number.isFinite(capNum) && capNum > 0 ? Math.floor(capNum) : DEFAULT_CAP;
  cachedPolicy = { enabled, cap };
  return cachedPolicy;
}

interface IndexShape {
  ids?: string[];
}

/** Check whether the index has room for another entry under the cap.
 *  Returns null if caching is disabled; the policy() check upstream
 *  should usually catch that first but the redundant null keeps callers
 *  honest. */
export async function hasRoom(indexKey: string): Promise<{ allowed: boolean; size: number; cap: number } | null> {
  const p = policy();
  if (!p.enabled) return null;
  const idx = (await getJson<IndexShape>(indexKey)) ?? {};
  const size = (idx.ids ?? []).length;
  return { allowed: size < p.cap, size, cap: p.cap };
}
