# Prism

**Generative visualization.** Signals in. Live visuals out.

Prism is the visualization layer for AI applications and agents with
real-time signals. Audio reactivity is one case — heartbeat, breath,
pose, cursor, MIDI, agent state, anything that streams becomes visuals.

It slots into the canonical generative-AI modality row:

| Modality | API |
|---|---|
| Voice | ElevenLabs |
| Image | Stability / Midjourney |
| Music | Suno |
| Video | Runway / Sora |
| **Visualization** | **Prism** |

## Live demo

**https://prism-ten-mu.vercel.app**

- Move your cursor — the field reacts before any permission prompt
- Click *gallery* in the sources panel → pick **nasa · deep space**
- Click *play with sound* → share a tab (YouTube, Spotify) → milkdrop
  reacts to the audio + cycles through transition shaders

## What's in this repo

A working web client + offline pipeline for the visualization catalog.

```
src/landing/        live web app (the demo above)
scripts/            offline pipeline: capture videos + annotate via Gemini
api/                Vercel Edge functions (image proxy, future generate.ts)
catalog/            annotated catalog JSON + captured video assets (built)
BRAND.md            design system + aesthetic decisions
```

## Three ways to contribute (the flywheel)

Prism's value compounds with every contributor — like Wikipedia for
visualizations, with AI as the curator. **Three ways to add value:**

### 1. Run the capture pipeline on your machine

The catalog grows by community compute. Clone the repo, point the
pipeline at presets you want to add, contribute the resulting JSON +
videos via PR.

```sh
git clone git@github.com:scottspace/prism.git
cd prism && pnpm install
pnpm add -D puppeteer tsx
export GEMINI_API_KEY=your_key
pnpm dev &                                       # start the capture server
pnpm tsx scripts/capture-milkdrop.ts             # captures + annotates
git add catalog/ && git commit -m "Add N presets via capture" && pr it
```

Each preset takes ~10s to capture + ~5s to annotate. You can contribute
50–100 entries in a Saturday afternoon.

### 2. Add a new visualization source

Today: Milkdrop. Next: Shadertoy, ISF, hand-written WGSL. Each new
source family means **two new files**:

```
scripts/pipelines/renderers/<source>.ts          # implements Renderer
scripts/pipelines/capture-pages/<source>.html    # the capture harness
```

The shared `CatalogEntry` type means everything downstream (catalog,
generate API, gallery) just works.

### 3. Add a signal source

Signals are what make visualizations *react*. The web app already wires
cursor, audio (tab-share), heart-rate (Pulsoid), synthetic-pink-noise.
Camera+pose, MIDI, breath, OSC, EEG — all welcome. A signal is a small
module that produces a number / vector / texture stream.

See [`src/landing/image-sources/types.ts`](src/landing/image-sources/types.ts)
for the contract.

## Architecture at a glance

```
                    ┌──────────────────────────────────────┐
                    │  Catalog (JSON + videos + thumbnails) │
                    │  Grown by distributed-compute community │
                    └──────────────────────────────────────┘
                                    ▲
                                    │ contributed via PR
       ┌────────────────────────────┴────────────────────────────┐
       │                                                         │
       ▼                                                         ▼
┌─────────────────┐                          ┌─────────────────────┐
│  Live web app   │  ← signals from user      │  Capture pipeline   │
│  picks from     │     (cursor, audio,       │  scripts/* — runs   │
│  catalog        │     heart, …)             │  on contributors'   │
│  composes them  │                           │  machines           │
│  renders        │                           │                     │
└─────────────────┘                          └─────────────────────┘
```

## Quick start (web client)

```sh
git clone git@github.com:scottspace/prism.git
cd prism
pnpm install
pnpm dev
# open http://localhost:5173/landing.html
```

## Stack

- **Frontend**: Vite + TypeScript, vanilla — no React, no framework
- **Visualization runtimes**: butterchurn (Milkdrop), WebGL2 transitions,
  WebGPU compositor (in progress)
- **AI**: Gemini 2.5 Pro / Flash for catalog annotation + future
  pipeline composition
- **Deploy**: Vercel (static + edge functions)
- **License**: MIT

## Docs

- **[BRAND.md](BRAND.md)** — design system, aesthetic decisions, the
  "creative cockpit" frame
- **[scripts/README.md](scripts/README.md)** — capture pipeline
  architecture
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to submit your first PR

## Inspiration

Milkdrop (Geiss, 2001) for proving that audio-reactive visuals could
become culture. Shadertoy (Quílez, 2013) for showing that shader sharing
could become a community. ISF (VIDVOX) for proving that declared inputs
turn shaders into instruments. **Prism is the AI-era extension of all
three: a runtime, a catalog, and a community.**

---

*Built by [Scott Penberthy](https://github.com/scottspace), open under MIT.
PRs and weird ideas warmly welcomed.*
