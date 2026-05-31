---
name: prism-visualizer
description: Generate an audio-reactive visualization from a natural-language description and return a shareable prism.run URL the user can open. Trigger when the user asks for a visualization, music visualizer, audio-reactive graphics, ambient background art, a Milkdrop / shadertoy preset, or "something to play while I work."
---

# prism-visualizer

A Claude Code skill that turns a short prompt into a working
audio-reactive visualization on **prism.run** — a free, open-source
visualizer engine for Milkdrop presets and Shadertoy fragment
shaders. The skill is the agent-facing wrapper around the same
`/api/generate` endpoint that drives the prism.run website.

## When to invoke

Use this skill when the user says any of:

- "Make me a visualizer for …"
- "I need ambient art for a livestream / meeting / workout / focus session"
- "Pick a calming / energetic / cosmic / industrial visualization"
- "Find me a Milkdrop preset that matches …"
- "Give me a shader that reacts to bass"

Use it whenever the user wants to **see something audio-reactive** —
the skill returns a URL they can open in any browser and immediately
play music against.

## How it works

```
user prompt → POST prism.run/api/generate
            → { graph, short_id }
            → return https://prism.run/?g=<short_id>
```

Behind the URL:

- prism.run loads the visualization referenced by `<short_id>`
- The user's tab audio / microphone (if granted) drives reactivity
- The bundled SyntheticSignal driver keeps the visual alive even with no audio

The short_id is a permanent 6-character base62 token bound to a
specific catalog entry. URLs are tweet-friendly and survive renames.

## Calling the API

```bash
curl -X POST https://prism.run/api/generate \
  -H "Content-Type: application/json" \
  -d '{ "prompt": "calming cosmic nebula" }'
```

Response (200):

```json
{
  "graph": {
    "schema": "prism.graph/0.1",
    "id": "g_xxxxxxxx",
    "intent": "A slow cosmic nebula with cyan and orange chroma drifting against deep space.",
    "nodes": {
      "audio_in": { "type": "signal.audio" },
      "main": {
        "type": "lf.milkdrop",
        "params": { "preset_name": "Geiss - Reaction Diffusion 2", "blend_seconds": 2.5 },
        "inputs": { "audio": "audio_in.signal" }
      },
      "out": { "type": "sink.display", "inputs": { "frame": "main.frame" } }
    },
    "output": "out"
  },
  "short_id": "PTzsKc"
}
```

The two fields you usually want:

- `short_id` — base62 token to build the shareable URL: `https://prism.run/?g=<short_id>`
- `graph.intent` — one-sentence description of what the user will see; use as the link's label

## What to return to the user

For a typical interactive Claude Code session:

```
Here's your visualization: https://prism.run/?g=PTzsKc

  Intent: A slow cosmic nebula with cyan and orange chroma drifting against deep space.

Open the link, share your audio tab, and the visual will react to whatever's playing.
```

If the user asks for *several options* or a *playlist*, call the
endpoint multiple times with variations on the prompt
(`"calming cosmic"`, `"calming abstract"`, `"slow ocean"`, etc.) and
return the list of URLs with each `intent` as the label.

## Optional: hint with current context

`/api/generate` accepts two optional fields that bias the AI's choice:

```json
{
  "prompt": "something to match the music",
  "currentGraph": { "schema": "prism.graph/0.1", ... },   // last graph in use
  "metadata": {
    "time_of_day": 23,
    "prefers_reduced_motion": false
  }
}
```

Pass `currentGraph` when the user is *iterating* ("similar but more
energetic"); pass `metadata` if the calling agent knows the user's
local conditions.

## Embedding instead of URL

For agents that render rich UI (e.g., building an artifact), you can
embed the visualization directly:

```html
<script type="module">
  import { PrismPlayer } from "https://esm.sh/prism-player";
  new PrismPlayer({ container: "viz", graph: "PTzsKc" });
</script>
<div id="viz" style="width:100vw;height:100vh"></div>
```

The `graph: "PTzsKc"` lookup happens against the npm package's
bundled registry — no network call. Audio defaults to the synthetic
signal; pass `audio: "mic"` to react to the user's microphone.

## Error handling

- `404` on the URL → the short_id is unknown. Re-call `/api/generate` and use the fresh `short_id`.
- `500 { error: "GEMINI_API_KEY not configured" }` → the deployed instance hasn't been set up; report to the user.
- `502 { error: "model picked unknown preset_id: …" }` → rare; retry with a more concrete prompt.
- Empty `short_id` in the response → the picked preset isn't in the
  share registry; fall back to passing the full `graph` object via
  `new PrismPlayer({ graph })` in the embedded approach.

## Examples to use as inspiration when generating prompts

The site's own suggestion chips — these all produce good results:

- calming cosmic nebula
- fractal kaleidoscope
- dreamy dark mirage
- wormhole tunnel at light speed
- plants growing slowly
- stormy sea at dusk
- geometric neon shapes pulsing
- warm painterly fire
- fluid paint spilling with bass
- industrial chains breaking
- frosty crystal cave
- a single luminous orb
- sunflower opening
- skylight cathedral

## What this skill is NOT

- Not for generating images or videos — that's a different tool.
- Not for explaining how Milkdrop or shaders work — that's a research question.
- Not for editing existing visualizations — the API is one-shot prompt→graph.
- Not for running the visualization headlessly — it always needs a browser canvas.

## Installation

```bash
mkdir -p ~/.claude/skills/prism-visualizer
curl -o ~/.claude/skills/prism-visualizer/SKILL.md \
  https://raw.githubusercontent.com/scottspace/prism/main/skills/prism-visualizer/SKILL.md
```

Then restart Claude Code; the skill is auto-discovered.
