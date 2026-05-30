# Prism

**Generative visualization.** Signals in. Light fields out.

Prism turns real-time signals into live visuals. Audio is one signal.
So are heartbeat, breath, pose, cursor, MIDI, and AI agent state.
Anything that streams can drive a visual.

Prism fills the visualization slot in the AI modality lineup.

| Modality | API |
|---|---|
| Voice | ElevenLabs |
| Image | Stability / Midjourney |
| Music | Suno |
| Video | Runway / Sora |
| **Visualization** | **Prism** |

## Live demo

**https://prism-ten-mu.vercel.app**

- Move your cursor. The field reacts. No permission prompt needed.
- Type a prompt or click a chip. Gemini composes a graph. The right
  visualizer loads.
- Click *play with sound*. Share a tab from YouTube or Spotify. The
  visuals react to the music.
- Open the *gallery*. Hover a card to preview. Click to play it. "I'm
  feeling lucky" picks one at random.

## What's in this repo

A working web app, an offline pipeline, and a catalog.

```
src/landing/        live web app, the visualizer and prompt loop
src/gallery/        the catalog browser at /gallery.html
scripts/prism/      the `pnpm prism` CLI for migrate, ingest, annotate, build-index
scripts/pipelines/  Puppeteer harnesses, Gemini annotator, R2 uploader
api/                Vercel Edge functions for generate and image-proxy
catalog/entries/    one JSON file per entry, the source of truth
catalog/index.json  built artifact, consumed by the gallery and API
public/presets/     hand-seeded shaders in Shadertoy-flavor GLSL
BRAND.md            design system and aesthetic decisions
```

The catalog is the heart of Prism. Today there are **71 annotated
entries out of 644 total**. All videos are captured headless. Cloudflare
R2 hosts them.

## How a prompt becomes a visual

Every visualization is a small node graph. The graph is a JSON file.
It says how signals turn into frames. Then how those frames reach the
screen.

You give the API a prompt. Gemini writes the graph. The browser runs
it.

Here is a typical graph today.

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

Every node has a role. There are five.

| Role | What it does | Examples |
|---|---|---|
| `signal.*` | Makes a stream of data | `signal.audio`, `signal.cursor`, `signal.heartbeat` |
| `xform.*` | Changes a signal | `xform.gain`, `xform.beat` |
| `lf.*` | Makes frames from signals | `lf.milkdrop`, `lf.shadertoy` |
| `op.*` | Changes frames | `op.blend`, `op.displace`, `op.feedback` |
| `sink.*` | Sends frames somewhere | `sink.display`, `sink.recorder` |

Today's graphs use three nodes. A signal, a generator, a sink. Future
graphs will layer many generators. New node types plug in without
rewrites.

### Why a JSON notation?

TouchDesigner, Notch, Cables.gl, vvvv, and ComfyUI all use node
graphs. Each one uses its own format. Prism proposes an open JSON
notation so visualizers are:

- **agent-friendly**. An AI can read and write a graph.
- **shareable**. A graph is about 1 KB. A URL hash carries the whole
  thing.
- **editable**. By a prompt today. By a node editor tomorrow. By hand
  whenever.

Adding a new generator takes two files. A runtime that knows how to
play it. A new node type. The gallery, the prompt loop, and the AI
router get it for free.

## Three ways to contribute

Prism grows with every contributor. Think Wikipedia for visualizations.
AI is the curator.

### 1. Run the capture pipeline on your machine

Add presets or shaders you like. Capture them. Annotate them. Send a
PR.

```sh
git clone git@github.com:scottspace/prism.git
cd prism && pnpm install
cp .env.example .env       # add GEMINI_API_KEY, R2_*, VITE_GEMINI_API_KEY

pnpm dev                                          # the capture server
pnpm prism ingest <path-to-presets-or-shaders>    # adds catalog/entries/*
pnpm prism annotate --all                         # capture, annotate, upload
pnpm prism build-index                            # rebuild catalog/index.json

git add catalog/ && git commit -m "Add N presets" && pr it
```

Each entry takes about 15 seconds to capture. About 3 seconds to
annotate. You can add 50 to 100 entries in a Saturday afternoon.

### 2. Add a new visualization source

Today Prism runs two sources. **Milkdrop** through butterchurn.
**Shadertoy** through a custom WebGL2 runtime. Next on the list are
ISF and hand-written WGSL.

Each new source needs two files.

```
src/landing/<source>-bg.ts                       # the live runtime
scripts/pipelines/capture-pages/<source>.html    # the capture harness
```

The shared `CatalogEntry` schema does the rest. The gallery, the API,
and the prompt loop work without changes.

### 3. Add a signal source

Signals make visualizations react. The app already supports cursor,
audio from a shared tab, heart rate from Pulsoid, and a synthetic
pink-noise driver. Camera, pose, MIDI, breath, OSC, EEG. All welcome.
A signal is a small module that streams numbers, vectors, or textures.

## Quick start

```sh
git clone git@github.com:scottspace/prism.git
cd prism
pnpm install
pnpm dev
# visualizer:  http://localhost:5173/landing.html
# gallery:     http://localhost:5173/gallery.html
```

## Stack

- **Frontend** uses Vite and TypeScript. No framework.
- **Runtimes** are butterchurn for Milkdrop and a custom WebGL2
  runtime for Shadertoy 300-es with iChannel uniforms.
- **AI** is `gemini-flash-latest` through the `@google/genai` SDK. It
  handles annotation and prompt-to-graph.
- **Storage** is Cloudflare R2 for captured WebMs and thumbnails. R2
  is S3-compatible.
- **Pipeline** uses Puppeteer with headless Chrome and SwiftShader.
  MediaRecorder writes VP9 at 1280×720.
- **Deploy** is Vercel for static and edge functions. The build stamps
  the git SHA into the page. Hover the version tag for the build time.
- **License** is MIT.

## Docs

**[BRAND.md](BRAND.md)** covers the design system and the "creative
cockpit" aesthetic.

## Inspiration

Geiss made Milkdrop in 2001. It proved audio-reactive visuals could
become culture. Quílez launched Shadertoy in 2013. It showed that
shader sharing could become a community. VIDVOX made ISF. It proved
that declared inputs turn shaders into instruments. TouchDesigner and
the broader generative-art world proved data-driven painterly work
belongs in galleries.

**Prism is the AI-era extension of all of these. A runtime. A catalog.
A graph language. A community.**

---

*Built by [Scott Penberthy](https://github.com/scottspace). Open
under MIT. PRs and weird ideas warmly welcomed.*
