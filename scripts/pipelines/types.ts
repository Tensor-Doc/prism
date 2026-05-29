// Shared types for the capture / annotate / upsert pipeline.
//
// The pipeline has four stages, each addressable independently:
//
//   1. Enumerate     — Renderer.listPresets()                   → string[]
//   2. Render+Capture — captureVideo(renderUrl, …)              → Buffer
//   3. Annotate       — annotateVideo(videoPath, context)       → Annotation
//   4. Upsert         — upsertCatalogEntry(catalogPath, entry)  → void
//
// Each source family (milkdrop / shadertoy / isf) implements its own
// Renderer. The Renderer's only responsibility is producing a URL Puppeteer
// can navigate to that runs the visualization in a known-good harness.
// Everything downstream (capture, annotate, store) is source-agnostic.

export type SourceType = "milkdrop" | "shadertoy" | "isf";

export interface CaptureConfig {
  /** Output video width, pixels. 1280 (720p) is a good default for 16:9. */
  width: number;
  /** Output video height, pixels. Must match width × 9/16 to stay 16:9. */
  height: number;
  /** Total recording duration. ~6s captures multi-second motion cycles. */
  durationMs: number;
  /** Target frame rate. 30 is plenty for vibe analysis; lower if disk-bound. */
  fps: number;
  /** Container format. WebM is universally supported by Chromium + Gemini. */
  format: "webm";
  /** Optional: max wait for the page's `window.__prismReady` flag, in ms. */
  readyTimeoutMs?: number;
}

export interface Renderer {
  readonly sourceType: SourceType;
  /** List every preset/shader this renderer can capture. */
  listPresets(): Promise<PresetRef[]>;
  /** URL Puppeteer navigates to render+capture a single preset. */
  getRenderUrl(presetId: string): string;
}

export interface PresetRef {
  /** Stable, unique key — what the renderer uses to look up the preset. */
  id: string;
  /** Human-readable display name (often same as id for milkdrop). */
  displayName: string;
  /** Original author if extractable; "Unknown" otherwise. */
  author?: string;
}

/** What Gemini returns after watching the captured video. */
export interface Annotation {
  /** 1–4 short vibe tags. e.g. ["fluid", "warm", "calm"]. */
  vibe: string[];
  /** 0..1 motion class. 0 = static, 1 = chaotic. */
  motion: number;
  /** 2–4 dominant palette colors as hex strings. */
  palette_anchor: string[];
  /** How responsive each band feels in the visual, 0..1. */
  audio_affinity: { bass: number; mid: number; treble: number };
  /** Single-sentence description of the look. */
  blurb: string;
  /** Optional tag — does it violate Prism's no-purple brand rule? */
  brand_safe?: boolean;
}

export interface CatalogEntry extends Annotation {
  /** Canonical Prism id: "<source_type>:<preset_id_slug>" */
  id: string;
  source_type: SourceType;
  /** Native identifier within the source family. */
  preset_id: string;
  display_name: string;
  author?: string;
  /** Path relative to the catalog directory. */
  video_path: string;
  /** Optional jpg path (extracted middle frame). */
  thumbnail_path?: string;
  /** ISO8601 timestamp. */
  captured_at: string;
  duration_ms: number;
  annotation_model: string;
  /** Bump when the schema changes so we can re-annotate selectively. */
  annotation_version: number;
}
