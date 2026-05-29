# Prism capture pipeline

Offline scripts that build the **annotated catalog + video gallery** powering
the AI generation pipeline. The architecture is modular so each new source
family (Shadertoy, ISF, …) plugs in with a single new renderer and HTML
harness.

## Pipeline stages

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────┐    ┌──────────────┐
│   Renderer      │───►│  captureVideo()  │───►│  annotate()  │───►│  upsert()    │
│  per-source     │    │  Puppeteer +     │    │  Gemini      │    │  catalog.json│
│                 │    │   WebM           │    │   2.5 Pro    │    │  + assets    │
└─────────────────┘    └──────────────────┘    └──────────────┘    └──────────────┘
```

Each stage is in its own file under `pipelines/` and has no knowledge of the
others' implementations. The shared **`CatalogEntry`** type in
`pipelines/types.ts` is the only contract that crosses stage boundaries.

## File layout

```
scripts/
  capture-milkdrop.ts            ← orchestrator (Milkdrop end-to-end)
  pipelines/
    types.ts                     ← shared interfaces
    capture.ts                   ← Puppeteer-driven 16:9 WebM capture
    annotate.ts                  ← Gemini structured annotation
    storage.ts                   ← JSON catalog upsert
    renderers/
      milkdrop.ts                ← lists + URLs for butterchurn-presets-Minimal
    capture-pages/
      milkdrop.html              ← harness Puppeteer navigates to
```

Adding a new source family means writing **two new files**:
- `pipelines/renderers/<source>.ts` implementing the `Renderer` interface
- `pipelines/capture-pages/<source>.html` implementing the
  `__prismReady` / `__prismStartCapture` / `__prismVideoBase64` contract

Then one new orchestrator (mirror of `capture-milkdrop.ts`) and you have a
parallel pipeline producing entries in the same catalog.

## Running the Milkdrop pipeline

```sh
# 1. install pipeline dependencies (puppeteer + tsx)
pnpm add -D puppeteer tsx

# 2. start the local capture server (so capture-pages/*.html is reachable)
pnpm dev

# 3. in another shell, set your Gemini key and run the orchestrator
export GEMINI_API_KEY=your_key
pnpm tsx scripts/capture-milkdrop.ts
```

The script:
- enumerates the 29 presets in butterchurn-presets `Minimal`
- captures a 6-second 1280×720 (16:9) WebM of each
- uploads each video to Gemini for structured metadata
- writes `catalog/catalog.json` and `catalog/videos/milkdrop_*.webm`

Re-runs skip presets that are already in the catalog. To force re-annotation
of existing entries (e.g. after schema changes), set `PRISM_REANNOTATE=1`.

## Output format

Each entry in `catalog/catalog.json`:

```json
{
  "id": "milkdrop:geiss-reaction-diffusion-2",
  "source_type": "milkdrop",
  "preset_id": "Geiss - Reaction Diffusion 2",
  "display_name": "Geiss - Reaction Diffusion 2",
  "author": "Geiss",
  "vibe": ["fluid", "organic", "calm"],
  "motion": 0.4,
  "palette_anchor": ["#5a8aff", "#fff7a5"],
  "audio_affinity": { "bass": 0.7, "mid": 0.4, "treble": 0.2 },
  "blurb": "Slow chromatic fluid that breathes with bass.",
  "brand_safe": true,
  "video_path": "videos/milkdrop_geiss-reaction-diffusion-2.webm",
  "captured_at": "2026-05-29T22:00:00.000Z",
  "duration_ms": 6000,
  "annotation_model": "gemini-2.5-pro",
  "annotation_version": 1
}
```

This is what the AI generation pipeline (`api/generate.ts`) reads to make
recommendations. The `video_path` will also drive the future gallery page.
