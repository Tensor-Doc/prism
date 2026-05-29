// capture-milkdrop.ts — end-to-end runner: enumerate Minimal pack presets,
// capture a 16:9 video of each, annotate via Gemini, write to catalog.
//
// Each preset is processed independently so a failure on one doesn't kill
// the batch. Limited concurrency keeps the headless Chromium processes
// from saturating the machine.
//
// Run with:
//   pnpm tsx scripts/capture-milkdrop.ts
//
// Required env:
//   GEMINI_API_KEY                 — required for annotation
//   PRISM_CAPTURE_BASE_URL         — defaults to http://localhost:5174
//                                    (start `pnpm dev` first)
//
// Output:
//   catalog/catalog.json           — unified catalog (upserted per preset)
//   catalog/videos/milkdrop_*.webm — captured videos
//
// To re-annotate without re-capturing, set PRISM_REANNOTATE=1.

import { join } from "node:path";
import { promises as fs } from "node:fs";
import { MilkdropRenderer } from "./pipelines/renderers/milkdrop";
import { captureVideo } from "./pipelines/capture";
import { annotateVideo } from "./pipelines/annotate";
import { upsertCatalogEntry, entryExists } from "./pipelines/storage";
import type { CaptureConfig } from "./pipelines/types";

const REPO_ROOT = process.cwd();
const CATALOG_DIR = join(REPO_ROOT, "catalog");
const CATALOG_PATH = join(CATALOG_DIR, "catalog.json");
const VIDEOS_DIR = join(CATALOG_DIR, "videos");

const CAPTURE: CaptureConfig = {
  width: 1280,
  height: 720, // 16:9
  durationMs: 6_000,
  fps: 30,
  format: "webm",
  readyTimeoutMs: 20_000,
};

const CONCURRENCY = 3;
const ANNOTATION_VERSION = 1;

const REANNOTATE = process.env.PRISM_REANNOTATE === "1";

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function processOne(
  renderer: MilkdropRenderer,
  ref: { id: string; displayName: string; author?: string },
): Promise<void> {
  const canonicalId = `${renderer.sourceType}:${slug(ref.id)}`;

  const present = await entryExists(CATALOG_PATH, canonicalId);
  if (present && !REANNOTATE) {
    console.log(`· skip (already in catalog): ${ref.id}`);
    return;
  }

  const videoFile = `milkdrop_${slug(ref.id)}.webm`;
  const videoPath = join(VIDEOS_DIR, videoFile);

  if (!(await fileExists(videoPath))) {
    console.log(`▶ capture: ${ref.id}`);
    await captureVideo(renderer.getRenderUrl(ref.id), videoPath, CAPTURE);
  } else {
    console.log(`· reuse video: ${videoFile}`);
  }

  console.log(`☆ annotate: ${ref.id}`);
  const annotation = await annotateVideo(videoPath, {
    sourceType: renderer.sourceType,
    presetId: ref.id,
    author: ref.author,
  });

  await upsertCatalogEntry(CATALOG_PATH, {
    id: canonicalId,
    source_type: renderer.sourceType,
    preset_id: ref.id,
    display_name: ref.displayName,
    author: ref.author,
    ...annotation,
    video_path: join("videos", videoFile),
    captured_at: new Date().toISOString(),
    duration_ms: CAPTURE.durationMs,
    annotation_model: "gemini-2.5-pro",
    annotation_version: ANNOTATION_VERSION,
  });
  console.log(`✓ done: ${ref.id}`);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  const renderer = new MilkdropRenderer();
  const presets = await renderer.listPresets();
  console.log(`Found ${presets.length} milkdrop presets in Minimal pack.`);

  // Process in batches of CONCURRENCY.
  for (let i = 0; i < presets.length; i += CONCURRENCY) {
    const batch = presets.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (p) => {
        try {
          await processOne(renderer, p);
        } catch (err) {
          console.error(`✗ failed: ${p.id} —`, (err as Error).message);
        }
      }),
    );
  }
  console.log("All presets processed. Catalog at", CATALOG_PATH);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
