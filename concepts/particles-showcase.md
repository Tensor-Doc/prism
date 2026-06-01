# Particle Backend Showcase Roadmap

The Prism particle backend (`lf.particles`) is a 3D instanced
GPU particle system shipping in `@tensordoc/prism@0.1.4`. This
document plans the next wave of particle concepts that show off
its range. The goal is to land 10-15 concepts spanning the
music-visualization canon, with priority to ones that **use
images** as the particle medium since that's the backend's
distinguishing feature.

## Current backend capability (v1)

- **65,536 GPU particles** via RGBA32F state-texture ping-pong
- **3D curl-noise flow field** evolving over time
- **Wave attractor** with five layered sinusoidal swells
- **Solar-corona arcs** when audio bass spikes (vertical curl boost)
- **Crossed billboards** per particle (2 perpendicular textured quads)
- **Per-particle 3D rotation** with optional audio-driven wobble
- **Per-particle power-law size variance**
- **Slow camera orbit** at configurable height + radius
- **Audio reactivity**: bass amplifies vertical motion, mid drives
  flow velocity, treble for accent
- **Atlas tile sampling** with soft elliptical mask + life fade-in
  + depth-based fog

## Currently shipped — Tier 1 batch (10 concepts)

All ten Tier 1 concepts are live in the gallery as of `0.1.4`.

| Rank | Concept | Short ID | Capture size |
|---|---|---|---|
| #1 | Solar Wind | `EqdmpR` | 8.7 MB |
| #2 | Coral Garden | `cJF2H7` | 8.1 MB |
| #3 | Refik Rolling Ocean of Flora | `U0D2Ci` | 7.9 MB |
| #4 | Embers Rising | `P5OFbe` | 7.5 MB |
| #6 | Schooling Fish | `CziRzn` | 7.3 MB |
| #11 | Cherry Blossom Storm | `5zUZFz` | 6.8 MB |
| #16 | Origami Flock | `Bv8pPx` | 6.4 MB |
| #19 | Murmuration | `1Ydj3x` | 6.0 MB |
| #89 | Falling Snow | `rlyB3L` | 4.6 MB |
| #124 | Galactic Dust | `35Rx8l` | 3.0 MB |

Eight of ten are in the tier-0 feature pool (atelier + motion > 0.2).
Falling Snow and Galactic Dust sit deeper in the gallery because
they are intentionally low-motion meditative pieces and Gemini
classified them outside atelier accordingly.

The full atlases and per-concept tunables live under
`public/presets/particles/`. The pipeline that produced them is
`pnpm prism build-particle-showcase` in
`scripts/prism/commands/build-particle-showcase.ts`.

---

## Tier 1 — same backend, swap atlas + tunables

These need no new code. Each is a Nano Banana atlas prompt +
preset JSON values + capture + annotate.

### 2. Cherry Blossom Storm
- **Reference**: Japanese hanami, "Lost in Translation" tea-garden
  scene, anime petal sequences
- **Atlas**: pink cherry blossom petals on dark backgrounds, varied
  angles and lighting, some with white centers and some with
  ruffled edges
- **Tunables**: strong horizontal drift, larger volume, low audio
  reactivity (these drift gently in wind), light pastel palette
- **Feel**: contemplative, atmospheric, romantic

### 3. Solar Wind
- **Reference**: NASA solar dynamics observatory footage, ESA's
  Parker Solar Probe imagery
- **Atlas**: glowing plasma streaks, sunburst flares, magnetic
  field lines on black
- **Tunables**: very high velocity_stretch (particles read as
  streaks), additive blending preferred, hot palette, dance off
- **Feel**: cosmic, energetic, dramatic

### 4. Schooling Fish
- **Reference**: BBC Blue Planet underwater shots, Yves Klein
  "Anthropometries"
- **Atlas**: silver/blue fish sprites in various swim positions
- **Tunables**: tighter clustering via stronger curl coupling,
  medium velocity_stretch, low corona_boost (fish don't erupt
  upward on bass)
- **Feel**: aquatic, fluid, alive

### 5. Murmuration
- **Reference**: starling flocks at dusk, Andy Goldsworthy
  documentaries
- **Atlas**: small dark bird silhouettes at various angles
- **Tunables**: high curl_scale (fine-grained turbulence), low
  saturation, dusk palette (orange-purple ground)
- **Feel**: organic emergence, dusk atmospheric

### 6. Embers Rising
- **Reference**: campfire macros, dragon-fire scenes in cinema
- **Atlas**: glowing orange/red ember particles, varying brightness
- **Tunables**: STRONG upward bias (overrides flow_drift_x
  horizontal default), very high audio_gain on bass, hot palette
- **Feel**: warm, primal, mesmerizing

### 7. Falling Snow
- **Reference**: snow-globe close-ups, "Spirited Away" snow scenes
- **Atlas**: snowflakes in many crystal patterns on dark
- **Tunables**: downward drift (negative flow_drift_x mapped to y
  via volume rotation, or just gravity-style velocity bias), low
  audio reactivity, cold palette
- **Feel**: serene, quiet, slow

### 8. Galactic Dust
- **Reference**: Hubble images of dust lanes, Sagan's "Cosmos"
- **Atlas**: small star points, dust clouds, distant galaxies as
  blurred light smudges
- **Tunables**: huge volume_size, low velocity_damp (drift
  forever), spiral attractor instead of wave (needs small backend
  add — promoted to Tier 2)
- **Feel**: vast, contemplative, scale-shifted

### 9. Origami Flock
- **Reference**: paper crane installations, Tomás Saraceno
  "Aerocene"
- **Atlas**: small paper birds/butterflies in white/cream/pastel on
  varied paper textures
- **Tunables**: gentle horizontal flow, low size variance, soft
  palette, audio-driven rotation wobble (paper birds nod with bass)
- **Feel**: light, contemplative, museum-grade

### 10. Coral Garden
- **Reference**: BBC Blue Planet coral macro shots, Refik Anadol
  "Coral Dreams"
- **Atlas**: vivid coral polyps in coral-red, magenta, teal
- **Tunables**: vertical orientation (corals grow upward), gentle
  swell, deep-water palette (dark teal + accent reds)
- **Feel**: alive, underwater, slow undulation

---

## Tier 2 — requires small backend additions

These need a single named feature each. Worth doing if the visual
warrants it.

### 11. Spiral Galaxy
- **New feature**: spiral attractor (radial inward + tangential
  velocity) instead of horizontal wave
- **Atlas**: same as Galactic Dust
- **Implementation**: replace wave-attractor block with spiral
  velocity field driven by polar angle around camera center

### 12. Aurora Borealis
- **New feature**: vertical curtain shape (slab tall instead of
  wide), color shift per particle based on Y position
- **Atlas**: glowing green/teal/purple light particles
- **Implementation**: rotate the volume_size axes + add height-based
  color tint uniform in render shader

### 13. Memo Akten Forms (figure-tracking version)
- **New feature**: signed-distance field input texture for
  attractor (particles cluster around a silhouette)
- **Atlas**: simple white blob sprites
- **Implementation**: add `sdf_url` preset field; sample SDF in
  update shader, particles pulled toward zero-level set

### 14. Ryoji Ikeda data.matrix
- **New feature**: grid-snapping in the update shader (lock
  particles to discrete grid cells), strict orthographic view
- **Atlas**: monochrome binary pixels, numeric glyphs
- **Implementation**: switch to ORTHO projection matrix when
  preset.projection === "ortho"; add grid snap uniform

---

## Tier 3 — requires major backend feature work

These are the "wow" tier from the music-particle canon. Each is a
real engineering project but each transforms the system.

### 15. Magnetosphere (Robert Hodgin / iTunes 2007)
- **Reference**: Hodgin's iconic visualizer
- **New features needed**:
  - **Boids flocking** (separation, alignment, cohesion) —
    voxelize space + per-voxel neighbor counts
  - **Persistent screen-space trails** (decay-blend previous
    frame at 0.93 alpha, draw new particles on top)
  - **Beat detection** (peak-pick the bass envelope, fire
    coordinated burst events)
- **Atlas**: glowing soft-light sprites
- **Implementation**: cost ~1 day total. This is the headline
  feature for a future v0.2 release.

### 16. Squarepusher Strobe (Daito Manabe)
- **New features needed**:
  - **Beat detection** with snap-to-grid camera reorientation
  - **Per-frame full-volume color cycling** synced to beat
- **Atlas**: geometric shapes (cubes, lines)
- **Implementation**: composes from beat detection (used by
  Magnetosphere) + a color-cycle uniform

### 17. Liquid Latent Walk (Refik-style generated medium)
- **New features needed**:
  - **Multiple atlases** with crossfade over time (simulates a
    GAN/diffusion latent space walk)
  - **Slow temporal blending** between concept atlases
- **Atlas**: a sequence of 3-5 atlases bundled into one preset
- **Implementation**: extend ParticlesPreset to accept
  `atlas_urls: string[]` and `transition_seconds: number`

---

## Implementation order

1. **Tier 1 batch first** (Cherry Blossom → Coral Garden). Same
   pipeline, varying atlases. Should land 6-9 concepts in a
   single afternoon of Nano Banana + annotate cycles.
2. **Tier 2 second**, picking 1-2 that are visually distinctive.
3. **Tier 3 only when v0.2 backend work is funded** — needs the
   trails + beat + flock feature pack.

## Pipeline per concept

```
# 1. Atlas: Nano Banana generates a 4×4 grid of relevant macros
pnpm prism iterate-atlas <concept> --prompt="..."

# 2. Preset: hand-write the JSON tunables
public/presets/particles/<concept>.json

# 3. Catalog entry with hand-seeded annotation:
catalog/entries/particles_<concept>.json

# 4. Capture + annotate + R2 upload
pnpm prism annotate particles:<concept>

# 5. Surface in gallery
pnpm prism build-index
```

## What "success" means per concept

A concept is shippable if its 15s capture is:
- Over 500KB (clears the empty-render guard automatically)
- Visually recognizable as the reference (not a generic blob)
- Gemini classifies as `atelier: true` (or we can hand-seed)
- Looks good in the gallery card hover preview

Concepts that fail get an entry but stay marked `renders: false`
so the gallery sort buries them. We document the failure
mode in this file and move on.
