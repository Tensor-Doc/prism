// transitions.ts — a small library of image transition shaders inspired by
// gl-transitions.com. Each transition takes a `from` texture (the held image)
// and animates `progress` from 0 → 1. The "to" side is rendered as transparent
// so the milkdrop underneath shows through where the shader yields alpha < 1.
//
// All shaders share the same uniforms (fromTex, progress, resolution) so the
// renderer can switch between them with no per-shader plumbing.

export interface TransitionDef {
  /** Human-readable name shown in telemetry. */
  name: string;
  /** Animation duration. Different shaders look best at different tempos. */
  durationMs: number;
  /** GLSL ES 3.0 fragment shader. Must define `vec4 transition(vec2 uv)`. */
  fragmentShader: string;
}

const HEADER = `#version 300 es
precision highp float;
uniform sampler2D fromTex;
uniform sampler2D toTex;
uniform float progress;
uniform vec2 resolution;
in vec2 vUv;
out vec4 fragColor;

vec4 getFromColor(vec2 uv) { return texture(fromTex, uv); }
vec4 getToColor(vec2 uv)   { return texture(toTex,   uv); }
`;

const FOOTER = `
void main() {
  fragColor = transition(vUv);
}
`;

const wrap = (body: string): string => HEADER + body + FOOTER;

/** No-op shader used during the HOLD phase — pure pass-through of fromTex. */
export const PASS_THROUGH: TransitionDef = {
  name: "passthrough",
  durationMs: 0,
  fragmentShader: wrap(`
    vec4 transition(vec2 uv) { return getFromColor(uv); }
  `),
};

/** Simple alpha crossfade. */
const FADE: TransitionDef = {
  name: "fade",
  durationMs: 1100,
  fragmentShader: wrap(`
    vec4 transition(vec2 uv) {
      return mix(getFromColor(uv), getToColor(uv), progress);
    }
  `),
};

/** Doom-style vertical column drop, randomised per column. */
const DOOM_DROP: TransitionDef = {
  name: "doom drop",
  durationMs: 1400,
  fragmentShader: wrap(`
    float rand(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
    vec4 transition(vec2 uv) {
      float col = floor(uv.x * 60.0);
      float r = rand(col);
      float ct = clamp((progress - r * 0.3) / max(0.001, 1.0 - r * 0.3), 0.0, 1.0);
      float drop = ct * ct * 1.6;
      if (uv.y < drop) return getToColor(uv);
      vec2 src = vec2(uv.x, uv.y - drop);
      if (src.y > 1.0) return getToColor(uv);
      return getFromColor(src);
    }
  `),
};

/** Wind blowing left → right with per-row noise edge. */
const WIND: TransitionDef = {
  name: "wind",
  durationMs: 1200,
  fragmentShader: wrap(`
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    vec4 transition(vec2 uv) {
      float size = 0.22;
      float r = rand(vec2(0.0, floor(uv.y * 240.0)));
      float m = smoothstep(0.0, -size, uv.x * (1.0 - size) + size * r - progress * (1.0 + size));
      return mix(getFromColor(uv), getToColor(uv), m);
    }
  `),
};

/** Diagonal wipe from top-right toward bottom-left with soft edge. */
const DIRECTIONAL_WIPE: TransitionDef = {
  name: "wipe",
  durationMs: 1000,
  fragmentShader: wrap(`
    vec4 transition(vec2 uv) {
      vec2 dir = vec2(1.0, -1.0);
      vec2 v = normalize(dir);
      v /= abs(v.x) + abs(v.y);
      float d = v.x * 0.5 + v.y * 0.5;
      float smoothness = 0.5;
      float arg = v.x * uv.x + v.y * uv.y - (d - 0.5 + progress * (1.0 + smoothness));
      float m = smoothstep(-smoothness, 0.0, arg);
      return mix(getFromColor(uv), getToColor(uv), 1.0 - m);
    }
  `),
};

/** Pixelate up then dissolve random tiles. */
const MOSAIC: TransitionDef = {
  name: "mosaic",
  durationMs: 1400,
  fragmentShader: wrap(`
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    vec4 transition(vec2 uv) {
      float ps = mix(120.0, 14.0, progress);
      vec2 pix = floor(uv * ps) / ps;
      float r = rand(pix);
      float keep = step(progress, r); // 1 if tile still visible
      vec4 from = getFromColor(pix);
      return mix(getToColor(uv), from, keep);
    }
  `),
};

/** Zoom outward — `from` scales out radially, `to` is revealed underneath. */
const DREAMY_ZOOM: TransitionDef = {
  name: "dreamy zoom",
  durationMs: 1300,
  fragmentShader: wrap(`
    vec4 transition(vec2 uv) {
      vec2 c = uv - 0.5;
      float scale = 1.0 - progress * 0.45;
      vec2 src = c * scale + 0.5;
      vec4 fromCol = getFromColor(src);
      vec4 toCol = getToColor(uv);
      float r = length(c) * 2.0;
      float fade = smoothstep(0.0, 1.2, 1.0 - progress * (1.0 + r * 0.6));
      return mix(toCol, fromCol, fade);
    }
  `),
};

/** Burn-style edge-flame from bottom up. Past the burning edge, the next
 *  image is revealed; at the edge itself, hot fire colours mix with `from`. */
const BURN: TransitionDef = {
  name: "burn",
  durationMs: 1400,
  fragmentShader: wrap(`
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    vec4 transition(vec2 uv) {
      float n = rand(vec2(uv.x * 14.0, 0.0));
      float edge = (1.0 - uv.y) * (1.0 + 0.25 * n);
      float t = progress * 1.3;
      if (edge > t) return getFromColor(uv);
      float burn = clamp((edge - t + 0.22) / 0.22, 0.0, 1.0);
      vec4 fromCol = getFromColor(uv);
      vec4 toCol = getToColor(uv);
      vec3 fire = mix(vec3(0.95, 0.45, 0.10), vec3(1.0, 0.85, 0.20), burn);
      vec4 burning = vec4(fire, 1.0) + fromCol * 0.35;
      return mix(toCol, burning, burn);
    }
  `),
};

/** Public list, in the order they rotate through. */
export const TRANSITIONS: TransitionDef[] = [
  FADE,
  DOOM_DROP,
  WIND,
  DIRECTIONAL_WIPE,
  MOSAIC,
  DREAMY_ZOOM,
  BURN,
];
