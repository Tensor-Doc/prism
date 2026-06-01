# Refik Fluid of Flora — shader prompt

Write a Prism-compatible WebGL2 fragment shader that produces the
Refik Anadol "Machine Hallucinations" effect with botanical
imagery as the substance.

## The brief

The screen looks like a slow painterly current of flora flowing
horizontally. The fluid is made of thousands of tiny instances of
flower and leaf images sampled from an image atlas in iChannel1.
Bass audio drives wave amplitude. Mid-band audio drives flow speed.
The image atlas is laid out as a grid of N by N tiles in iChannel1.
The number of tiles per row is provided by the uniform iAtlasSize.
Common values are 4 or 8.

## Visual targets

- Slow continuous left-to-right flow at base velocity ~0.05 uv/sec
- Wavelike vertical undulation. Amplitude scales 0.02 to 0.08 with
  bass.
- Tile instances are small relative to the canvas. Each tile
  contributes a 5 to 10 percent uv-space footprint. There should be
  the impression of thousands of overlapping tiles.
- No visible grid pattern from the atlas layout. Tile selection per
  pixel is randomized.
- Color palette is dark with one luminous accent. The background is
  near-black with a faint warm gradient.
- Atelier mood. Slow, painterly, gallery-grade.

## Audio mapping

```
bass    → wave amplitude (vertical undulation magnitude)
mid     → flow velocity multiplier (horizontal drift speed)
treble  → tile rotation speed (subtle, do not let this dominate)
```

When audio is silent, the visualization still drifts at base
velocity with mild undulation.

## Image sampling strategy

For each output pixel.

1. Compute a curl-noise flow field at the pixel's uv. The flow
   carries the imagery.
2. Integrate backward 1 to 3 steps along the flow field to find the
   source position.
3. Use the source position to determine which tile from the atlas to
   sample. A hash of the integer source position picks an index from
   0 to iAtlasSize squared minus 1.
4. The fractional part of the source position becomes the
   intra-tile uv.
5. Mix the sampled color with the existing fluid color using a soft
   additive blend.

## Constraints

- Single fragment shader. No multi-pass.
- **Performance is critical**. The shader is captured via headless
  Chrome on a busy GPU. Aim for under 8 ms per frame at 1280x720.
- Outer accumulation loop must be at most 6 iterations. Anything
  higher will cause the capture system to time out before it can
  read a frame.
- No nested loops where the inner loop count is greater than 2.
- Total `texture()` calls per pixel should be 8 or fewer.
- Must compile in GLSL 300 es. No double precision. No subpass
  inputs. No compute.
- The shader needs to look interesting in the first second so the
  capture is representative.

## Non-goals for this first draft

- Do not implement a true Navier-Stokes solver. Use curl noise as
  the flow field. The visual goal is approximation of fluid, not
  physical accuracy.
- Do not write to the texture. Read only.
- Do not assume a specific atlas content. The shader must work with
  any 16-tile or 64-tile atlas.

## Iteration log

Each iteration is a separate file under
`concepts/iterations/refik-fluid-flora/iter-NNN/`. The directory
contains.

```
shader.glsl       — the shader as generated this iteration
prompt.txt        — the exact prompt that produced this shader
atlas.jpg         — the image atlas used during capture
preview.webm      — 10 second capture of the running shader
critique.md       — human or AI critique of this iteration
```

The next iteration's prompt is the previous iteration's prompt plus
the critique.
