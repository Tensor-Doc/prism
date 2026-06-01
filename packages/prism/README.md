# @tensordoc/prism

Two-line embed for audio-reactive visualizations. Drop a `<div>`,
call `new PrismPlayer({ container })`, get a Milkdrop preset,
Shadertoy fragment shader, or 3D particle field playing in the
browser — reacting to whatever audio you connect.

**▶ Live demo at
[prism.scott.ai/examples/embed.html](https://prism.scott.ai/examples/embed.html).
Fork in
[CodeSandbox](https://codesandbox.io/p/sandbox/github/Tensor-Doc/prism/main/examples/codesandbox)
or
[StackBlitz](https://stackblitz.com/github/Tensor-Doc/prism/tree/main/examples/codesandbox).**

```bash
npm install @tensordoc/prism
```

```html
<div id="viz" style="width:100vw;height:100vh"></div>
<script type="module">
  import { PrismPlayer } from "@tensordoc/prism";
  new PrismPlayer({ container: "viz" });
</script>
```

That's it. The visualization runs against a built-in synthetic signal
until you connect real audio.

## Live demo

[**prism.scott.ai**](https://prism.scott.ai) — the deployed site uses this
exact package. The "Two-line embed" preview at
[prism.scott.ai/examples/embed.html](https://prism.scott.ai/examples/embed.html)
is the smallest possible HTML page using it.

## What you get

**Three rendering backends** that swap automatically based on the
graph you load:

- **Milkdrop** via [butterchurn](https://github.com/jberg/butterchurn) —
  ~80 named presets ship in the bundle
- **Shadertoy** — any GLSL fragment shader following Shadertoy's
  `mainImage()` convention; loaded from a URL
- **Particles** — instanced GPU particle systems with curl-noise flow,
  audio-reactive forces, atlas-textured sprites, and a slow camera
  orbit. The renderer is lazy. The state textures and shaders only
  spin up if you actually load a particles graph.

### The Particles backend

The third backend, added in `0.1.4`, is a native 3D GPU particle
system. Each particle is a small textured sprite drifting through a
curl-noise flow field, with audio reactivity wired directly into the
update shader. The defining feature is that the particle medium is
**an image atlas**. You provide a 4×4 grid of tile images and the
backend samples one tile per particle, so the fluid behavior renders
out of your visual content rather than abstract math.

```js
new PrismPlayer({
  container: "viz",
  graph: "U0D2Ci",   // Refik Rolling Ocean of Flora, ships with prism
});
```

Particle entries live in the same catalog as Milkdrop and Shadertoy
presets, so the player loads them via the same `?g=<short_id>` flow.
You can also instantiate the backend directly for a custom preset:

```js
import { createParticlesBackground } from "@tensordoc/prism";

const audioCtx = new AudioContext();
const bg = createParticlesBackground(audioCtx, canvas, audioCtx.createGain());
await bg.loadFromUrl("/my-preset.json");
bg.connectAudio(myAudioNode);
```

A preset JSON is just tunables — atlas URL, particle size, velocity
stretch, curl scale, audio gain, wave amplitude, camera radius.
Twenty or so knobs in total. The full list is in the
[`ParticlesPreset` type](./src/backends/particles.ts).

Under the hood: 65,536 particles in RGBA32F state textures; one MRT
update pass writes position and velocity each frame; the render pass
draws instanced crossed-billboard quads with per-particle 3D
rotation, life fade-in, depth fog, and a slow camera orbit. The
backend boots lazily, so consumers that only load Milkdrop or
Shadertoy entries never pay the WebGL2 state-texture cost.

**Six audio sources** the player accepts:

```js
new PrismPlayer({
  container: "viz",
  audio: "mic",                       // getUserMedia
  audio: "tab",                       // getDisplayMedia
  audio: someAudioNode,               // your Web Audio graph
  audio: someMediaStream,             // anything with audio tracks
  // audio: undefined (default)       → built-in synthetic signal
});
```

**Six image sources** for shader inputs (`iChannel1`):

```js
new PrismPlayer({
  container: "viz",
  image: "https://example.com/a.jpg",        // single URL
  image: ["a.jpg", "b.jpg", "c.jpg"],        // built-in crossfading slideshow
  image: "webcam",                            // getUserMedia({video: true})
  image: "tab",                               // getDisplayMedia({video: true})
  image: someVideoElement,                    // <video>
  image: someCanvas,                          // your own renderer
});

// Tune slideshow timing
new PrismPlayer({ container, image: ["a.jpg","b.jpg"], holdSeconds: 6 });
```

**Methods** for runtime control:

```js
player.load(graphOrShortId);     // swap visualization
player.connectAudio("mic");      // change audio source
player.disconnectAudio();        // revert to synthetic signal
player.connectImage("webcam");   // change image feed
player.disconnectImage();        // release webcam track, etc.
player.destroy();                // clean up everything
```

**Readonly handles** for power users (the underlying primitives are
exposed; you can call them directly):

```js
player.audioCtx        // AudioContext
player.activeBackend   // "milkdrop" | "shadertoy" | "particles"
player.milkdrop        // butterchurn handle
player.shadertoy       // shader runtime
player.particles       // particle backend (null until first lf.particles load)
player.synth           // synthetic signal driver
player.runtime         // graph executor
```

## Share-by-URL with short IDs

Every curated catalog entry has a permanent **6-character base62
share token**. Same idea as YouTube video IDs:

```js
new PrismPlayer({ container: "viz", graph: "7Hq3pK" });
```

The lookup happens against the bundled registry — no network call. The
companion site exposes `prism.scott.ai/?g=<id>` as a one-click shareable URL.

```js
import { lookup, shortIdToGraph } from "@tensordoc/prism";
lookup("7Hq3pK");          // { name, source_type, source_url, ... }
shortIdToGraph("7Hq3pK");  // ready-to-use PrismGraph
```

## Constructor options (full)

```ts
new PrismPlayer({
  container: HTMLElement | string,          // required — DOM id or element
  graph?: PrismGraph | string,              // short_id or full graph
  audio?: "mic" | "tab" | MediaStream | AudioNode,
  audioCtx?: AudioContext,                  // bring your own
  image?: ImageSource,                      // see "image sources" above
  holdSeconds?: number,                     // slideshow timing, default 6
  defaultImage?: string,                    // static fallback URL
  initialPresetName?: string,               // cold-open Milkdrop preset
  onReady?: () => void,                     // first-frame callback
  onError?: (err: Error) => void,
});
```

## Optional: draggable picture-in-picture overlay

If you want a Picture-in-Picture viewer for the slideshow, ship with
`ImageOverlay` — a separate export that gives you a draggable,
resizable, collapsible card. The player stays headless; you compose:

```js
import { ImageOverlay } from "@tensordoc/prism";
const overlay = new ImageOverlay({ mount: document.body });
// overlay.element is a DOM div you can position or style;
// overlay.rect is the current rectangle, updated on drag/resize
```

## Use from a CDN (no install)

```html
<script type="module">
  import { PrismPlayer } from "https://esm.sh/@tensordoc/prism";
  new PrismPlayer({ container: "viz" });
</script>
```

## Audio context note

Browsers require a user gesture before audio starts. The player
creates an AudioContext but leaves it suspended; resume it on the
first interaction:

```js
const resume = () => player.audioCtx.resume();
window.addEventListener("pointerdown", resume, { once: true });
window.addEventListener("keydown", resume, { once: true });
```

## Bundle size

ESM ~32 KB gzipped (excluding butterchurn). Butterchurn itself ships
in the bundle as a regular dependency (~500 KB). If you don't need
Milkdrop and only want shader or particle visualizations, you can
tree-shake butterchurn out by importing only what you use:

```js
import { createShadertoyBackground, createParticlesBackground } from "@tensordoc/prism";
```

## License

[MIT](./LICENSE)
