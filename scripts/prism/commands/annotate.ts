// Annotate one or more catalog entries: capture a 15s WebM of the preset
// rendering against the synthetic audio signal, ask Gemini to describe it
// in the structured shader/Geiss vocabulary + recommend the best
// thumbnail timestamp, write the annotation block back to the entry and
// extract the thumb at the recommended frame.
//
//   pnpm prism annotate <slug>               # one preset (calibration mode)
//   pnpm prism annotate <slug> --reuse-video # re-run Gemini on existing WebM
//   pnpm prism annotate --all                # everything with annotation: null
//   pnpm prism annotate --limit=10           # next 10 unannotated
//
// Prerequisite (unless --reuse-video): `pnpm dev` running in another
// terminal so Vite serves the capture-page Puppeteer navigates to.

import {
  GoogleGenAI, Type, createPartFromUri, createUserContent,
} from "@google/genai";
import ffmpegStaticPath from "ffmpeg-static";
import puppeteer from "puppeteer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ffmpeg-static's postinstall hook is gated behind `pnpm approve-builds`.
// Prefer the bundled binary when it actually exists on disk; otherwise
// fall back to the system ffmpeg (the user usually has one). One of the
// two must work or extractFrame throws.
function resolveFfmpeg(): string {
  if (ffmpegStaticPath && existsSync(ffmpegStaticPath)) return ffmpegStaticPath;
  // Spawn `which ffmpeg` to find a system install — works on macOS/Linux.
  const which = spawnSync("which", ["ffmpeg"]);
  const sys = which.stdout?.toString().trim();
  if (sys && existsSync(sys)) return sys;
  throw new Error(
    "no ffmpeg binary available — try `pnpm approve-builds` to enable ffmpeg-static's postinstall, or `brew install ffmpeg`",
  );
}
import { dirname, join } from "node:path";

import { ANNOTATOR_SYSTEM_INSTRUCTION } from "../annotator-prompt";
import type { CatalogEntry, Annotation } from "../entry-types";
import { Progress, progressPath } from "../progress";
import { isR2Enabled, uploadFile } from "../r2";

const DEV_URL = "http://localhost:5173";
const MILKDROP_CAPTURE_PAGE = "/scripts/pipelines/capture-pages/milkdrop.html";
const SHADERTOY_CAPTURE_PAGE = "/scripts/pipelines/capture-pages/shadertoy.html";
const CAPTURE_DURATION_MS = 15_000;
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const MODEL = "gemini-flash-latest";

// What Gemini must return: the Annotation fields (minus the ones we set
// ourselves: model, version, captured_at) PLUS a recommended thumbnail
// timestamp in seconds (0..15).
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "vibe", "motion", "palette_anchor", "audio_affinity",
    "techniques", "technical_notes", "brand_safe", "atelier",
    "thumbnail_timestamp_seconds",
  ],
  properties: {
    // Tight bounds prevent Gemini from spinning into garbage strings on
    // low-content captures (we hit this with tunnel-of-images: model
    // returned a single 60kb palette entry of repeating digits).
    vibe: { type: Type.ARRAY, minItems: 1, maxItems: 6, items: { type: Type.STRING, maxLength: 40 } },
    motion: { type: Type.NUMBER },
    palette_anchor: { type: Type.ARRAY, minItems: 1, maxItems: 6, items: { type: Type.STRING, maxLength: 9 } },
    audio_affinity: {
      type: Type.OBJECT,
      required: ["bass", "mid", "treble"],
      properties: {
        bass: { type: Type.NUMBER },
        mid: { type: Type.NUMBER },
        treble: { type: Type.NUMBER },
      },
    },
    techniques: { type: Type.ARRAY, minItems: 0, maxItems: 8, items: { type: Type.STRING, maxLength: 40 } },
    technical_notes: { type: Type.STRING, maxLength: 600 },
    brand_safe: { type: Type.BOOLEAN },
    atelier: { type: Type.BOOLEAN },
    thumbnail_timestamp_seconds: {
      type: Type.NUMBER,
      description:
        "Timestamp (in seconds, 0..14.5) of the single frame that best represents this preset visually for a gallery thumbnail. Pick a moment where motion is settled but the characteristic shapes/colors are at their peak.",
    },
  },
} as const;

interface GeminiResponse {
  annotation: Annotation;
  thumbnailTimestamp: number;
}

function entryFilename(slug: string): string {
  return `milkdrop_${slug}.json`;
}

/** Resolve a slug (e.g. "cosmic-flow") to its catalog entry path, trying
 *  both milkdrop_ and shadertoy_ prefixes. Returns null if neither exists. */
function findEntryPath(repoRoot: string, slug: string): string | null {
  for (const prefix of ["milkdrop", "shadertoy"]) {
    const p = join(repoRoot, "catalog/entries", `${prefix}_${slug}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY not set — `export GEMINI_API_KEY=...` first (or set VITE_GEMINI_API_KEY in .env)",
    );
  }
  return key;
}

async function ensureDevServer(): Promise<void> {
  try {
    const res = await fetch(DEV_URL);
    if (!res.ok) throw new Error(`vite responded ${res.status}`);
  } catch (err) {
    throw new Error(
      `Vite dev server not reachable at ${DEV_URL} — run \`pnpm dev\` in another terminal first. (${(err as Error).message})`,
    );
  }
}

/** Build the capture-page URL for an entry. Milkdrop uses the milkdrop
 *  capture page with ?presetUrl=; shadertoy uses the shadertoy page with
 *  ?shaderUrl= (and optionally ?imageUrl= for default iChannel1). */
function buildCaptureUrl(entry: CatalogEntry): string {
  const source = entry.source;
  if (source.type === "shadertoy") {
    const params = new URLSearchParams({ shaderUrl: source.url ?? "" });
    const img = entry.assets.default_image;
    if (img) params.set("imageUrl", img);
    return `${DEV_URL}${SHADERTOY_CAPTURE_PAGE}?${params.toString()}`;
  }
  // milkdrop default
  return `${DEV_URL}${MILKDROP_CAPTURE_PAGE}?presetUrl=${encodeURIComponent(source.url ?? "")}`;
}

async function captureVideo(captureUrl: string): Promise<{ webmBase64: string; firstFrameBase64: string }> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-gpu-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
    ],
    defaultViewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`  [page-error] ${e.message}\n  ${e.stack ?? ""}`));
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.error(`  [page-${t}] ${msg.text()}`);
      }
    });
    await page.goto(captureUrl, { waitUntil: "networkidle0", timeout: 30_000 });
    await page.waitForFunction("window.__prismReady === true", { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1000)); // let blends settle
    const firstFrameBase64 = await page.evaluate(() => {
      const canvas = document.getElementById("vis") as HTMLCanvasElement | null;
      if (!canvas) throw new Error("no canvas");
      return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
    });
    await page.evaluate((ms: number) => {
      (window as unknown as { __prismStartCapture: (ms: number) => void }).__prismStartCapture(ms);
    }, CAPTURE_DURATION_MS);
    await page.waitForFunction("window.__prismCaptureReady === true", {
      timeout: CAPTURE_DURATION_MS + 15_000,
    });
    const webmBase64 = (await page.evaluate("window.__prismVideoBase64")) as string;
    return { webmBase64, firstFrameBase64 };
  } finally {
    await browser.close();
  }
}

async function callGemini(
  ai: GoogleGenAI,
  webmBytes: Buffer,
  display: { name: string; author?: string },
): Promise<GeminiResponse> {
  const file = await ai.files.upload({
    file: new Blob([new Uint8Array(webmBytes)], { type: "video/webm" }),
    config: { mimeType: "video/webm" },
  });
  if (!file.uri || !file.mimeType) throw new Error("gemini upload returned no uri");
  const fileUri = file.uri;
  const fileMime = file.mimeType;
  const fileName = file.name;
  // Files API uploads start in PROCESSING; poll until ACTIVE.
  if (fileName) {
    for (let i = 0; i < 30; i++) {
      const status = await ai.files.get({ name: fileName });
      if (status.state === "ACTIVE") break;
      if (status.state === "FAILED") throw new Error("gemini file processing failed");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // We deliberately do NOT pass the preset name to Gemini. Earlier runs
  // showed Gemini reading a preset name like "...Painterly Tendrils
  // Colorfast" and confabulating a "turbulent advection field with
  // bloom_glow" description for a video that was actually all-black for
  // 15s. The fabricated description shipped to disk as truth. Annotation
  // must be grounded only in what's visible in the captured WebM.
  const prompt = `Watch the 15s capture and produce the annotation JSON.
Describe ONLY what is visually evident in the video — do not infer or
imagine elements that would normally be present in this style of preset.
If the screen is mostly dark or sparse, say so honestly (motion near 0,
vibe like "void"/"dark"/"sparse"). The audio you can infer from the
visual reactions is the test signal loop — refer to it as "the test
signal" or "the audio loop", never as "the music" or "the song".`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: createUserContent([createPartFromUri(fileUri, fileMime), prompt]),
    config: {
      systemInstruction: ANNOTATOR_SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
    },
  });
  const text = response.text;
  if (!text) throw new Error("empty gemini response");
  let raw: (Omit<Annotation, "model" | "version" | "captured_at"> & {
    thumbnail_timestamp_seconds?: number | null;
  });
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error("  [gemini-raw]", text.slice(0, 400));
    throw new Error(`failed to parse gemini JSON: ${(err as Error).message}`);
  }
  const ts = typeof raw.thumbnail_timestamp_seconds === "number"
    ? raw.thumbnail_timestamp_seconds
    : 7.5; // safe middle-of-clip fallback
  // Strip the thumbnail field from what we persist as annotation.
  const { thumbnail_timestamp_seconds: _ts, ...annotationFields } = raw;
  void _ts;
  return {
    annotation: {
      ...annotationFields,
      model: MODEL,
      version: 2,
      captured_at: new Date().toISOString(),
    },
    thumbnailTimestamp: ts,
  };
}

function extractFrame(videoPath: string, timeSeconds: number, outPath: string): void {
  const ffmpeg = resolveFfmpeg();
  const clamped = Math.max(0, Math.min(timeSeconds, 14.5));
  const result = spawnSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-ss", clamped.toString(),
    "-i", videoPath,
    "-vframes", "1",
    "-q:v", "2",
    outPath,
  ]);
  if (result.error) {
    throw new Error(`ffmpeg spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : "(no stderr)";
    throw new Error(`ffmpeg extract failed (exit ${result.status}): ${stderr}`);
  }
}

function wrap(s: string, width = 70): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).length > width) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function runAnnotateOne(
  repoRoot: string,
  slug: string,
  opts: { reuseVideo?: boolean } = {},
): Promise<void> {
  const apiKey = getApiKey();
  if (!opts.reuseVideo) await ensureDevServer();
  const ai = new GoogleGenAI({ apiKey });

  const entryPath = findEntryPath(repoRoot, slug);
  if (!entryPath) {
    throw new Error(`no catalog entry for slug "${slug}" (tried milkdrop_ + shadertoy_ prefixes)`);
  }
  const entry = JSON.parse(readFileSync(entryPath, "utf-8")) as CatalogEntry;
  if (!entry.source.url) {
    throw new Error(`entry ${slug} has no source.url — only url-loader entries can be annotated`);
  }

  const progress = new Progress(progressPath(repoRoot));
  console.log(`\n[annotate] ${slug}`);
  console.log(`  display: ${entry.display.name}${entry.display.author ? ` (${entry.display.author})` : ""}`);
  console.log(`  source:  ${entry.source.type} · ${entry.source.url}`);
  console.log(`  textures: ${(entry.assets.textures_needed ?? []).map((t) => t.name).join(", ") || "none"}`);

  // Asset filename prefix matches the entry source.type so milkdrop +
  // shadertoy captures don't collide on slug.
  const assetPrefix = entry.source.type; // "milkdrop" | "shadertoy"
  const videoOut = join(repoRoot, "public/videos", `${assetPrefix}_${slug}.webm`);
  const thumbOut = join(repoRoot, "public/thumbs", `${assetPrefix}_${slug}.jpg`);

  let webmBytes: Buffer;
  let renderMs = 0;
  if (opts.reuseVideo) {
    if (!existsSync(videoOut)) {
      throw new Error(`--reuse-video set but no existing capture at ${videoOut}`);
    }
    webmBytes = readFileSync(videoOut);
    console.log(`  reusing existing webm: ${(webmBytes.length / 1024).toFixed(1)} KB`);
  } else {
    const t0 = Date.now();
    console.log(`  capturing 15s WebM via headless Chrome (${entry.source.type})...`);
    const { webmBase64, firstFrameBase64 } = await captureVideo(buildCaptureUrl(entry));
    renderMs = Date.now() - t0;
    webmBytes = Buffer.from(webmBase64, "base64");
    mkdirSync(dirname(videoOut), { recursive: true });
    mkdirSync(dirname(thumbOut), { recursive: true });
    writeFileSync(videoOut, webmBytes);
    // Provisional thumb = first stable frame; will be replaced post-Gemini.
    writeFileSync(thumbOut, Buffer.from(firstFrameBase64, "base64"));
    console.log(`  webm: ${(webmBytes.length / 1024).toFixed(1)} KB → ${videoOut.replace(repoRoot + "/", "")}`);
    console.log(`  render time: ${renderMs}ms`);
  }

  // Empty-render guard: WebMs smaller than ~100KB for a 15s capture are
  // effectively all-black (vp9 compresses uniform color to near-nothing).
  // Skip Gemini entirely — its descriptions of black videos confabulate
  // from the preset name. Mark renders:false; the AI router + gallery
  // both filter these out automatically.
  const EMPTY_RENDER_BYTES = 100_000;
  if (webmBytes.length < EMPTY_RENDER_BYTES) {
    console.log(`  ⚠ empty render (${(webmBytes.length / 1024).toFixed(0)}KB < 100KB) — marking compatibility.renders=false, skipping Gemini`);
    entry.compatibility = {
      renders: false,
      note: `capture was empty (${webmBytes.length} bytes); preset doesn't render meaningfully against the current test signal`,
    };
    entry.assets.video = `/videos/${assetPrefix}_${slug}.webm`;
    entry.assets.thumb = `/thumbs/${assetPrefix}_${slug}.jpg`;
    writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n");
    progress.update(slug, {
      status: "annotated", // counted as done so bulk doesn't retry
      ...(renderMs > 0 ? { rendered_at: new Date().toISOString(), render_ms: renderMs } : {}),
      annotated_at: new Date().toISOString(),
      annotate_ms: 0,
    });
    console.log("");
    return;
  }

  const t1 = Date.now();
  console.log(`  asking Gemini (${MODEL})...`);
  const { annotation, thumbnailTimestamp } = await callGemini(ai, webmBytes, entry.display);
  const annotateMs = Date.now() - t1;

  // Replace the provisional thumb with the frame Gemini picked.
  mkdirSync(dirname(thumbOut), { recursive: true });
  extractFrame(videoOut, thumbnailTimestamp, thumbOut);
  const thumbBytes = readFileSync(thumbOut);
  console.log(`  thumb @ t=${thumbnailTimestamp.toFixed(2)}s · ${(thumbBytes.length / 1024).toFixed(1)} KB → ${thumbOut.replace(repoRoot + "/", "")}`);

  entry.annotation = annotation;
  // Default URLs are the local public/ paths. If R2 is configured,
  // upload + replace with the public R2 URLs so the live site streams
  // from CDN without bloating the Vercel deploy.
  entry.assets.video = `/videos/milkdrop_${slug}.webm`;
  entry.assets.thumb = `/thumbs/milkdrop_${slug}.jpg`;
  if (isR2Enabled()) {
    try {
      const t2 = Date.now();
      const [videoUrl, thumbUrl] = await Promise.all([
        uploadFile(videoOut, `videos/${assetPrefix}_${slug}.webm`, "video/webm"),
        uploadFile(thumbOut, `thumbs/${assetPrefix}_${slug}.jpg`, "image/jpeg"),
      ]);
      console.log(`  R2: uploaded video + thumb in ${Date.now() - t2}ms`);
      if (videoUrl && thumbUrl) {
        entry.assets.video = videoUrl;
        entry.assets.thumb = thumbUrl;
        console.log(`    video → ${videoUrl}`);
        console.log(`    thumb → ${thumbUrl}`);
      } else {
        console.log("    (R2_PUBLIC_BASE not set — bytes are in R2 but");
        console.log("     entry URLs stay local until you flip on public");
        console.log("     access and rerun annotate with --reuse-video)");
      }
    } catch (err) {
      console.warn(`  [R2] upload failed, falling back to local URLs: ${(err as Error).message}`);
    }
  }
  writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n");

  progress.update(slug, {
    status: "annotated",
    ...(renderMs > 0 ? { rendered_at: new Date().toISOString(), render_ms: renderMs } : {}),
    annotated_at: new Date().toISOString(),
    annotate_ms: annotateMs,
  });

  console.log("");
  console.log("  ╭─ annotation ─────────────────────────────────────────");
  console.log(`  │ vibe:        ${annotation.vibe.join(", ")}`);
  console.log(`  │ motion:      ${annotation.motion.toFixed(2)}`);
  console.log(`  │ palette:     ${annotation.palette_anchor.join(" ")}`);
  console.log(`  │ audio:       bass ${annotation.audio_affinity.bass.toFixed(2)} · mid ${annotation.audio_affinity.mid.toFixed(2)} · treble ${annotation.audio_affinity.treble.toFixed(2)}`);
  console.log(`  │ techniques:  ${(annotation.techniques ?? []).join(", ") || "—"}`);
  console.log(`  │ brand_safe:  ${annotation.brand_safe}    atelier: ${annotation.atelier ?? false}`);
  console.log(`  │ thumb @ t:   ${thumbnailTimestamp.toFixed(2)}s`);
  console.log(`  │ technical_notes:`);
  for (const line of wrap(annotation.technical_notes ?? "(none)")) {
    console.log(`  │   ${line}`);
  }
  console.log(`  ╰── annotate time: ${annotateMs}ms ─────────────────────────`);
  console.log("");
}

export async function runAnnotate(
  repoRoot: string,
  args: { slug?: string; all?: boolean; limit?: number; reuseVideo?: boolean; retryErrored?: boolean },
): Promise<void> {
  if (args.slug) {
    await runAnnotateOne(repoRoot, args.slug, { reuseVideo: args.reuseVideo });
    return;
  }
  const progress = new Progress(progressPath(repoRoot));
  if (args.retryErrored) {
    const cleared = progress.retryErrored();
    if (cleared.length === 0) {
      console.log(`[annotate] no errored entries to retry`);
      return;
    }
    console.log(`[annotate] retrying ${cleared.length} errored entries`);
  }
  const pending = progress.pendingSlugs("annotated").slice(0, args.limit ?? Infinity);
  console.log(`[annotate] ${pending.length} pending`);
  let done = 0;
  for (const slug of pending) {
    try {
      await runAnnotateOne(repoRoot, slug, { reuseVideo: args.reuseVideo });
      done++;
    } catch (err) {
      console.error(`[annotate] ERROR ${slug}: ${(err as Error).message}`);
      progress.markError(slug, "annotate", (err as Error).message);
    }
  }
  console.log(`[annotate] done: ${done}/${pending.length} succeeded`);
}
