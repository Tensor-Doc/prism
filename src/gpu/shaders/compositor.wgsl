struct Uniforms {
  audio: vec4f, // bass, mid, treble, beat
  t: f32,
  chaos: f32,
  has_milkdrop: f32,
  _pad: f32,
}

@group(0) @binding(0) var fluid_tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var milkdrop_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: Uniforms;

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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let fluid = textureSample(fluid_tex, samp, in.uv).rgb;
  let milk  = textureSample(milkdrop_tex, samp, in.uv).rgb;

  // Screen blend keeps both engines visible without crushing each other.
  // Mix amount = chaos slider (0 = pure fluid, 1 = pure milkdrop screen-blended).
  let amt = u.chaos * u.has_milkdrop;
  let screen_blend = vec3f(1.0) - (vec3f(1.0) - fluid) * (vec3f(1.0) - milk * amt);

  return vec4f(screen_blend, 1.0);
}
