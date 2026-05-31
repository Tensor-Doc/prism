# Contributing to Prism

Prism gets better the more visualizations, signals, and shaders it
knows. There are three ways to contribute meaningfully. Each takes
anywhere from 10 minutes to an afternoon. **All are first-class.**

## Quick summary

You can add new visualizations to the catalog by running the
`pnpm prism` pipeline on your machine and PR'ing the resulting
catalog entries. You can add a new source family like Shadertoy or
ISF by writing one runtime file and one capture-page harness. You
can add a new signal like a camera pose, MIDI, EEG, or BLE heart
strap by implementing the relevant contract in `src/landing/`.

## Distributed-compute model

The catalog is the substrate. Every contributor who runs the
capture pipeline on their own machine grows the catalog by some
number of annotated visualizations. Think SETI@home for visual
culture.

A catalog entry looks like this.

```json
{
  "id": "milkdrop:flexi-alien-fish-pond",
  "short_id": "PTzsKc",
  "source": {
    "type": "milkdrop",
    "loader": "url",
    "url": "/presets/milkdrop/flexi-alien-fish-pond.milk"
  },
  "display": { "name": "Flexi alien fish pond" },
  "annotation": {
    "vibe": ["aquatic", "weird", "playful"],
    "motion": 0.6,
    "palette_anchor": ["#2bb6ff", "#ff8a3a"],
    "audio_affinity": { "bass": 0.5, "mid": 0.6, "treble": 0.3 },
    "brand_safe": true
  },
  "assets": {
    "video": "https://images.prism.scott.ai/videos/...",
    "thumb": "https://images.prism.scott.ai/thumbs/..."
  }
}
```

The video and thumbnail get uploaded to Cloudflare R2. The entry
JSON is what lands in the PR.

## Path 1. Add visualizations from existing sources

Cost is about $0.01 in Gemini API per preset, plus 15 seconds to
capture and 3 seconds to annotate.

```sh
git clone git@github.com:Tensor-Doc/prism.git
cd prism
pnpm install
cp .env.example .env
# add GEMINI_API_KEY and R2_* credentials

pnpm dev                                          # the capture server
pnpm prism ingest <path-to-presets-or-shaders>    # adds catalog/entries/*
pnpm prism annotate --all                         # capture, annotate, upload
pnpm prism build-index                            # rebuild catalog/index.json
```

The ingest step auto-skips presets already in the catalog. Re-runs
are incremental. After the pipeline finishes.

```sh
git checkout -b add-milkdrop-batch-2
git add catalog/
git commit -m "Add N milkdrop presets"
gh pr create --title "Add N milkdrop presets" --body "Captured and annotated via pipeline."
```

A real GPU helps. The capture pipeline runs headless Chrome on your
real GPU through ANGLE. On macOS that means Metal. On Linux it's
GL. On Windows it's D3D11. Heavy presets like Geiss Cauldron and
reaction diffusion need a real GPU to compile within the timeout. A
pure-CPU fallback exists, but every Geiss preset times out under it.

## Path 2. Add a new source family

The pipeline is source-agnostic by design. The npm package's
runtime and the capture pipeline both look up the source type and
delegate. Adding a new source family takes two files.

The runtime backend lives in the npm package.

```
packages/prism/src/backends/<source>.ts
```

It exports a factory like `createIsfBackend(audioCtx, canvas,
silentSource)` and returns a handle with `connectAudio`,
`loadFromUrl`, `destroy`. Mirror the shape of
`packages/prism/src/backends/shadertoy.ts`.

The capture harness lives next to the others.

```
scripts/pipelines/capture-pages/<source>.html
```

Puppeteer loads this page. It sets up the canvas, compiles the
visualization, connects the audio test-signal, and implements the
same `__prismReady`, `__prismStartCapture`, and
`__prismVideoBase64` contract that `shadertoy.html` implements.

The shared `CatalogEntry` schema does the rest. The gallery, the
API, and the prompt loop work without changes.

## Path 3. Add a signal source

Signals are what make visualizations react. The app already
supports cursor, audio from a shared tab, microphone, heart rate
from Pulsoid, and a synthetic pink-noise driver. Camera, pose,
MIDI, breath, OSC, EEG, all welcome.

For image-shaped inputs, implement the `ImageSource` contract.

```ts
// src/landing/image-sources/types.ts
interface ImageSource {
  readonly id: string;
  readonly type: "tab-video" | "nasa-apod" | "unsplash" | "url" | "upload" | ...;
  isReady(): boolean;
  sample(target: HTMLCanvasElement): Promise<boolean>;
  defaultPeriodMs(): number;
}
```

For scalar or vector signals like heart rate, MIDI velocity, or
breath rate, follow the pattern in `src/landing/pulsoid.ts`. It's a
class with `onValue` and `onBeat` callbacks plus a `connect()`
lifecycle.

## What makes a good PR

- **One feature per PR.** Even if your batch ran 50 presets,
  separating the runtime infrastructure from the catalog data helps
  reviewers.
- **Brand-safe annotations.** The `brand_safe` field opts out of
  purple-dominated visuals. See [BRAND.md](BRAND.md). If Gemini
  marked your entry `false`, your PR shouldn't promote it to the
  default-on rotation.
- **Don't commit `.env`.** It's gitignored already. Just don't
  override it.
- **Short_ids are immutable.** The build-index step mints a
  6-character base62 share token for every new entry. Once a token
  is published, it never changes. External URLs depend on this.

## Recognition

Every catalog entry records the date it was added and who added it.
The capture pipeline writes a `contribution.added_by` field. We're
tracking contribution leaderboards over time on
[prism.scott.ai](https://prism.scott.ai).

If you're capturing your own original work, the annotator preserves
authorship through the preset filename. Add yourself in the
`contribution.added_by` field.

## Code style

- TypeScript with strict mode. No `any` outside unavoidable interop.
- Vanilla DOM. No framework.
- Single-file modules unless the file passes 300 lines.
- Brand-conformant CSS using tokens from `src/tokens.css`.

## Questions

Open an issue tagged `discuss`. Prism's design is still in motion.
Input on architecture decisions like the signal-binding format, the
skill envelope, and the compositor API is welcomed loudly.
