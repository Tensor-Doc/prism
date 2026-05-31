# Contributing to Prism

Prism gets better the more visualizations, signals, and shaders it knows.
There are three ways to contribute meaningfully — each takes anywhere
from 10 minutes to an afternoon. **All are first-class.**

## TL;DR

- Add visualizations by running `scripts/capture-milkdrop.ts` on your
  machine and PR'ing the resulting catalog entries + videos.
- Add a new *source family* (Shadertoy, ISF, your own format) by writing
  one renderer file + one capture-page HTML.
- Add a new *signal source* (camera pose, MIDI, EEG, BLE heart strap, …)
  by implementing the `ImageSource` or signal contract in `src/landing/`.

## Distributed-compute model

The catalog is the substrate. Every contributor who runs the capture
pipeline on their own machine grows the catalog by some number of
annotated visualizations — like SETI@home for visual culture.

A contribution looks like:

```json
{
  "id": "milkdrop:flexi-alien-fish-pond",
  "source_type": "milkdrop",
  "vibe": ["aquatic", "weird", "playful"],
  "motion": 0.6,
  "palette_anchor": ["#2bb6ff", "#ff8a3a"],
  "audio_affinity": { "bass": 0.5, "mid": 0.6, "treble": 0.3 },
  "blurb": "Wobbling translucent shapes navigate a bass-driven current.",
  "brand_safe": true,
  "video_path": "videos/milkdrop_flexi-alien-fish-pond.webm",
  ...
}
```

Plus the corresponding `.webm` video. That's it. PR it.

## Path 1 — Add visualizations from existing sources

Cost: ~$0.01 in Gemini API + 10-15 seconds per preset.

```sh
git clone git@github.com:tensordoc/prism.git
cd prism
pnpm install
pnpm add -D puppeteer tsx
export GEMINI_API_KEY=your_key_here

pnpm dev &
sleep 3
pnpm tsx scripts/capture-milkdrop.ts
```

The script auto-skips presets already in the catalog, so re-runs are
incremental. After it finishes:

```sh
git checkout -b add-milkdrop-batch-2
git add catalog/
git commit -m "Add N milkdrop presets"
gh pr create --title "Add N milkdrop presets" --body "Captured + annotated via pipeline."
```

## Path 2 — Add a new source family

The pipeline is source-agnostic by design. Adding Shadertoy is two
files:

**`scripts/pipelines/renderers/shadertoy.ts`** — implements the
`Renderer` interface from `scripts/pipelines/types.ts`. Lists which
shaders this renderer can handle and returns the URL Puppeteer should
navigate for each one.

**`scripts/pipelines/capture-pages/shadertoy.html`** — the harness
Puppeteer loads. It sets up a WebGL canvas, compiles the shader,
provides standard uniforms (`iTime`, `iResolution`, `iChannel0` audio
texture), and implements the same `__prismReady` /
`__prismStartCapture` / `__prismVideoBase64` contract that the milkdrop
page implements.

Then a one-line clone of `scripts/capture-milkdrop.ts` as
`scripts/capture-shadertoy.ts` swapping in your new renderer. Done.

The shared `CatalogEntry` shape means the generated entries flow into
the same catalog and become AI-pickable immediately.

## Path 3 — Add a signal source

Signals are what make visualizations *react*. The contract in the live
web app is:

```ts
// src/landing/image-sources/types.ts (for image-shaped inputs)
interface ImageSource {
  readonly id: string;
  readonly type: "tab-video" | "nasa-apod" | "url" | "upload" | ...;
  isReady(): boolean;
  sample(target: HTMLCanvasElement): Promise<boolean>;
  defaultPeriodMs(): number;
}
```

For scalar/vector signals (heart rate, MIDI velocity, breath rate),
follow the pattern in `src/landing/pulsoid.ts`: a class with
`onValue` / `onBeat` callbacks and a `connect()` lifecycle.

## What makes a good PR

- **One feature per PR.** Even if your batch ran 50 presets, separating
  the renderer infrastructure (path 2) from the catalog data (path 1)
  helps reviewers.
- **Brand-safe annotations.** Re-look at the `brand_safe` field on
  entries — Prism opts out of purple-dominated visuals (see
  [BRAND.md](BRAND.md)). If Gemini marked it `false`, your PR shouldn't
  promote it to the default-on rotation.
- **Don't commit `.env`.** It's gitignored already; just don't override
  it.

## Recognition

Every catalog entry records the date it was captured. We'll be tracking
contribution leaderboards over time on [prism.gallery](https://prism-ten-mu.vercel.app).
Authors named in butterchurn preset names get preserved attribution; if
you're capturing your own work, add yourself in a `contributed_by` field
(supported as of annotation_version 1).

## Code style

- TypeScript, strict mode, no `any` outside of unavoidable interop
- vanilla DOM, no framework
- Single-file modules unless the file is >300 lines
- Brand-conformant CSS using tokens from `src/tokens.css`

## Questions

Open an issue tagged `discuss` — Prism's design is still in motion, and
input on architecture decisions (e.g. signal-binding format, skill
envelope, compositor API) is welcomed loudly.
