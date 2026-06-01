// backfill-video-sizes — fill entry.assets.video_size_bytes for entries
// where a local WebM is present in public/videos/. Lets the gallery
// sort by visual richness without re-running annotate on every entry.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CatalogEntry } from "../entry-types";

export function runBackfillVideoSizes(repoRoot: string): void {
  const entriesDir = join(repoRoot, "catalog/entries");
  const videosDir = join(repoRoot, "public/videos");
  if (!existsSync(entriesDir)) {
    throw new Error(`no catalog/entries/ at ${entriesDir}`);
  }
  const files = readdirSync(entriesDir).filter((f) => f.endsWith(".json"));
  let updated = 0;
  let missing = 0;
  let already = 0;
  for (const file of files) {
    const path = join(entriesDir, file);
    const entry = JSON.parse(readFileSync(path, "utf-8")) as CatalogEntry;
    if (entry.assets.video_size_bytes !== undefined) {
      already++;
      continue;
    }
    // Derive the local webm filename from the entry id (e.g.
    // "milkdrop_<slug>.json" → "milkdrop_<slug>.webm"). This matches
    // the naming convention annotate.ts writes.
    const stem = file.replace(/\.json$/, "");
    const webm = join(videosDir, `${stem}.webm`);
    if (!existsSync(webm)) {
      missing++;
      continue;
    }
    entry.assets.video_size_bytes = statSync(webm).size;
    writeFileSync(path, JSON.stringify(entry, null, 2) + "\n");
    updated++;
  }
  console.log(`[backfill-video-sizes] updated ${updated}, already had ${already}, no local webm for ${missing}`);
}
