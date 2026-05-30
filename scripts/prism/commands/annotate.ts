// Annotate one or more catalog entries: capture a 15s WebM of the preset
// rendering against the synthetic audio signal, ask Gemini to describe it
// in the structured shader/Geiss vocabulary, write the annotation block
// back to the entry.
//
//   pnpm prism annotate <slug>          # one preset (calibration mode)
//   pnpm prism annotate --all           # everything with annotation: null
//   pnpm prism annotate --limit=10      # next 10 unannotated
//
// Prerequisite: `pnpm dev` running in another terminal (Vite serves the
// capture-page that Puppeteer navigates to). Fails fast otherwise.

import { GoogleGenAI, Type, createPartFromUri, createUserContent } from "@google/genai";
import puppeteer from "puppeteer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ANNOTATOR_SYSTEM_INSTRUCTION } from "../annotator-prompt";
import type { CatalogEntry, Annotation } from "../entry-types";
import { Progress, progressPath } from "../progress";

const DEV_URL = "http://localhost:5173";
const CAPTURE_PAGE = "/scripts/pipelines/capture-pages/milkdrop.html";
const CAPTURE_DURATION_MS = 15_000;
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;

// Response schema mirrors the Annotation TS type (minus model/version/
// captured_at which we set ourselves). Gemini fills these fields.
const ANNOTATION_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "vibe", "motion", "palette_anchor", "audio_affinity",
    "techniques", "technical_notes", "brand_safe", "refik_mode",
  ],
  properties: {
    vibe: { type: Type.ARRAY, items: { type: Type.STRING } },
    motion: { type: Type.NUMBER },
    palette_anchor: { type: Type.ARRAY, items: { type: Type.STRING } },
    audio_affinity: {
      type: Type.OBJECT,
      required: ["bass", "mid", "treble"],
      properties: {
        bass: { type: Type.NUMBER },
        mid: { type: Type.NUMBER },
        treble: { type: Type.NUMBER },
      },
    },
    techniques: { type: Type.ARRAY, items: { type: Type.STRING } },
    technical_notes: { type: Type.STRING },
    brand_safe: { type: Type.BOOLEAN },
    refik_mode: { type: Type.BOOLEAN },
  },
} as const;

function entryFilename(slug: string): string {
  return `milkdrop_${slug}.json`;
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

async function captureVideo(presetUrl: string): Promise<{ webmBase64: string; thumbBase64: string }> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
    ],
    defaultViewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`  [page-error] ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`  [page-console-error] ${msg.text()}`);
    });
    const url = `${DEV_URL}${CAPTURE_PAGE}?presetUrl=${encodeURIComponent(presetUrl)}`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
    await page.waitForFunction("window.__prismReady === true", { timeout: 30_000 });
    // Settle for 1s so blends/decay reach a stable state before recording.
    await new Promise((r) => setTimeout(r, 1000));
    // Capture thumbnail BEFORE the recording starts (first stable frame).
    const thumbBase64 = await page.evaluate(() => {
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
    const webmBase64 = (await page.evaluate(
      "window.__prismVideoBase64",
    )) as string;
    return { webmBase64, thumbBase64 };
  } finally {
    await browser.close();
  }
}

async function callGemini(
  ai: GoogleGenAI,
  webmBytes: Buffer,
  display: { name: string; author?: string },
): Promise<Annotation> {
  // Upload the video to the Gemini Files API so we can reference it as
  // an inline part. WebMs > ~20MB need this route; for our 15s captures
  // either works, but the Files API path is what the M5b CI Action will
  // use too — best to exercise it now.
  const file = await ai.files.upload({
    file: new Blob([new Uint8Array(webmBytes)], { type: "video/webm" }),
    config: { mimeType: "video/webm" },
  });
  if (!file.uri || !file.mimeType) throw new Error("gemini upload returned no uri");
  const fileUri = file.uri;
  const fileMime = file.mimeType;
  const fileName = file.name;
  // Files API uploads start in PROCESSING state and need to be ACTIVE before
  // generateContent will accept them. Poll briefly.
  if (fileName) {
    for (let i = 0; i < 30; i++) {
      const status = await ai.files.get({ name: fileName });
      if (status.state === "ACTIVE") break;
      if (status.state === "FAILED") throw new Error(`gemini file processing failed`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const prompt = `Preset name (as bare metadata, not visible in video):
"${display.name}"${display.author ? ` (attributed to: ${display.author})` : ""}

Watch the 15s capture and produce the annotation JSON.`;

  const response = await ai.models.generateContent({
    model: "gemini-flash-latest",
    contents: createUserContent([createPartFromUri(fileUri, fileMime), prompt]),
    config: {
      systemInstruction: ANNOTATOR_SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: ANNOTATION_SCHEMA,
      temperature: 0.4,
    },
  });
  const text = response.text;
  if (!text) throw new Error("empty gemini response");
  const parsed = JSON.parse(text) as Omit<Annotation, "model" | "version" | "captured_at">;
  return {
    ...parsed,
    model: "gemini-flash-latest",
    version: 2,
    captured_at: new Date().toISOString(),
  };
}

export async function runAnnotateOne(repoRoot: string, slug: string): Promise<void> {
  await ensureDevServer();
  // Accept either GEMINI_API_KEY (preferred for server work) or
  // VITE_GEMINI_API_KEY (the existing local .env) — same key value.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set — `export GEMINI_API_KEY=...` first (or set VITE_GEMINI_API_KEY in .env)");
  }
  const ai = new GoogleGenAI({ apiKey });

  const entryPath = join(repoRoot, "catalog/entries", entryFilename(slug));
  if (!existsSync(entryPath)) {
    throw new Error(`no catalog entry: ${entryPath}`);
  }
  const entry = JSON.parse(readFileSync(entryPath, "utf-8")) as CatalogEntry;
  const presetUrl = entry.source.url;
  if (!presetUrl) {
    throw new Error(`entry ${slug} has no source.url — only url-loader entries can be annotated`);
  }

  const progress = new Progress(progressPath(repoRoot));
  console.log(`\n[annotate] ${slug}`);
  console.log(`  display: ${entry.display.name}${entry.display.author ? ` (${entry.display.author})` : ""}`);
  console.log(`  preset:  ${presetUrl}`);
  console.log(`  textures: ${(entry.assets.textures_needed ?? []).map((t) => t.name).join(", ") || "none"}`);

  const t0 = Date.now();
  console.log("  capturing 15s WebM via headless Chrome...");
  const { webmBase64, thumbBase64 } = await captureVideo(presetUrl);
  const renderMs = Date.now() - t0;
  const webmBytes = Buffer.from(webmBase64, "base64");
  const thumbBytes = Buffer.from(thumbBase64, "base64");
  const videoOut = join(repoRoot, "public/videos", `milkdrop_${slug}.webm`);
  const thumbOut = join(repoRoot, "public/thumbs", `milkdrop_${slug}.jpg`);
  mkdirSync(dirname(videoOut), { recursive: true });
  mkdirSync(dirname(thumbOut), { recursive: true });
  writeFileSync(videoOut, webmBytes);
  writeFileSync(thumbOut, thumbBytes);
  console.log(`  webm: ${(webmBytes.length / 1024).toFixed(1)} KB → ${videoOut.replace(repoRoot + "/", "")}`);
  console.log(`  thumb: ${(thumbBytes.length / 1024).toFixed(1)} KB → ${thumbOut.replace(repoRoot + "/", "")}`);
  console.log(`  render time: ${renderMs}ms`);

  const t1 = Date.now();
  console.log("  asking Gemini (gemini-flash-latest)...");
  const annotation = await callGemini(ai, webmBytes, entry.display);
  const annotateMs = Date.now() - t1;

  entry.annotation = annotation;
  entry.assets.video = `/videos/milkdrop_${slug}.webm`;
  entry.assets.thumb = `/thumbs/milkdrop_${slug}.jpg`;
  writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n");

  progress.update(slug, {
    status: "annotated",
    rendered_at: new Date(t0).toISOString(),
    annotated_at: new Date().toISOString(),
    render_ms: renderMs,
    annotate_ms: annotateMs,
  });

  console.log("");
  console.log("  ╭─ annotation ─────────────────────────────────────────");
  console.log(`  │ vibe:        ${annotation.vibe.join(", ")}`);
  console.log(`  │ motion:      ${annotation.motion.toFixed(2)}`);
  console.log(`  │ palette:     ${annotation.palette_anchor.join(" ")}`);
  console.log(`  │ audio:       bass ${annotation.audio_affinity.bass.toFixed(2)} · mid ${annotation.audio_affinity.mid.toFixed(2)} · treble ${annotation.audio_affinity.treble.toFixed(2)}`);
  console.log(`  │ techniques:  ${(annotation.techniques ?? []).join(", ") || "—"}`);
  console.log(`  │ brand_safe:  ${annotation.brand_safe}    refik_mode: ${annotation.refik_mode ?? false}`);
  console.log(`  │ technical_notes:`);
  const wrap = (s: string, width = 70): string[] => {
    const words = s.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).length > width) { lines.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  for (const line of wrap(annotation.technical_notes ?? "(none)")) {
    console.log(`  │   ${line}`);
  }
  console.log(`  ╰── annotate time: ${annotateMs}ms ─────────────────────────`);
  console.log("");
}

export async function runAnnotate(repoRoot: string, args: { slug?: string; all?: boolean; limit?: number }): Promise<void> {
  if (args.slug) {
    await runAnnotateOne(repoRoot, args.slug);
    return;
  }
  // Bulk mode: find candidates from progress tracker (status=ingested,
  // annotation still null on disk), annotate up to --limit.
  const progress = new Progress(progressPath(repoRoot));
  const pending = progress.pendingSlugs("annotated").slice(0, args.limit ?? Infinity);
  console.log(`[annotate] ${pending.length} pending`);
  let done = 0;
  for (const slug of pending) {
    try {
      await runAnnotateOne(repoRoot, slug);
      done++;
    } catch (err) {
      console.error(`[annotate] ERROR ${slug}: ${(err as Error).message}`);
      progress.markError(slug, "annotate", (err as Error).message);
    }
  }
  console.log(`[annotate] done: ${done}/${pending.length} succeeded`);
}
