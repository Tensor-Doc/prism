// Ingest a folder of presets + textures into the catalog.
//
//   pnpm prism ingest <path>
//
// <path> must contain a `presets/` directory with .milk files at its root
// and optionally a `textures/` directory of image files (jpg/png/bmp).
// Subdirectories of presets/ (Geiss's _5star_copies, _removed_jan_2020,
// etc.) are intentionally skipped.
//
// For each .milk file:
//   1. Slugify the filename → catalog id
//   2. Disambiguate against existing entries
//   3. Copy .milk → public/presets/milkdrop/<slug>.milk
//   4. Parse sampler_<name> references, filter built-ins, resolve to
//      texture filenames under public/textures/
//   5. Write catalog/entries/milkdrop_<slug>.json stub with
//      source.loader = "url", annotation: null, compatibility.renders: true
//      (M5a-test verifies this assumption)
//   6. Update progress tracker
//
// Textures: every file in <path>/textures/ is copied to public/textures/
// (no overwriting if already present and same size).
//
// Idempotent: re-running with a partial copy resumes from the tracker.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";

import { SCHEMA_VERSION, type CatalogEntry } from "../entry-types";
import { Progress, progressPath } from "../progress";
import { extractCustomSamplers, findTextureFile } from "../samplers";
import { disambiguate, entryId, slugify } from "../slugify";

const PUBLIC_PRESETS = "public/presets/milkdrop";
const PUBLIC_TEXTURES = "public/textures";
const CATALOG_ENTRIES = "catalog/entries";

interface IngestStats {
  scanned: number;
  ingested: number;
  skipped: number;
  errored: number;
  textures_copied: number;
}

function authorFromName(rawName: string): string | undefined {
  // After slugify stripping of leading underscores, the original name like
  // "Geiss - Myriad Spirals - cruise mix" has the author first.
  const cleaned = rawName.replace(/^[_\-\s$]+/, "").trim();
  const dash = cleaned.indexOf(" - ");
  if (dash <= 0) return undefined;
  const candidate = cleaned.slice(0, dash).trim();
  // Filter obvious non-author leading tokens.
  if (/^\d+$/.test(candidate)) return undefined;
  return candidate || undefined;
}

function readExistingIds(repoRoot: string): Set<string> {
  const dir = join(repoRoot, CATALOG_ENTRIES);
  if (!existsSync(dir)) return new Set();
  const ids = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    // milkdrop_geiss-x.json → milkdrop:geiss-x
    ids.add(file.replace(/\.json$/, "").replace("_", ":"));
  }
  return ids;
}

function copyTextures(repoRoot: string, sourcePath: string): number {
  const src = join(sourcePath, "textures");
  if (!existsSync(src)) return 0;
  const dst = join(repoRoot, PUBLIC_TEXTURES);
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const file of readdirSync(src)) {
    const srcFile = join(src, file);
    const dstFile = join(dst, file);
    if (!statSync(srcFile).isFile()) continue;
    if (existsSync(dstFile) && statSync(dstFile).size === statSync(srcFile).size) continue;
    copyFileSync(srcFile, dstFile);
    copied++;
  }
  return copied;
}

function availableTextureFiles(repoRoot: string): Set<string> {
  const dir = join(repoRoot, PUBLIC_TEXTURES);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()));
}

function entryFilename(slug: string): string {
  return `milkdrop_${slug}.json`;
}

export function runIngest(repoRoot: string, sourcePath: string, opts: { limit?: number } = {}): IngestStats {
  const presetsDir = join(sourcePath, "presets");
  if (!existsSync(presetsDir)) {
    throw new Error(`no presets/ at ${sourcePath}`);
  }
  const stats: IngestStats = { scanned: 0, ingested: 0, skipped: 0, errored: 0, textures_copied: 0 };

  // Step 1: copy textures first so sampler resolution finds them.
  stats.textures_copied = copyTextures(repoRoot, sourcePath);
  console.log(`[ingest] copied ${stats.textures_copied} texture file(s) → ${PUBLIC_TEXTURES}/`);
  const availableTextures = availableTextureFiles(repoRoot);

  // Step 2: scan root .milk files. Skip subdirectories (Geiss's curation buckets).
  const allFiles = readdirSync(presetsDir).filter((f) => {
    const full = join(presetsDir, f);
    return statSync(full).isFile() && f.toLowerCase().endsWith(".milk");
  });
  stats.scanned = allFiles.length;
  console.log(`[ingest] scanning ${presetsDir}: ${stats.scanned} .milk files at root`);

  const existingIds = readExistingIds(repoRoot);
  const progress = new Progress(progressPath(repoRoot));
  progress.setTotal(stats.scanned);

  mkdirSync(join(repoRoot, PUBLIC_PRESETS), { recursive: true });
  mkdirSync(join(repoRoot, CATALOG_ENTRIES), { recursive: true });

  let processed = 0;
  for (const file of allFiles) {
    if (opts.limit && processed >= opts.limit) break;
    processed++;
    const stem = basename(file, extname(file));
    const srcMilkAbs = join(presetsDir, file);

    // Re-run dedupe: if this source file was already ingested under any
    // slug, reuse that slug. Otherwise disambiguate against existing ids.
    const previous = progress.findBySourceFile(srcMilkAbs);
    const slug = previous?.slug ?? disambiguate(
      slugify(file),
      new Set([...existingIds].map((id) => id.split(":")[1])),
    );
    const id = entryId("milkdrop", slug);

    if (!progress.shouldRun(slug, "ingested")) {
      stats.skipped++;
      continue;
    }

    try {
      const dstMilk = join(repoRoot, PUBLIC_PRESETS, `${slug}.milk`);
      const milkText = readFileSync(srcMilkAbs, "utf-8");
      copyFileSync(srcMilkAbs, dstMilk);

      const customSamplers = extractCustomSamplers(milkText);
      const texturesNeeded = customSamplers.map((name) => {
        const file = findTextureFile(name, availableTextures);
        return { name, ...(file ? { resolved: true } : { resolved: false }) };
      });
      const missing = texturesNeeded.filter((t) => !t.resolved).map((t) => t.name);
      if (missing.length > 0) {
        console.warn(`[ingest]   ⚠ ${slug}: missing textures: ${missing.join(", ")}`);
      }

      const now = new Date().toISOString();
      const entry: CatalogEntry = {
        id,
        schema_version: SCHEMA_VERSION,
        source: {
          type: "milkdrop",
          loader: "url",
          url: `/presets/milkdrop/${slug}.milk`,
          format: "milk-v201",
        },
        display: {
          name: stem.replace(/^[_\-\s$]+/, "").trim(),
          author: authorFromName(stem),
        },
        annotation: null,
        assets: {
          textures_needed: texturesNeeded.map((t) => ({ name: t.name })),
        },
        contribution: {
          added_by: "scottspace",
          added_at: now,
          license: "MIT",
        },
        compatibility: { renders: true }, // optimistic; M5a-test verifies
      };
      const entryPath = join(repoRoot, CATALOG_ENTRIES, entryFilename(slug));
      writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n");

      existingIds.add(id);
      progress.update(slug, {
        slug,
        status: "ingested",
        source_file: srcMilkAbs,
        ingested_at: now,
      });
      stats.ingested++;
      if (stats.ingested <= 5 || stats.ingested % 50 === 0) {
        const tex = customSamplers.length > 0 ? ` (textures: ${customSamplers.join(", ")})` : "";
        console.log(`[ingest] ${stats.ingested}/${stats.scanned} → ${id}${tex}`);
      }
    } catch (err) {
      stats.errored++;
      progress.markError(slug, "ingest", (err as Error).message);
      console.error(`[ingest] ERROR ${slug}: ${(err as Error).message}`);
    }
  }

  console.log(`[ingest] done: ${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errored} errored`);
  console.log(`[ingest] ${progress.summary()}`);
  return stats;
}
