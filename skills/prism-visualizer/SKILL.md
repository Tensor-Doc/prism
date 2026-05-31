---
name: prism-visualizer
description: Generate an audio-reactive visualization from a natural-language description, or embed the @tensordoc/prism player into the user's project. Trigger when the user asks for a visualization, music visualizer, audio-reactive graphics, ambient background art, a Milkdrop / Shadertoy preset, or asks to "add a visualizer to my app / page / site."
---

# prism-visualizer

A Claude skill that does two things:

1. **Generate** — turn a natural-language prompt into a playable
   audio-reactive visualization on **prism.scott.ai**, returning a
   short shareable URL.
2. **Embed** — install `@tensordoc/prism` into the user's existing
   project and write the integration code (vanilla HTML, React, Vue,
   Svelte, Next.js, Astro — detected from their `package.json`).

Behind both: the same npm package, the same `/api/generate`
endpoint, the same `PrismGraph` schema.

---

## When to invoke

**Generate flow.** Trigger when the user wants to *see* something:

- "Make me a visualizer for [vibe / mood / music / occasion]"
- "I need ambient art for a livestream / meeting / focus session"
- "Pick a calming / energetic / cosmic / industrial visualization"
- "Find me a Milkdrop preset that matches [description]"
- "Give me a shader that reacts to bass"

**Embed flow.** Trigger when the user wants to *integrate* prism:

- "Add a visualizer to my [React / Vue / Svelte / Next.js / Astro] app"
- "Drop prism into this site"
- "Wire up @tensordoc/prism in my project"
- "Make this div audio-reactive"
- "Embed a music visualizer here"

If the user's intent is ambiguous between the two flows, ask which:
*"Do you want a one-off URL to share, or do you want me to add the
player to your codebase?"*

---

## Flow 1 — Generate a visualization

### How it works

```
user prompt → POST prism.scott.ai/api/generate
            → { graph, short_id }
            → return https://prism.scott.ai/?g=<short_id>
```

Behind the URL:

- prism.scott.ai loads the visualization referenced by `<short_id>`
- The user's tab audio / microphone (if granted) drives reactivity
- The bundled SyntheticSignal driver keeps the visual alive even with no audio

The short_id is a permanent 6-character base62 token bound to a
specific catalog entry. URLs are tweet-friendly and survive renames.

### Calling the API

```bash
curl -X POST https://prism.scott.ai/api/generate \
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

Use these two fields:

- `short_id` — base62 token. Build the URL: `https://prism.scott.ai/?g=<short_id>`
- `graph.intent` — one-sentence description. Use as the link's label.

### What to return to the user

For a typical interactive session:

```
Here's your visualization: https://prism.scott.ai/?g=PTzsKc

  Intent: A slow cosmic nebula with cyan and orange chroma drifting against deep space.

Open the link, share your audio tab, and the visual will react to whatever's playing.
```

For *several* options, call the endpoint multiple times with prompt
variations (`"calming cosmic"`, `"calming abstract"`, `"slow ocean"`)
and return a list with each `intent` as the label.

---

## Flow 2 — Embed in the user's project

### Step 1 — Detect the framework

Look at the user's `package.json` (or `index.html` if no package.json
exists). Use this priority:

| Signal in package.json | Framework |
|---|---|
| `"next": "..."` in dependencies | **Next.js** |
| `"nuxt": "..."` in dependencies | **Nuxt** |
| `"astro": "..."` in dependencies | **Astro** |
| `"@sveltejs/kit": "..."` or `"svelte": "..."` | **Svelte / SvelteKit** |
| `"vue": "..."` (and not Nuxt) | **Vue 3** |
| `"react": "..."` (and not Next.js) | **React** |
| no package.json, has `.html` files | **Vanilla HTML** |
| nothing matches | Ask: *"What framework is this project using?"* |

### Step 2 — Install the package

Detect the package manager from the user's lockfile:

| Lockfile | Command |
|---|---|
| `pnpm-lock.yaml` | `pnpm add @tensordoc/prism` |
| `yarn.lock` | `yarn add @tensordoc/prism` |
| `bun.lockb` | `bun add @tensordoc/prism` |
| `package-lock.json` or none | `npm install @tensordoc/prism` |

Run the install. If it fails, surface the error and stop — don't
write integration code into a broken setup.

### Step 3 — Write the integration code

Pick the template below that matches the detected framework. Write
the file to a reasonable path in the user's project; ask if you're
not sure where (e.g. `src/components/`, `app/components/`,
`pages/`, etc.).

#### Vanilla HTML

Write a new `<script>` block + container `<div>` in the user's HTML
file. Or create a fresh `prism-demo.html` if there's no obvious
host file.

```html
<div id="prism-viz" style="width: 100vw; height: 100vh"></div>
<script type="module">
  import { PrismPlayer } from "https://esm.sh/@tensordoc/prism";

  const player = new PrismPlayer({
    container: "prism-viz",
    // graph: "PTzsKc",     // optional short_id from prism.scott.ai
    // audio: "mic",         // optional — defaults to synthetic signal
  });

  // Browsers require a user gesture before AudioContext starts.
  const resume = () => player.audioCtx.resume();
  window.addEventListener("pointerdown", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });
</script>
```

#### React

Write `src/components/PrismVisualizer.jsx` (or `.tsx`):

```jsx
import { useEffect, useRef } from "react";
import { PrismPlayer } from "@tensordoc/prism";

export function PrismVisualizer({
  graph,           // optional: short_id string or full PrismGraph
  audio = "mic",   // "mic" | "tab" | MediaStream | AudioNode
  style,
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const player = new PrismPlayer({
      container: containerRef.current,
      graph,
      audio,
    });
    const resume = () => player.audioCtx.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      player.destroy();
    };
  }, [graph, audio]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", ...style }} />;
}
```

Usage:

```jsx
<PrismVisualizer graph="PTzsKc" style={{ height: "100vh" }} />
```

#### Next.js (App Router)

Same as React, but mark the component as a client component. Write to
`app/components/PrismVisualizer.jsx`:

```jsx
"use client";

import { useEffect, useRef } from "react";
import { PrismPlayer } from "@tensordoc/prism";

export function PrismVisualizer({ graph, audio = "mic", style }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const player = new PrismPlayer({
      container: containerRef.current,
      graph,
      audio,
    });
    const resume = () => player.audioCtx.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      player.destroy();
    };
  }, [graph, audio]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", ...style }} />;
}
```

#### Vue 3

Write `src/components/PrismVisualizer.vue`:

```vue
<script setup>
import { ref, onMounted, onUnmounted, watch } from "vue";
import { PrismPlayer } from "@tensordoc/prism";

const props = defineProps({
  graph: { type: [String, Object], default: undefined },
  audio: { type: [String, Object], default: "mic" },
});

const containerRef = ref(null);
let player = null;

function init() {
  if (!containerRef.value) return;
  player = new PrismPlayer({
    container: containerRef.value,
    graph: props.graph,
    audio: props.audio,
  });
  const resume = () => player.audioCtx.resume();
  window.addEventListener("pointerdown", resume, { once: true });
}

onMounted(init);
onUnmounted(() => player?.destroy());
watch(() => props.graph, () => {
  if (props.graph) player?.load(props.graph);
});
</script>

<template>
  <div ref="containerRef" style="width: 100%; height: 100%"></div>
</template>
```

#### Svelte

Write `src/lib/PrismVisualizer.svelte`:

```svelte
<script>
  import { onMount, onDestroy } from "svelte";
  import { PrismPlayer } from "@tensordoc/prism";

  export let graph = undefined;
  export let audio = "mic";

  let containerEl;
  let player;

  onMount(() => {
    player = new PrismPlayer({
      container: containerEl,
      graph,
      audio,
    });
    const resume = () => player.audioCtx.resume();
    window.addEventListener("pointerdown", resume, { once: true });
  });

  onDestroy(() => player?.destroy());

  $: if (player && graph) player.load(graph);
</script>

<div bind:this={containerEl} style="width: 100%; height: 100%"></div>
```

#### Astro

Astro components are static — use a `<script type="module">` for the
interactive part. Write `src/components/PrismVisualizer.astro`:

```astro
---
const { graph, audio = "mic", height = "100vh" } = Astro.props;
---

<div id="prism-viz" style={`width: 100%; height: ${height}`}></div>

<script define:vars={{ graph, audio }}>
  import { PrismPlayer } from "https://esm.sh/@tensordoc/prism";

  const player = new PrismPlayer({
    container: "prism-viz",
    graph,
    audio,
  });
  const resume = () => player.audioCtx.resume();
  window.addEventListener("pointerdown", resume, { once: true });
</script>
```

For Astro projects with the npm package installed via `pnpm add`,
swap `https://esm.sh/@tensordoc/prism` → `@tensordoc/prism`.

### Step 4 — Tell the user what you did

Keep it short. Three things:

1. Confirmation: *"Installed `@tensordoc/prism` and added
   `<path-to-file>` with a `PrismVisualizer` component."*
2. How to use it: a one-line usage example with their stack's syntax.
3. Audio note: *"You'll need to share audio (mic or tab) for the
   visualization to react to sound. Without it, the synthetic
   signal keeps the visual alive."*

If the user passed a `graph` short_id from Flow 1, include it in the
usage example.

---

## Optional: hint generation with current context

`/api/generate` accepts two optional fields that bias the AI's choice:

```json
{
  "prompt": "something to match the music",
  "currentGraph": { "schema": "prism.graph/0.1", ... },
  "metadata": {
    "time_of_day": 23,
    "prefers_reduced_motion": false
  }
}
```

Pass `currentGraph` when the user is *iterating* ("similar but more
energetic"); pass `metadata` if the agent knows the user's context.

---

## Error handling

For Flow 1 (generate):

- `404` on the URL → the short_id is unknown. Re-call `/api/generate`.
- `500 { error: "GEMINI_API_KEY not configured" }` → the deployed
  instance hasn't been set up; report to the user.
- `502 { error: "model picked unknown preset_id: …" }` → rare; retry
  with a more concrete prompt.
- Empty `short_id` in the response → fall back to passing the full
  `graph` object via `new PrismPlayer({ graph })`.

For Flow 2 (embed):

- npm install fails → surface the error verbatim, do not write code.
- No `package.json` and no HTML → ask the user where to put the file.
- Framework detection ambiguous (e.g. React inside Next.js) → prefer
  the more specific framework (Next.js over React).

---

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

---

## What this skill is NOT

- Not for generating images or videos — that's a different tool.
- Not for explaining how Milkdrop or shaders work — that's a research question.
- Not for editing existing visualizations — `/api/generate` is one-shot prompt→graph.
- Not for running the visualization headlessly — it always needs a browser canvas.
- Not for injecting prism into a backend / serverless project — it's
  browser-only. If the user's project is Node-only, explain that and
  suggest opening a browser tab on `prism.scott.ai/?g=<id>` instead.

---

## Installation

Copy this file to your Claude skills directory:

```bash
mkdir -p ~/.claude/skills/prism-visualizer
curl -o ~/.claude/skills/prism-visualizer/SKILL.md \
  https://raw.githubusercontent.com/Tensor-Doc/prism/main/skills/prism-visualizer/SKILL.md
```

Then restart Claude Code; the skill is auto-discovered.

---

## Package details

- **npm**: [`@tensordoc/prism`](https://www.npmjs.com/package/@tensordoc/prism)
- **GitHub**: [Tensor-Doc/prism](https://github.com/Tensor-Doc/prism)
- **Site**: [prism.scott.ai](https://prism.scott.ai)
- **Live demo**: [CodeSandbox](https://codesandbox.io/p/sandbox/github/Tensor-Doc/prism/main/examples/codesandbox)
- **License**: MIT
