struct Uniforms {
  bass: f32,
  beat: f32,
  treble: f32,
  rms: f32,
  slope_gain: f32,
  saturation: f32,
  chroma: f32,
  hue: f32,
  light_x: f32,
  light_y: f32,
  light_z: f32,
  _pad: f32,
}

@group(0) @binding(0) var field: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0), vec2f( 1.0,  1.0), vec2f(-1.0,  1.0),
  );
  let uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(1.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
  );
  var out: VertexOutput;
  out.clip_pos = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// Push each pixel away from its luminance to keep hues vibrant.
// amount > 1 boosts saturation, amount < 1 desaturates toward grey.
fn boost_saturation(c: vec3f, amount: f32) -> vec3f {
  let l = luminance(c);
  return clamp(vec3f(l) + (c - vec3f(l)) * amount, vec3f(0.0), vec3f(1.0));
}

// Push the smallest channel toward zero — gives "pure hue" feel.
// amount = 0: identity. amount = 1: full purification (pure RGB hue).
fn purify(c: vec3f, amount: f32) -> vec3f {
  let mx = max(max(c.r, c.g), c.b);
  if (mx < 0.001) { return c; }
  let normalized = c / mx;
  let mn = min(min(normalized.r, normalized.g), normalized.b);
  let denom = max(1.0 - mn, 0.001);
  let pure = (normalized - vec3f(mn)) / denom;
  return mix(c, pure * mx, amount);
}

// Rotate hue in RGB space using the diagonal rotation matrix.
// h_norm = 0: identity. h_norm = 1: full 360°.
fn rotate_hue(c: vec3f, h_norm: f32) -> vec3f {
  let a = h_norm * 6.28318530718;
  let cosA = cos(a);
  let sinA = sin(a);
  let third = 0.33333333;
  let sq3 = 0.57735027; // sqrt(3) / 3
  let m1 = cosA + (1.0 - cosA) * third;
  let m2 = third * (1.0 - cosA);
  let n = sq3 * sinA;
  let row0 = vec3f(m1,     m2 - n, m2 + n);
  let row1 = vec3f(m2 + n, m1,     m2 - n);
  let row2 = vec3f(m2 - n, m2 + n, m1);
  return vec3f(dot(row0, c), dot(row1, c), dot(row2, c));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let dims = textureDimensions(field);
  let texel = 1.0 / vec2f(dims);

  let cc = textureSample(field, samp, in.uv).rgb;
  let cl = textureSample(field, samp, in.uv + vec2f(-texel.x, 0.0)).rgb;
  let cr = textureSample(field, samp, in.uv + vec2f( texel.x, 0.0)).rgb;
  let cu = textureSample(field, samp, in.uv + vec2f(0.0, -texel.y)).rgb;
  let cd = textureSample(field, samp, in.uv + vec2f(0.0,  texel.y)).rgb;

  // Normal from luminance gradient (relief comes from intensity, color is preserved).
  let dhdx = (luminance(cr) - luminance(cl)) * u.slope_gain;
  let dhdy = (luminance(cd) - luminance(cu)) * u.slope_gain;
  let normal = normalize(vec3f(-dhdx, -dhdy, 1.0));

  let light = normalize(vec3f(u.light_x, u.light_y, u.light_z));
  let diffuse = max(0.0, dot(normal, light));
  let rim = pow(max(0.0, 1.0 - dot(normal, vec3f(0.0, 0.0, 1.0))), 2.0);

  // Specular: Phong half-vector — gives the wet/shiny crest highlight
  // that's missing from pure diffuse. View direction is straight down (camera above).
  let view = vec3f(0.0, 0.0, 1.0);
  let half_v = normalize(light + view);
  let spec_dot = max(0.0, dot(normal, half_v));
  let specular = pow(spec_dot, 28.0) * 0.85;
  let spec_color = vec3f(1.0, 0.92, 0.78); // warm white highlight

  // === AMBIENT OCCLUSION ===
  // Concavity from luminance Laplacian — valleys darken, peaks stay bright.
  let lap = (luminance(cl) + luminance(cr) + luminance(cu) + luminance(cd))
            - 4.0 * luminance(cc);
  let ao = clamp(1.0 - max(0.0, lap) * 3.0, 0.45, 1.0);

  // === GRANULAR DITHER ===
  // Stable per-pixel noise pattern gives the "made of particles" texture.
  let p = floor(in.uv * vec2f(900.0));
  let g1 = fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
  let g2 = fract(sin(dot(p + 17.3, vec2f(78.233, 12.9898))) * 43758.5453);
  let granular = mix(0.85, 1.15, (g1 + g2) * 0.5);

  // Per-channel Reinhard tonemap. No beat-driven brightness here — beats
  // shape the *motion* and *relief* via flow_strength and slope_gain on the
  // CPU side, not by lighting the whole screen up.
  let mapped = cc / (1.0 + cc);

  // Pull saturation back up — combats RGB-add converging to grey.
  let vivid = boost_saturation(mapped, u.saturation);
  // Push toward pure hue (zero the smallest channel).
  let pure = purify(vivid, u.chroma);
  // Optional palette rotation.
  let rotated = rotate_hue(pure, u.hue);

  // Composite the inner material lighting.
  let key   = rotated * (0.24 + 0.58 * diffuse) * ao;
  let spec  = spec_color * specular * ao;
  let glow  = rim * rotated * 0.22;
  let inner = (key + spec + glow) * granular;

  // Box removed — fluid renders edge to edge.
  let safe = clamp(inner, vec3f(0.0), vec3f(1.0));
  return vec4f(safe, 1.0);
}
