// build-index — scan catalog/entries/*.json and emit a condensed
// catalog/index.json containing just the fields the AI router + gallery
// page need at runtime. Only entries with annotation: non-null are
// included — pending entries are counted separately.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CatalogEntry } from "../entry-types";

export interface IndexEntry {
  id: string;
  slug: string;
  name: string;
  author?: string;
  blurb?: string;
  vibe: string[];
  motion: number;
  audio_affinity: { bass: number; mid: number; treble: number };
  techniques: string[];
  /** Gemini-generated 2-3 sentence shader-dialect description; surfaced
   *  in the gallery card tooltip. Null for hand-seeded entries that
   *  haven't been re-annotated yet. */
  technical_notes: string | null;
  refik_mode: boolean;
  brand_safe: boolean;
  textures_needed: string[];
  video?: string;
  thumb?: string;
  added_by?: string;
  /** ISO timestamp the entry was added to the catalog (PR merge / ingest). */
  added_at?: string;
  /** ISO timestamp of the most-recent annotation run. The gallery uses
   *  this for newest-first sorting so freshly-annotated entries surface. */
  captured_at?: string;
}

export interface CatalogIndex {
  schema_version: 2;
  generated_at: string;
  total: number;            // every entry in catalog/entries/
  annotated_count: number;  // entries with annotation != null
  pending_count: number;    // total - annotated_count
  entries: IndexEntry[];    // only annotated entries
}

export function buildIndex(repoRoot: string): CatalogIndex {
  const entriesDir = join(repoRoot, "catalog/entries");
  if (!existsSync(entriesDir)) {
    throw new Error(`no catalog/entries/ at ${entriesDir}`);
  }
  const files = readdirSync(entriesDir).filter((f) => f.endsWith(".json"));
  const annotated: IndexEntry[] = [];
  let total = 0;
  for (const file of files) {
    total++;
    const entry = JSON.parse(readFileSync(join(entriesDir, file), "utf-8")) as CatalogEntry;
    if (!entry.annotation) continue;
    if (entry.compatibility?.renders === false) continue;
    // Gallery only shows entries with real, externally-accessible media.
    // Legacy hand-seeded entries reference local /videos/ paths that
    // don't exist — skip until they're re-annotated through the
    // capture+R2 pipeline. R2 URLs start with https://.
    const video = entry.assets.video;
    if (!video || !video.startsWith("https://")) continue;
    const a = entry.annotation;
    annotated.push({
      id: entry.id,
      slug: entry.id.split(":")[1],
      name: entry.display.name,
      author: entry.display.author,
      blurb: entry.display.blurb,
      vibe: a.vibe,
      motion: a.motion,
      audio_affinity: a.audio_affinity,
      techniques: a.techniques ?? [],
      technical_notes: a.technical_notes ?? null,
      refik_mode: a.refik_mode ?? false,
      brand_safe: a.brand_safe,
      textures_needed: (entry.assets.textures_needed ?? []).map((t) => t.name),
      video: entry.assets.video,
      thumb: entry.assets.thumb,
      added_by: entry.contribution.added_by,
      added_at: entry.contribution.added_at,
      captured_at: a.captured_at,
    });
  }
  // Sort: quality-curated first so the first impression is always strong.
  //   Tier 1: brand_safe + refik_mode + motion > 0.2  (the "feature" tier)
  //   Tier 2: brand_safe + refik_mode                  (calmer painterly)
  //   Tier 3: brand_safe                               (everything safe)
  //   Tier 4: everything else (purple-heavy, etc.)
  // Within each tier, newer-annotated first, then alpha.
  const tier = (e: IndexEntry): number => {
    if (!e.brand_safe) return 3;
    if (e.refik_mode && e.motion > 0.2) return 0;
    if (e.refik_mode) return 1;
    return 2;
  };
  annotated.sort((a, b) => {
    const tA = tier(a), tB = tier(b);
    if (tA !== tB) return tA - tB;
    const aT = a.captured_at ?? a.added_at ?? "";
    const bT = b.captured_at ?? b.added_at ?? "";
    if (aT !== bT) return aT < bT ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    total,
    annotated_count: annotated.length,
    pending_count: total - annotated.length,
    entries: annotated,
  };
}

export function runBuildIndex(repoRoot: string): void {
  const t0 = Date.now();
  const index = buildIndex(repoRoot);
  // Two destinations:
  // - catalog/index.json (alongside the source-of-truth entries; convenient for debugging)
  // - public/catalog/index.json (served by Vite + Vercel at runtime to the gallery)
  const json = JSON.stringify(index, null, 2) + "\n";
  const repoOut = join(repoRoot, "catalog/index.json");
  const publicOut = join(repoRoot, "public/catalog/index.json");
  writeFileSync(repoOut, json);
  mkdirSync(join(repoRoot, "public/catalog"), { recursive: true });
  writeFileSync(publicOut, json);
  console.log(
    `[build-index] ${index.annotated_count} annotated / ${index.total} total → catalog/index.json + public/catalog/index.json (${Date.now() - t0}ms)`,
  );
}
