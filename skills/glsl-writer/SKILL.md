---
name: glsl-writer
description: Write a Prism-compatible WebGL2 GLSL 300 es fragment shader from a concept brief. Use when the user or another agent asks for a Shadertoy-style fragment shader to embed in Prism, the @tensordoc/prism player, or the prism.scott.ai catalog. Returns valid GLSL that compiles and renders without modification.
---

# GLSL Writer

A specialized skill for writing fragment shaders that work in
Prism's Shadertoy backend. Prism is a WebGL2 audio-reactive
visualization runtime. The output of this skill is a single .glsl
fragment shader that compiles and runs in Prism's existing
shadertoy.html capture harness without modification.

## When to invoke

Whenever the user wants a Shadertoy-style fragment shader that runs
in Prism. Common triggers.

- "Write me a shader that does X"
- "Generate a Refik-style fluid for the catalog"
- "Make a shader that uses iChannel1 as a kaleidoscope"
- "Iterate on this shader to add audio reactivity"

## The Prism Shadertoy convention

Every Prism shader must define one entry point.

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // your code
  fragColor = vec4(rgb, 1.0);
}
```

The Prism harness wraps this with the GLSL 300 es preamble and main
function. Do not include `#version`, `precision`, `in vec2 v_uv`,
`out vec4 outColor`, or a `void main()`. Only output the
`mainImage` function and any helper functions it references.

### Uniforms available (PRE-DECLARED — DO NOT REDECLARE)

The Prism preamble already declares the uniforms below. Your shader
must NOT include `uniform` statements for any of them. Doing so
causes the compiler to emit "redefinition" errors and the shader
will not run.

```glsl
// These are provided. Reference them directly. Never write
// `uniform float iTime;` etc. yourself.
iTime         // float, seconds since start, monotonic
iTimeDelta    // float, seconds since last frame
iFrame        // int, frame counter
iResolution   // vec3, canvas width, height, 1.0
iMouse        // vec4, x, y, click_x, click_y in pixels
iChannel0     // sampler2D, audio FFT, 256x1 R8 texture
iChannel1     // sampler2D, image input, RGBA texture
```

You MAY declare additional uniforms that your shader needs (for
example `uniform float iAtlasSize;`). Anything outside the list
above is fair game; anything inside the list above must not appear
in your shader as a `uniform` declaration.

### Common GLSL gotchas — do not make these

- Never reference a variable on the right-hand side of its own
  initializer. `vec2 u = f * f * (3.0 - 2.0 * u);` does not work —
  `u` is not yet defined. Write `vec2 u = f * f * (3.0 - 2.0 * f);`.
- Prefer GLSL built-ins over hand-written polynomial replacements.
  `smoothstep(0.0, 1.0, f)` is the canonical Hermite curve.
  `mix(a, b, t)` is linear interpolation. `fract`, `clamp`, `step`,
  `length`, `dot`, `cross`, and `normalize` are all built in.
- All integer literals used in float contexts must include a
  decimal. Write `1.0`, not `1`.
- Branch only on uniforms, not on per-pixel quantities, when
  possible. Branches on per-pixel data force divergence.

### Reading audio from iChannel0

The texture is 256x1. The x coordinate from 0 to 1 sweeps from low
to high frequency. Y is always 0.

```glsl
float bass(sampler2D ch) { return texture(ch, vec2(0.05, 0.0)).r; }
float mid(sampler2D ch)  { return texture(ch, vec2(0.40, 0.0)).r; }
float treble(sampler2D ch) { return texture(ch, vec2(0.80, 0.0)).r; }
float energy(sampler2D ch) {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    s += texture(ch, vec2(float(i) / 8.0, 0.0)).r;
  }
  return s / 8.0;
}
```

When no audio is connected, the values are still meaningful because
Prism's built-in synthetic signal drives iChannel0.

### Reading images from iChannel1

The texture wraps repeat by default. Aspect ratio is whatever the
source provides. Sample with regular uv coordinates.

```glsl
vec4 photo = texture(iChannel1, uv);
```

When the source is empty or unbound, the texture is a 1x1 dim gray
placeholder. Code defensively. Do not assume a non-zero color.

### Image atlas convention for particle systems

For Refik-style fluid shaders that use a tile atlas, the image
atlas is laid out as an N by N grid in iChannel1. The Prism
harness will assemble this from N individual images when the
calling pipeline uses Nano Banana to generate them. Calling code
provides an additional uniform to indicate atlas size.

```glsl
uniform float iAtlasSize; // 4.0 means 4x4 grid of 16 tiles
```

To sample tile k from the atlas.

```glsl
vec4 sampleAtlasTile(float k, vec2 uv) {
  float n = iAtlasSize;
  float col = floor(mod(k, n));
  float row = floor(k / n);
  vec2 tileUV = (vec2(col, row) + uv) / n;
  return texture(iChannel1, tileUV);
}
```

## Required quality bar

The output must.

- Compile cleanly in WebGL2 GLSL 300 es with no warnings
- Render at 30 fps or better on a desktop GPU at 1280x720
- Use deterministic pseudo-random functions, not built-in noise
- Use `float` precision consistently. No `double`. No int math where
  float is more appropriate.
- Loop bounds are constant or have a small upper bound. No
  `while (true)`.
- All `texture()` calls use sampler2D types correctly
- Output a non-transparent vec4 unless explicit alpha blending is part
  of the design

## Style preferences

- Use snake case for local variables. Use camelCase for functions.
- Inline iq-style helper functions when they keep the code readable
- Comments should explain why, not what. The math is self-documenting.
- Use `vec3 col = ...; fragColor = vec4(col, 1.0);` pattern at the end
- Common helper patterns to include if useful.

```glsl
float hash(vec2 p) {
  p = fract(p * vec2(123.45, 678.91));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * (hash(floor(p)) * 2.0 - 1.0);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}
```

## Patterns for common categories

### Raymarched signed distance field

Standard iq raymarcher. Camera ray casts into the scene, march along
the ray testing the distance function until close enough to a
surface.

```glsl
float sdScene(vec3 p) {
  // your distance function
  return length(p) - 1.0;
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    sdScene(p + e.xyy) - sdScene(p - e.xyy),
    sdScene(p + e.yxy) - sdScene(p - e.yxy),
    sdScene(p + e.yyx) - sdScene(p - e.yyx)
  ));
}
```

### Image displacement

Sample iChannel1 with offset uvs derived from noise or audio.

```glsl
vec2 disp = vec2(fbm(uv * 3.0 + iTime), fbm(uv * 3.0 - iTime)) * 0.05;
vec4 photo = texture(iChannel1, uv + disp);
```

### Particle system in fragment shader

Each pixel evaluates contribution from N particles. Pseudo-random
particle positions seeded by index, animated by iTime and audio.

```glsl
vec3 accumulate(vec2 uv, sampler2D atlas) {
  vec3 col = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    float fi = float(i);
    vec2 pos = vec2(hash(vec2(fi, 0.0)), hash(vec2(fi, 1.0)));
    pos += 0.1 * vec2(cos(iTime + fi), sin(iTime + fi * 0.7));
    float d = length(uv - pos);
    if (d < 0.05) {
      vec2 tileUV = (uv - pos + 0.05) / 0.1;
      col += sampleAtlasTile(fi, tileUV).rgb;
    }
  }
  return col;
}
```

### Fluid simulation in fragment shader

True Navier-Stokes is a multi-pass compute problem and not feasible
in a single Prism fragment shader. The Refik-style "fluid of flora"
effect is best approximated by.

1. Generate a flow field with curl noise. The field is vec2 velocity
   per pixel, smooth and divergence-free.
2. For each pixel, integrate backward along the flow field for a
   small number of steps to find the source position.
3. At the source position, look up which tile from the atlas should
   appear there and at what rotation.

This gives the visual impression of fluid carrying images without
needing a true simulation.

```glsl
vec2 curlNoise(vec2 p) {
  float e = 0.01;
  float n1 = fbm(p + vec2(e, 0.0));
  float n2 = fbm(p - vec2(e, 0.0));
  float n3 = fbm(p + vec2(0.0, e));
  float n4 = fbm(p - vec2(0.0, e));
  return vec2(n4 - n3, n1 - n2) / (2.0 * e);
}
```

## Output format

When asked to write a shader, return only the shader source code in a
single fenced glsl code block. No prose explanation unless the user
asks. The code starts with helper functions and uniforms, then
mainImage.

If the shader uses iAtlasSize or any non-standard uniform, declare it
explicitly at the top.

## Iteration protocol

When you receive a previous shader plus a critique or compile error,
revise. State the change in one sentence above the code block.
Return the full revised shader, not a diff.

When you receive a compile error like "ERROR: 0:23: 'fragColor' :
undeclared identifier," the line number refers to the wrapped shader
not your source. Look for the most likely source-level mistake and
fix it.

## What this skill is NOT

- Not for writing fragment shaders for Three.js or React Three Fiber.
  Those have different uniform conventions.
- Not for writing vertex shaders. Prism uses a fixed fullscreen
  triangle vertex shader.
- Not for writing WGSL. Prism is WebGL2 only.
- Not for writing Milkdrop preset files. Those have a different
  structure entirely.
