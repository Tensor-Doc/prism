# @tensordoc/prism

Two-line embed for audio-reactive visualizations. Drop a `<div>`,
call `new PrismPlayer({ container })`, get a Milkdrop preset or
Shadertoy fragment shader playing in the browser — reacting to
whatever audio you connect.

**▶ Try it live in
[CodeSandbox](https://codesandbox.io/p/sandbox/github/Tensor-Doc/prism/main/examples/codesandbox)
or
[StackBlitz](https://stackblitz.com/github/Tensor-Doc/prism/tree/main/examples/codesandbox)**

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

**Two rendering backends** that swap automatically based on the
graph you load:

- **Milkdrop** via [butterchurn](https://github.com/jberg/butterchurn) —
  ~80 named presets ship in the bundle
- **Shadertoy** — any GLSL fragment shader following Shadertoy's
  `mainImage()` convention; loaded from a URL

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
player.activeBackend   // "milkdrop" | "shadertoy"
player.milkdrop        // butterchurn handle
player.shadertoy       // shader runtime
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

ESM ~25 KB gzipped (excluding butterchurn). Butterchurn itself ships
in the bundle as a regular dependency (~500 KB). If you don't need
Milkdrop and only want shader visualizations, you can tree-shake
butterchurn out by importing only what you use:

```js
import { createShadertoyBackground } from "@tensordoc/prism";
```

## License

[MIT](./LICENSE)
