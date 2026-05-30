// prism.catalog/v2 — one entry per file under catalog/entries/.
//
// Single source of truth for everything the AI router + runtime need to
// know about a visualization. Built for many sources (milkdrop /
// shadertoy / isf / wgsl) and lazy loading (presets aren't bundled —
// fetched from public/presets/<source>/<slug>.<ext> at runtime).

export const SCHEMA_VERSION = 2 as const;

export type SourceType = "milkdrop" | "shadertoy" | "isf" | "wgsl";

export type LoaderType =
  /** Load from a static URL under public/presets/<source>/. */
  | "url"
  /** Read from the bundled butterchurn-presets npm package by exact name.
   *  Used during migration; will be retired once everything is URL-loaded. */
  | "npm-butterchurn-presets";

export interface Source {
  type: SourceType;
  loader: LoaderType;
  /** Static path under public/, for loader=url. */
  url?: string;
  /** Original preset name in the npm bundle, for loader=npm-butterchurn-presets. */
  ref?: string;
  /** Preset format / version. milkdrop: "milk-v201" etc. */
  format?: string;
}

export interface Display {
  /** Human-readable display name. Shown in the SKILL row. */
  name: string;
  /** Best-effort author attribution from the preset filename. */
  author?: string;
  blurb?: string;
}

export interface AudioAffinity {
  bass: number;
  mid: number;
  treble: number;
}

export interface Annotation {
  vibe: string[];
  motion: number;
  palette_anchor: string[];
  audio_affinity: AudioAffinity;
  /** Structured technique tags from a controlled vocabulary. Used by the
   *  AI router for matching ("frame_feedback", "warp", "hue_cycle", …).
   *  Filled by the M5b annotator; null on hand-seeded entries. */
  techniques: string[] | null;
  /** Rich, ~2-3 sentence technical description in the canonical vocabulary
   *  of Geiss + the Milkdrop manual + The Book of Shaders. NOT shown to
   *  casual visitors — surfaces in the future /learn page and in the
   *  annotation review UI. Filled by the M5b annotator; null on hand-
   *  seeded entries. */
  technical_notes: string | null;
  /** False if the preset is dominated by purple (brand rule). */
  brand_safe: boolean;
  /** True if the preset belongs to the painterly "atelier" subset —
   *  the slow, atmospheric, gallery-grade aesthetic Prism leads with. */
  atelier?: boolean;
  /** Name of the model that produced the annotation. "seed" for hand-seeded. */
  model: string;
  /** Annotator version — bump when the schema or prompt changes substantially. */
  version: number;
  /** ISO-8601 timestamp of annotation. */
  captured_at: string;
}

export interface TextureNeed {
  name: string;
  /** Suggested texture size in px (square). Defaults to 512 if unset. */
  size_hint?: number;
}

export interface Assets {
  video?: string;
  thumb?: string;
  /** sampler_* references parsed from the shader, minus built-ins. */
  textures_needed?: TextureNeed[];
}

export interface Contribution {
  added_by: string;
  added_at: string;
  license: string;
}

export interface Compatibility {
  /** False if the preset fails to render or compile. AI router skips these silently. */
  renders: boolean;
  /** "fast" / "mid" / "slow" measured by smoke test. AI router avoids slow on mobile. */
  perf_tier?: "fast" | "mid" | "slow";
  /** Free-text note on what's broken if renders=false. */
  note?: string;
}

export interface CatalogEntry {
  id: string;
  schema_version: typeof SCHEMA_VERSION;
  source: Source;
  display: Display;
  /** Null until M5b CI annotation runs. Annotation-null entries are
   *  invisible to the AI router. */
  annotation: Annotation | null;
  assets: Assets;
  contribution: Contribution;
  /** Defaults to {renders: true} for hand-seeded / migrated entries. */
  compatibility: Compatibility;
}
