struct Emitter {
  x: f32,
  y: f32,
  sigma: f32,
  intensity: f32,
  color: vec4f,
  flow: vec4f, // source, vortex, _, _
}

struct Uniforms {
  dt: f32,
  time: f32,
  bass: f32,
  mid: f32,
  treble: f32,
  beat: f32,
  flow_strength: f32,
  flow_scale: f32,
  decay: f32,
  diffusion: f32,
  inject_gain: f32,
  emitter_count: u32,
  gravity: f32,
  audio_time: f32,
  mass: f32,
  waves: f32,
  paint: f32,
  stamp_count: u32,
  _pad1: f32,
  _pad2: f32,
}

struct Stamp {
  // x, y, scale, opacity
  pos_scale: vec4f,
  // image_idx (u32 reinterpreted as f32), rotation, _, _
  extra: vec4f,
}

@group(0) @binding(0) var prev_field: texture_2d<f32>;
@group(0) @binding(1) var next_field: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> emitters: array<Emitter>;
@group(0) @binding(3) var<uniform> u: Uniforms;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var palette_tex: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> stamps: array<Stamp>;

fn potential(p: vec2f, t: f32) -> f32 {
  let huge  = sin(p.x * 0.7 + t * 0.06) * cos(p.y * 0.55 - t * 0.07) * 1.5;
  let big   = sin(p.x * 1.5 + t * 0.16) * cos(p.y * 1.3  - t * 0.13) * 0.95;
  let med   = sin(p.x * 3.5 - t * 0.35) * cos(p.y * 4.0  + t * 0.28) * 0.55;
  let small = sin(p.x * 8.0 + t * 0.55) * cos(p.y * 7.0  - t * 0.45) * 0.30;
  return huge + big + med + small;
}

fn curl(p: vec2f, t: f32) -> vec2f {
  let eps = 0.01;
  let dpdy = potential(p + vec2f(0.0, eps), t) - potential(p - vec2f(0.0, eps), t);
  let dpdx = potential(p + vec2f(eps, 0.0), t) - potential(p - vec2f(eps, 0.0), t);
  return vec2f(dpdy, -dpdx) / (2.0 * eps);
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(prev_field);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / vec2f(dims);

  // === SEMI-LAGRANGIAN ADVECTION (per channel) ===
  // Curl-noise flow + constant downward gravity. UV y=0 is top, y=1 is bottom.
  // Vortex centers evolve at (slow real time + audio-driven offset) so they dance with music.
  let curl_t = u.time + u.audio_time;
  let base_vel = curl((uv - 0.5) * u.flow_scale, curl_t) * u.flow_strength
            + vec2f(0.0, u.gravity);
  var vel = base_vel;
  // We'll also need the previous wave velocity (alpha channel).
  let prev_sample = textureSampleLevel(prev_field, samp, vec2f(uv.x, fract(uv.y + 1.0)), 0.0);
  let src_uv = uv - vel * u.dt;
  // Wrap Y so material that flows off the bottom re-enters at the top.
  let src_uv_wrapped = vec2f(src_uv.x, fract(src_uv.y + 1.0));
  var rgb = textureSampleLevel(prev_field, samp, src_uv_wrapped, 0.0).rgb;

  // === DIFFUSION (4-neighbor average, per channel) ===
  let texel = 1.0 / vec2f(dims);
  let nL = textureSampleLevel(prev_field, samp, uv + vec2f(-texel.x, 0.0), 0.0).rgb;
  let nR = textureSampleLevel(prev_field, samp, uv + vec2f( texel.x, 0.0), 0.0).rgb;
  let nU = textureSampleLevel(prev_field, samp, uv + vec2f(0.0, -texel.y), 0.0).rgb;
  let nD = textureSampleLevel(prev_field, samp, uv + vec2f(0.0,  texel.y), 0.0).rgb;
  let neighbor_avg = (nL + nR + nU + nD) * 0.25;
  let diff_amt = clamp(u.diffusion * u.dt, 0.0, 1.0);
  rgb = mix(rgb, neighbor_avg, diff_amt);

  // === MASS / ANTI-DIFFUSION ===
  // Push each pixel away from its neighbor-average. Steepens gradients so peaks
  // pile up as crests and don't smooth out — gives waves apparent mass.
  let mass_amt = clamp(u.mass * u.dt, 0.0, 0.85);
  rgb = rgb + (rgb - neighbor_avg) * mass_amt;
  rgb = max(rgb, vec3f(0.0));

  // === COLOR-COMPETITION INJECTION + PER-EMITTER FLOW PERTURBATION ===
  // Each pixel's injected color is a strength-weighted average of contributing
  // emitters (winner-takes-most rather than additive sum). Intensity sums normally.
  // This prevents many overlapping emitters from blending their colors to grey/white.
  var color_accum = vec3f(0.0);
  var weight_accum = 0.0;
  var intensity_accum = 0.0;
  var flow_perturb = vec2f(0.0);
  for (var i: u32 = 0u; i < u.emitter_count; i = i + 1u) {
    let e = emitters[i];
    let d = uv - vec2f(e.x, e.y);
    let r2 = dot(d, d);
    let s2 = max(e.sigma * e.sigma, 0.00001);
    let g = e.intensity * exp(-r2 / (2.0 * s2));
    // Cubed weight makes the strongest emitter clearly own the pixel.
    let w = g * g * g;
    color_accum = color_accum + e.color.rgb * w;
    weight_accum = weight_accum + w;
    intensity_accum = intensity_accum + g;

    let dist = sqrt(r2);
    if (dist > 0.001) {
      let dir = d / dist;
      let perp = vec2f(-d.y, d.x) / dist;
      let falloff = exp(-dist * 4.5);
      flow_perturb = flow_perturb + (dir * e.flow.x + perp * e.flow.y) * falloff;
    }
  }
  let injected_color = color_accum / max(weight_accum, 0.000001);
  rgb = rgb + injected_color * intensity_accum * u.inject_gain * u.dt;

  // === FLOATING IMAGE STAMPS ===
  // Each stamp is a soft-edged disc of NASA image content at a moving position.
  // CPU updates positions / lifetimes; GPU loops over active stamps per pixel
  // and accumulates image samples. The flow advection then carries the
  // injected color around like image-shaped paint blobs.
  if (u.paint > 0.001) {
    var stamp_inject = vec3f(0.0);
    for (var si: u32 = 0u; si < u.stamp_count; si = si + 1u) {
      let s = stamps[si];
      let center = s.pos_scale.xy;
      let scale = s.pos_scale.z;
      let opacity = s.pos_scale.w;
      let img_idx = s.extra.x;
      let rot = s.extra.y;

      let d = uv - center;
      let r = length(d);
      if (r < scale) {
        // Rotated local coords within [-1,1] disk.
        let cs = cos(rot);
        let sn = sin(rot);
        let local = vec2f(cs * d.x - sn * d.y, sn * d.x + cs * d.y) / scale;
        // Map to slot UV in the strip atlas: x picks horizontal pos in chosen slot.
        let slot_u = (img_idx + (local.x * 0.5 + 0.5)) / 4.0;
        let slot_v = local.y * 0.5 + 0.5;
        let sample = textureSampleLevel(palette_tex, samp, vec2f(slot_u, slot_v), 0.0).rgb;
        let fade = smoothstep(scale, scale * 0.55, r) * opacity;
        stamp_inject = stamp_inject + sample * fade;
      }
    }
    rgb = rgb + stamp_inject * u.dt * u.paint * 6.0;
  }

  // Apply per-emitter flow perturbations to the velocity used for advection
  // (re-run the advection sample with the perturbed velocity).
  vel = base_vel + flow_perturb * 0.35;
  let src_uv2 = uv - vel * u.dt;
  let src_uv2_wrapped = vec2f(src_uv2.x, fract(src_uv2.y + 1.0));
  let perturbed = textureSampleLevel(prev_field, samp, src_uv2_wrapped, 0.0).rgb;
  rgb = mix(rgb, perturbed, 0.4);

  // === WAVE PROPAGATION ===
  // The alpha channel stores ∂h/∂t (vertical velocity of the surface).
  // Each frame we apply the discrete wave equation: v += c² ∇²h dt, then h += v dt.
  // Height is approximated as the luminance of the field; we apply v to scale
  // the field's luminance proportionally so hue is preserved. This produces
  // propagating waves that constructively interfere — adjacent crests stack
  // and crash against each other when they meet.
  var wave_v = prev_sample.a;
  if (u.waves > 0.001) {
    let lum_c = (rgb.r + rgb.g + rgb.b) * 0.3333;
    let lum_n = (
      (nL.r + nL.g + nL.b) +
      (nR.r + nR.g + nR.b) +
      (nU.r + nU.g + nU.b) +
      (nD.r + nD.g + nD.b)
    ) * 0.0833; // /12
    let lap_lum = lum_n - lum_c;
    let damping = exp(-u.waves * 0.35 * u.dt);
    wave_v = (wave_v + u.waves * u.waves * lap_lum * u.dt) * damping;

    // Apply wave velocity to luminance (proportional, hue-preserving).
    let target_lum = max(0.001, lum_c + wave_v * u.dt * 3.0);
    let scale = clamp(target_lum / max(lum_c, 0.001), 0.25, 2.6);
    rgb = rgb * scale;
  } else {
    wave_v = 0.0;
  }

  // === DECAY ===
  // Bass relaxes decay so streaks persist during music.
  let effective_decay = u.decay * (1.0 - u.bass * 0.5);
  rgb = max(vec3f(0.0), rgb * exp(-effective_decay * u.dt));

  // Soft per-channel clamp before tonemap in render.
  rgb = clamp(rgb, vec3f(0.0), vec3f(4.0));

  textureStore(next_field, vec2i(gid.xy), vec4f(rgb, wave_v));
}
