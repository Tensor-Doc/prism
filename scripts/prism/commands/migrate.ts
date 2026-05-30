// One-shot: round-trip the existing catalog/catalog.json (v1) to
// catalog/entries/<id>.json (v2). Runtime is not changed in this step —
// catalog.json stays in place; the runtime keeps reading it until M5a
// completes. v2 entries become the source of truth once the runtime
// migration in a later slice swaps over.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { CatalogEntry } from "../entry-types";
import { SCHEMA_VERSION } from "../entry-types";

interface LegacyEntry {
  id: string;
  source_type: string;
  preset_id: string;
  display_name: string;
  author?: string;
  vibe: string[];
  motion: number;
  palette_anchor: string[];
  audio_affinity: { bass: number; mid: number; treble: number };
  blurb: string;
  brand_safe?: boolean;
  video_path?: string;
  captured_at: string;
  duration_ms?: number;
  annotation_model: string;
  annotation_version: number;
}

// Hand-picked atelier subset from api/generate.ts; mirrored here so the
// migrated entries carry the atelier flag forward into v2.
const ATELIER_PRESET_IDS = new Set<string>([
  "Geiss - Reaction Diffusion 2",
  "Geiss - Cauldron - painterly 2 (saturation remix)",
  "Flexi - alien fish pond",
  "martin - reflections on black tiles",
  "martin [shadow harlequins shape code] - fata morgana",
  "suksma - uninitialized variabowl (hydroponic chronic)",
  "Zylot - Paint Spill (Music Reactive Paint Mix)",
  "Aderrasi - Songflower (Moss Posy)",
  "flexi + amandio c - organic [random mashup]",
  "flexi + amandio c - organic12-3d-2.milk",
  "Eo.S. + Zylot - skylight (Stained Glass Majesty mix)",
  "flexi - mom, why the sky looks different today",
  "martin - frosty caves 2",
  "suksma - Rovastar - Sunflower Passion (Enlightment Mix)_Phat_edit + flexi und martin shaders - circumflex in character classes in regular expression",
]);

function migrateEntry(legacy: LegacyEntry): CatalogEntry {
  return {
    id: legacy.id,
    schema_version: SCHEMA_VERSION,
    source: {
      type: "milkdrop",
      loader: "npm-butterchurn-presets",
      ref: legacy.preset_id,
      format: "milk-v201",
    },
    display: {
      name: legacy.display_name,
      author: legacy.author,
      blurb: legacy.blurb,
    },
    annotation: {
      vibe: legacy.vibe,
      motion: legacy.motion,
      palette_anchor: legacy.palette_anchor,
      audio_affinity: legacy.audio_affinity,
      techniques: null,
      technical_notes: null,
      brand_safe: legacy.brand_safe ?? true,
      atelier: ATELIER_PRESET_IDS.has(legacy.preset_id),
      model: legacy.annotation_model,
      version: legacy.annotation_version,
      captured_at: legacy.captured_at,
    },
    assets: {
      video: legacy.video_path ? `/${legacy.video_path}` : undefined,
    },
    contribution: {
      added_by: "scottspace",
      added_at: legacy.captured_at,
      license: "MIT",
    },
    compatibility: { renders: true },
  };
}

/** Convert a v2 id ("milkdrop:geiss-reaction-diffusion-2") to an
 *  on-disk filename ("milkdrop_geiss-reaction-diffusion-2.json"). */
function idToFilename(id: string): string {
  return id.replace(":", "_") + ".json";
}

export function runMigrate(repoRoot: string, dryRun = false): { written: number; skipped: number } {
  const legacyPath = join(repoRoot, "catalog/catalog.json");
  const entriesDir = join(repoRoot, "catalog/entries");
  const legacy = JSON.parse(readFileSync(legacyPath, "utf-8")) as LegacyEntry[];
  let written = 0;
  let skipped = 0;
  mkdirSync(entriesDir, { recursive: true });
  for (const entry of legacy) {
    const v2 = migrateEntry(entry);
    const out = join(entriesDir, idToFilename(v2.id));
    if (dryRun) {
      console.log(`would write ${out}`);
      written++;
      continue;
    }
    writeFileSync(out, JSON.stringify(v2, null, 2) + "\n");
    written++;
  }
  console.log(
    `[migrate] wrote ${written} v2 entries to catalog/entries/${
      skipped ? ` (${skipped} skipped)` : ""
    }`,
  );
  return { written, skipped };
}
