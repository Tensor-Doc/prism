struct Particle {
  pos: vec2f,
  vel: vec2f,
  color: vec3f,
  age: f32,
}

struct RenderUniforms {
  viewport: vec2f,
  particle_size: f32,
  max_age: f32,
  bass: f32,
  beat: f32,
  treble: f32,
  _pad: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> u: RenderUniforms;

struct VertexOutput {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0), vec2f( 1.0,  1.0), vec2f(-1.0,  1.0),
  );
  let corner = corners[vi];
  let p = particles[ii];

  var out: VertexOutput;

  if (p.age <= 0.0) {
    out.clip_pos = vec4f(2.0, 2.0, 0.0, 1.0);
    out.uv = vec2f(0.0, 0.0);
    out.color = vec4f(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let life = clamp(p.age / u.max_age, 0.0, 1.0);
  let age_norm = 1.0 - life;
  let fade_in = smoothstep(0.0, 0.04, age_norm);
  let fade_out = smoothstep(0.75, 1.0, age_norm);
  let alpha = fade_in * (1.0 - fade_out);

  // Particle grows with audio energy — bass swells size, beat punches hard.
  // Sqrt to emphasize quieter signals.
  let bass_em = sqrt(u.bass);
  let beat_em = sqrt(u.beat);
  let size_mod = 1.0 + bass_em * 1.2 + beat_em * 1.5;
  let size_ndc = (u.particle_size * size_mod) / u.viewport * 2.0;
  let center_clip = vec2f(p.pos.x * 2.0 - 1.0, 1.0 - p.pos.y * 2.0);
  let pos_clip = center_clip + corner * size_ndc;

  out.clip_pos = vec4f(pos_clip, 0.0, 1.0);
  out.uv = corner;
  out.color = vec4f(p.color, alpha);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.0) {
    discard;
  }
  let falloff = exp(-d * d * 2.5);
  // Bass adds steady glow; beat punches brightness on every hit.
  let beat_boost = 1.0 + sqrt(u.beat) * 1.4 + sqrt(u.bass) * 0.5;
  let a = falloff * in.color.a;
  let rgb = in.color.rgb * beat_boost;
  return vec4f(rgb * a, a);
}
