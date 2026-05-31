# Refactor plan: Prism as an npm package

## Goal

Make Prism a two-line embed for any developer or agent.

```js
import { PrismPlayer } from "prism-player";
new PrismPlayer({ container: document.getElementById("viz"), graph });
```

The deployed site at `prism.run` uses the same package — we eat our
own dogfood. Once the vanilla package is solid, add a React wrapper.
The OSS story becomes: install the package, generate a graph (via
prompt or by hand), drop it in a `<div>`.

## Package structure

pnpm workspaces. Site stays at repo root. New code lives under
`packages/`.

```
packages/
  prism-player/        # the runtime — vanilla TS, no framework
    src/
      index.ts         # PrismPlayer class — public API
      runtime.ts       # graph executor
      types.ts         # PrismGraph schema
      backends/
        milkdrop.ts    # butterchurn wrapper
        shadertoy.ts   # WebGL2 shader runtime
      audio.ts         # optional helper for tab / mic capture
    package.json
    vite.config.ts     # lib build (ESM + CJS + .d.ts)

  prism-react/         # thin component wrapper, peer-deps prism-player
    src/index.tsx      # <Prism graph={...} />

src/                   # site stays here, imports from packages
  landing/             # thin shell wiring chrome to PrismPlayer
  gallery/             # unchanged
scripts/  api/  catalog/  public/
```

## What moves where

| Today (src/landing/) | Tomorrow (packages/prism-player/src/) |
|---|---|
| `graph/types.ts` | `types.ts` |
| `graph/runtime.ts` | `runtime.ts` |
| `milkdrop-bg.ts` | `backends/milkdrop.ts` |
| `shadertoy-bg.ts` | `backends/shadertoy.ts` |
| `audio.ts` | `audio.ts` (optional re-export) |

What stays in the app: cursor field, telemetry, prompt panel, gallery
card, status bars, ChromeIdle, version stamping, image sources
(NasaImages, TabVideo), all the UI surface around the runtime.

## Public API

```ts
import { PrismPlayer, type PrismGraph } from "prism-player";

const player = new PrismPlayer({
  container: HTMLElement,           // required — the player creates its own canvas inside
  graph?: PrismGraph,               // initial graph; can also call load() later
  audio?: "mic" | "tab"
        | MediaStream
        | AudioNode
        | undefined,                // if undefined, runs the synthetic signal
  defaultImage?: string,            // iChannel1 fallback for image-input shaders
  onError?: (err: Error) => void,
});

await player.load(newGraph);        // swap to a new graph (cross-blends)
player.connectAudio("mic");         // change audio source
player.setLiveSource(canvas);       // override iChannel1 (gallery feed)
player.destroy();                   // clean up
```

React (later):

```tsx
import { Prism } from "prism-react";

<Prism graph={graph} audio="mic" />
```

## Build & publish

- `vite` library mode → ESM + CJS + `.d.ts`
- `butterchurn` declared as peerDependency (consumers install it for
  milkdrop support; pure-shader consumers don't pay the ~500 KB cost)
- Package name: `prism-player` (unscoped — friendlier for OSS) or
  `@prism/player` (scoped — only if we own the org)
- License: MIT

## Milestones

Each milestone is independently committable and verifiable.

### M1 — Workspace setup (~1 h)

- `pnpm-workspace.yaml` at root listing `packages/*`
- `packages/prism-player/package.json` skeleton
- Site builds, no behavior change

**Verify:** `pnpm install` works, `pnpm build` still produces the same site.

### M2 — Extract types (~1 h)

- Move `PrismGraph`, node types, `SCHEMA_VERSION` to
  `packages/prism-player/src/types.ts`
- Package re-exports from `index.ts`
- Site imports types from `prism-player` (workspace protocol)

**Verify:** `pnpm typecheck` clean, no runtime change.

### M3 — Extract backends (~3 h)

- Move `milkdrop-bg.ts` and `shadertoy-bg.ts` into
  `packages/prism-player/src/backends/`
- Strip any landing-only references (cursor field, telemetry hooks)
- AudioContext becomes a constructor param so the package owns nothing
- Site imports the backends from `prism-player`

**Verify:** Site renders milkdrop + shadertoy as before. Prompt loop
works, gallery loads, audio reactivity works.

### M4 — `PrismPlayer` class (~2 h)

- `packages/prism-player/src/index.ts` exposes `PrismPlayer`
- It owns: a canvas inside `container`, a graph runtime, an audio
  source (synthetic by default)
- Site refactors `main.ts` to instantiate `PrismPlayer` and wire UI
  events to its methods, instead of touching backends directly

**Verify:** Same site behavior. Code in `src/landing/main.ts` drops
~200 lines.

### M5 — Library build config (~2 h)

- `vite.config.ts` in package with `build.lib`
- `vite-plugin-dts` for `.d.ts` emission
- `package.json` `exports` map: ESM, CJS, types
- Externalize `butterchurn` so it's a peerDep

**Verify:** `pnpm --filter prism-player build` produces a usable bundle.
Import it from a fresh Node REPL and check the `PrismPlayer` symbol.

### M6 — npm publish v0.1 (~1 h)

- README in the package
- LICENSE
- `npm publish` (after `npm login` and ownership of the name)
- Create a CodeSandbox using the published package

**Verify:** The CodeSandbox plays a shader from a `PrismGraph` JSON.

### M7 — React wrapper (~2 h)

- `packages/prism-react/src/index.tsx`
- `<Prism graph={...} audio={...} />` — thin useEffect lifecycle
  around the vanilla player
- `peerDependencies`: react, prism-player

**Verify:** Component remounts cleanly on graph swap, no resource
leaks across renders.

### M8 — Agent skill spec (~2 h)

- Document a Claude/OpenAI tool spec for `create_visualization`
- Input: natural-language prompt
- Output: `PrismGraph` JSON + a `prism.run/?graph=<hash>` embed URL
- README section "for agents" includes the spec inline so an agent
  can be wired up in one paste

**Verify:** Hand the spec to a fresh Claude session, ask it to make a
"calming cosmic" visualization, verify the returned URL plays.

## Total: ~14–18 hours of focused work

## Out of scope (defer)

- Vendoring butterchurn to add missing samplers (the plasma family)
- WASM / native compilation
- Video export from the npm package
- Custom node-editor UI
- A separate `prism-cli` for headless rendering (already covered by
  `pnpm prism annotate`, just not packaged for consumers)

## Risks

- **Bundle size.** butterchurn alone is ~500 KB. Peer-dep model
  shifts the cost to consumers who opt in.
- **Audio context ownership.** The package needs to either create
  one or accept one. Two callers in the same page sharing a context
  is a common mistake — document clearly.
- **Canvas mounting.** Some hosts (Notion, embed iframes) constrain
  what we can create. Worth testing in a few environments before v1.
- **Breaking site refactor.** Moving the runtime out of `src/landing`
  is the most invasive step (M3/M4). Should land behind feature flag
  or on a branch with thorough manual testing.

## Definition of done (v0.1)

- `npm i prism-player` from a fresh project gives you `PrismPlayer`
- Two lines of JS in a blank HTML page plays a shader from a graph
- The deployed `prism.run` site uses the published package, not the
  inlined sources
- README on npm and a working CodeSandbox link
