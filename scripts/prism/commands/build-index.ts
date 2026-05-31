// build-index — scan catalog/entries/*.json and emit a condensed
// catalog/index.json containing just the fields the AI router + gallery
// page need at runtime. Only entries with annotation: non-null are
// included — pending entries are counted separately.
//
// Side effect: mints a 6-char short_id for any entry missing one and
// writes it back to disk. Stable after first mint so external share
// URLs (prism.run/?g=<short_id>) never rot.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CatalogEntry } from "../entry-types";
import { mintShortId } from "../short-id";

export interface IndexEntry {
  id: string;
  /** 6-char base62 share token. Always present after build-index runs. */
  short_id: string;
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
  atelier: boolean;
  brand_safe: boolean;
  textures_needed: string[];
  /** Source info — what backend loads this entry and how. Used by the
   *  landing-page rotation to synthesize a prism.graph and dispatch
   *  via the runtime without needing to fetch per-entry JSONs. */
  source_type: "milkdrop" | "shadertoy" | "isf" | "wgsl";
  source_loader: "url" | "npm-butterchurn-presets";
  source_url?: string;
  source_ref?: string;
  /** Default image bound to iChannel1 for image-input shaders. */
  default_image?: string;
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

  // First pass: load every entry, collect already-claimed short_ids,
  // mint fresh ones for any entry missing one, write those back to disk.
  // We do this for ALL entries (not just annotated) so the share-token
  // space is contiguous and future annotations don't trigger a re-mint
  // burst on the same commit.
  const entries: Array<{ file: string; entry: CatalogEntry }> = [];
  const claimed = new Set<string>();
  for (const file of files) {
    const entry = JSON.parse(readFileSync(join(entriesDir, file), "utf-8")) as CatalogEntry;
    if (entry.short_id) claimed.add(entry.short_id);
    entries.push({ file, entry });
  }
  let mintedCount = 0;
  for (const { file, entry } of entries) {
    if (entry.short_id) continue;
    const id = mintShortId(claimed);
    claimed.add(id);
    // Insert short_id right after `id` for readability in the JSON.
    const reordered: CatalogEntry = { id: entry.id, short_id: id, ...stripId(entry) };
    writeFileSync(
      join(entriesDir, file),
      JSON.stringify(reordered, null, 2) + "\n",
    );
    entry.short_id = id;
    mintedCount++;
  }
  if (mintedCount > 0) {
    console.log(`[build-index] minted ${mintedCount} new short_id${mintedCount === 1 ? "" : "s"}`);
  }

  const annotated: IndexEntry[] = [];
  const total = entries.length;
  for (const { entry } of entries) {
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
      short_id: entry.short_id!,
      slug: entry.id.split(":")[1],
      name: entry.display.name,
      author: entry.display.author,
      blurb: entry.display.blurb,
      vibe: a.vibe,
      motion: a.motion,
      audio_affinity: a.audio_affinity,
      techniques: a.techniques ?? [],
      technical_notes: a.technical_notes ?? null,
      atelier: a.atelier ?? false,
      brand_safe: a.brand_safe,
      textures_needed: (entry.assets.textures_needed ?? []).map((t) => t.name),
      source_type: entry.source.type,
      source_loader: entry.source.loader,
      source_url: entry.source.url,
      source_ref: entry.source.ref,
      default_image: entry.assets.default_image,
      video: entry.assets.video,
      thumb: entry.assets.thumb,
      added_by: entry.contribution.added_by,
      added_at: entry.contribution.added_at,
      captured_at: a.captured_at,
    });
  }
  // Sort: quality-curated first so the first impression is always strong.
  //   Tier 1: brand_safe + atelier + motion > 0.2  (the "feature" tier)
  //   Tier 2: brand_safe + atelier                 (calmer painterly)
  //   Tier 3: brand_safe                           (everything safe)
  //   Tier 4: everything else (purple-heavy, etc.)
  // Within each tier, newer-annotated first, then alpha.
  const tier = (e: IndexEntry): number => {
    if (!e.brand_safe) return 3;
    if (e.atelier && e.motion > 0.2) return 0;
    if (e.atelier) return 1;
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

/** Re-emit `entry` with `id` removed so the caller can prepend it +
 *  short_id in a controlled order. Cheap object spread; keeps JSON
 *  diffs sane (short_id sits beside id, not at the bottom). */
function stripId(entry: CatalogEntry): Omit<CatalogEntry, "id" | "short_id"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, short_id, ...rest } = entry;
  return rest;
}

export interface RegistryEntry {
  name: string;
  source_type: "milkdrop" | "shadertoy" | "isf" | "wgsl";
  source_loader: "url" | "npm-butterchurn-presets";
  source_url?: string;
  source_ref?: string;
  default_image?: string;
}

/** The lookup map that ships inside prism-player so consumers can
 *  resolve a short_id to a playable PrismGraph offline. Keys are short
 *  ids; values are the minimal slice of the catalog entry the runtime
 *  needs to dispatch the right backend. */
export type Registry = Record<string, RegistryEntry>;

function buildRegistry(index: CatalogIndex): Registry {
  const reg: Registry = {};
  for (const e of index.entries) {
    reg[e.short_id] = {
      name: e.name,
      source_type: e.source_type,
      source_loader: e.source_loader,
      source_url: e.source_url,
      source_ref: e.source_ref,
      default_image: e.default_image,
    };
  }
  return reg;
}

export function runBuildIndex(repoRoot: string): void {
  const t0 = Date.now();
  const index = buildIndex(repoRoot);
  // Three destinations:
  // - catalog/index.json (alongside the source-of-truth entries; convenient for debugging)
  // - public/catalog/index.json (served by Vite + Vercel at runtime to the gallery)
  // - packages/prism-player/src/registry.generated.json (bundled into the
  //   npm package so prism.run/?g=<short_id> resolves offline for consumers).
  const json = JSON.stringify(index, null, 2) + "\n";
  const repoOut = join(repoRoot, "catalog/index.json");
  const publicOut = join(repoRoot, "public/catalog/index.json");
  writeFileSync(repoOut, json);
  mkdirSync(join(repoRoot, "public/catalog"), { recursive: true });
  writeFileSync(publicOut, json);

  const registry = buildRegistry(index);
  const registryOut = join(repoRoot, "packages/prism-player/src/registry.generated.json");
  if (existsSync(join(repoRoot, "packages/prism-player/src"))) {
    writeFileSync(registryOut, JSON.stringify(registry, null, 2) + "\n");
  }

  console.log(
    `[build-index] ${index.annotated_count} annotated / ${index.total} total → catalog/index.json + public/catalog/index.json + registry.generated.json (${Object.keys(registry).length} entries, ${Date.now() - t0}ms)`,
  );
}
