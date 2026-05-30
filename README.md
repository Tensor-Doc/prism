# Prism

**Generative visualization.** Signals in. Light fields out.

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
- Type a prompt or click a chip → Gemini composes a `prism.graph` →
  the runtime loads the matching visualizer with the right audio bias
- Click *play with sound* → share a tab (YouTube, Spotify) → the
  visualizer reacts to real FFT in real time
- Open the *gallery* → wall of captured visualizers, hover to preview,
  click to play through. "I'm feeling lucky" rolls the dice.

## What's in this repo

A working web client + offline pipeline + a sharded catalog.

```
src/landing/        live web app — the visualizer + prompt loop
src/gallery/        the catalog browser at /gallery.html
scripts/prism/      `pnpm prism` CLI — migrate, ingest, annotate, build-index
scripts/pipelines/  Puppeteer harnesses + Gemini annotator + R2 uploader
api/                Vercel Edge functions (generate, image-proxy)
catalog/entries/    one JSON file per entry (source-of-truth)
catalog/index.json  built artifact — what the gallery + API consume
public/presets/     hand-seeded shaders (Shadertoy-flavor GLSL)
BRAND.md            design system + aesthetic decisions
```

The catalog is the heart of it. Today: **70 annotated / 644 total**
(65 Milkdrop + 5 Shadertoy), all videos captured headless and hosted on
Cloudflare R2.

## How a prompt becomes a visual

Every Prism visualization is a small node graph — a JSON document
describing how *signals* (audio, cursor, heartbeat, …) flow into a
*light field* (a frame) and out to a *sink* (a canvas). The headline
difference: **the AI writes the graph.** You give the endpoint a
prompt; it returns valid `prism.graph/0.1` JSON; the browser runtime
walks it and renders.

A typical graph (the kind most prompts produce today):

```jsonc
{
  "schema": "prism.graph/0.1",
  "id": "g_calm_cosmic",
  "intent": "calming cosmic fluid that breathes with bass",
  "nodes": {
    "audio":  { "type": "signal.audio" },
    "main":   {
      "type":   "lf.shadertoy",
      "params": { "shader_url": "/presets/shadertoy/cosmic-flow.glsl" },
      "inputs": { "audio": "audio.signal" }
    },
    "screen": {
      "type":   "sink.display",
      "inputs": { "frame": "main.frame" }
    }
  },
  "output": "screen"
}
```

Five role-tagged node families compose any graph:

| Role | Does | Examples today |
|---|---|---|
| `signal.*` | Produces a stream of data over time | `signal.audio`, `signal.cursor`, `signal.heartbeat` |
| `xform.*` | Transforms a signal | `xform.gain`, `xform.beat` |
| `lf.*` | **Light-field generator** — emits frames | `lf.milkdrop`, `lf.shadertoy`, (future `lf.isf`, `lf.wgsl`) |
| `op.*` | Operates on light fields | `op.blend`, `op.displace`, `op.feedback` |
| `sink.*` | Terminates the graph | `sink.display`, `sink.recorder` |

Today's graphs are 3 nodes (`signal.audio → lf.* → sink.display`).
The schema is intentionally roomy: tomorrow `op.*` compositors let one
graph layer multiple light fields, and new `lf.*` types plug in
without touching anything else downstream.

### Why a JSON notation?

TouchDesigner, Notch, Cables.gl, vvvv, ComfyUI — all use node graphs,
each in its own format. Prism proposes a small open JSON notation so
visualizers are:

- **agent-friendly** — an AI can read, write, or remix a graph the
  same way it edits code
- **shareable** — a graph is ~1 KB; a URL hash carries the whole thing
- **editable** — by a prompt today, a node editor tomorrow,
  hand-written code whenever

Adding a new generator (a WGSL renderer, an ISF interpreter, a WebGPU
compositor) is two files: a runtime that executes the node + a new
`lf.*` / `op.*` type. The gallery, the prompt loop, and the AI router
all see it for free.

## Three ways to contribute (the flywheel)

Prism's value compounds with every contributor — Wikipedia-for-visuals
with AI as the curator. **Three ways to add value:**

### 1. Run the capture pipeline on your machine

The catalog grows by community compute. Clone the repo, ingest presets
you want to add, contribute the resulting JSON + R2-hosted videos via
PR.

```sh
git clone git@github.com:scottspace/prism.git
cd prism && pnpm install
cp .env.example .env       # add GEMINI_API_KEY + R2_* + VITE_GEMINI_API_KEY

pnpm dev                                          # capture server
pnpm prism ingest <path-to-presets-or-shaders>    # adds catalog/entries/*
pnpm prism annotate --all                         # capture + Gemini + R2 upload
pnpm prism build-index                            # refresh catalog/index.json

git add catalog/ && git commit -m "Add N presets" && pr it
```

Each entry takes ~15s to capture + ~3s to annotate. You can contribute
50–100 entries in a Saturday afternoon.

### 2. Add a new visualization source

Today: **Milkdrop** (via butterchurn) and **Shadertoy** (custom WebGL2
runtime with `iChannel0` audio FFT + `iChannel1` image texture). Next:
ISF, hand-written WGSL. Each new source family means **two new files**:

```
src/landing/<source>-bg.ts                       # the live runtime
scripts/pipelines/capture-pages/<source>.html    # the capture harness
```

The shared `CatalogEntry` schema means everything downstream — the
gallery, `api/generate`, the prompt loop — just works.

### 3. Add a signal source

Signals are what make visualizations *react*. The web app already wires
cursor, audio (tab-share), heart-rate (Pulsoid), synthetic-pink-noise.
Camera+pose, MIDI, breath, OSC, EEG — all welcome. A signal is a small
module that produces a number / vector / texture stream.

## Quick start (web client)

```sh
git clone git@github.com:scottspace/prism.git
cd prism
pnpm install
pnpm dev
# visualizer:  http://localhost:5173/landing.html
# gallery:     http://localhost:5173/gallery.html
```

## Stack

- **Frontend**: Vite + TypeScript, vanilla — no React, no framework
- **Runtimes**: butterchurn (Milkdrop) + custom WebGL2 (Shadertoy
  300-es with iChannel uniforms + image binding)
- **AI**: `gemini-flash-latest` for catalog annotation + prompt→graph
  composition (`@google/genai` SDK)
- **Storage**: Cloudflare R2 (S3-compatible) for captured webms + thumbs
- **Pipeline**: Puppeteer + headless Chrome (`--use-angle=swiftshader`)
  + MediaRecorder VP9 at 1280×720
- **Deploy**: Vercel (static + edge functions). Build stamps the git SHA
  into the page; hover the version tag to see when it shipped.
- **License**: MIT

## Docs

- **[BRAND.md](BRAND.md)** — design system, aesthetic decisions, the
  "creative cockpit" frame

## Inspiration

Milkdrop (Geiss, 2001) for proving audio-reactive visuals could become
culture. Shadertoy (Quílez, 2013) for showing that shader sharing could
become a community. ISF (VIDVOX) for proving that declared inputs turn
shaders into instruments. TouchDesigner and the broader generative-art
practice for the conviction that data-driven painterly work belongs in
galleries.

**Prism is the AI-era extension of all of these: a runtime, a catalog,
a graph language, and a community.**

---

*Built by [Scott Penberthy](https://github.com/scottspace), open under
MIT. PRs and weird ideas warmly welcomed.*
