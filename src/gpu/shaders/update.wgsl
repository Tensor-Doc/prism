struct Particle {
  pos: vec2f,
  vel: vec2f,
  color: vec3f,
  age: f32,
}

struct Emitter {
  x: f32,
  y: f32,
  sigma: f32,
  spawn_count: u32,
  color: vec4f,
}

struct Uniforms {
  dt: f32,
  time: f32,
  flow_strength: f32,
  flow_scale: f32,
  bass: f32,
  mid: f32,
  treble: f32,
  rms: f32,
  particle_count: u32,
  emitter_count: u32,
  spawn_offset: u32,
  total_spawn_count: u32,
  damping: f32,
  max_age: f32,
  beat: f32,
  _pad: f32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read> emitters: array<Emitter>;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

fn potential(p: vec2f, t: f32) -> f32 {
  let big = sin(p.x * 1.2 + t * 0.10) * cos(p.y * 1.0 - t * 0.13);
  let med = sin(p.x * 3.0 - t * 0.25) * cos(p.y * 3.5 + t * 0.20) * 0.55;
  let small = sin(p.x * 7.0 + t * 0.40) * cos(p.y * 6.5 - t * 0.35) * 0.30;
  return big + med + small;
}

fn curl(p: vec2f, t: f32) -> vec2f {
  let eps = 0.01;
  let dpdy = potential(p + vec2f(0.0, eps), t) - potential(p - vec2f(0.0, eps), t);
  let dpdx = potential(p + vec2f(eps, 0.0), t) - potential(p - vec2f(eps, 0.0), t);
  return vec2f(dpdy, -dpdx) / (2.0 * eps);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= u.particle_count) { return; }

  var p = particles[idx];

  // === RESPAWN ===
  let dist_from_start = (idx + u.particle_count - u.spawn_offset) % u.particle_count;
  let is_respawning = dist_from_start < u.total_spawn_count;

  if (is_respawning) {
    var cum: u32 = 0u;
    for (var ei: u32 = 0u; ei < u.emitter_count; ei = ei + 1u) {
      let e = emitters[ei];
      if (dist_from_start < cum + e.spawn_count) {
        let r1 = hash21(vec2f(f32(idx), u.time * 0.13 + 1.7));
        let r2 = hash21(vec2f(f32(idx), u.time * 0.13 + 2.3));
        let angle = r1 * 6.28318530718;
        let radius = sqrt(r2) * e.sigma;
        p.pos = vec2f(e.x + cos(angle) * radius, e.y + sin(angle) * radius);
        // Spawn at rest. Forces below add motion only when music demands it.
        p.vel = vec2f(0.0, 0.0);
        p.color = e.color.rgb;
        p.age = u.max_age * (0.55 + r2 * 0.45);
        break;
      }
      cum = cum + e.spawn_count;
    }
  }

  if (p.age <= 0.0) {
    particles[idx] = p;
    return;
  }

  // === FORCES ===
  let from_center = p.pos - vec2f(0.5, 0.5);
  let dc = length(from_center);
  let safe_dir = select(vec2f(0.0, -1.0), from_center / max(dc, 0.0001), dc > 0.0001);

  // sqrt emphasizes quiet signals so 0.2 bass feels meaningful.
  let bass_em = sqrt(u.bass);
  let beat_em = sqrt(u.beat);

  // 1. BEAT IMPULSE — brief radial nudge. Small enough that surfaces don't disintegrate.
  let beat_kick = beat_em * beat_em * 0.55 * exp(-dc * 1.4);
  p.vel = p.vel + safe_dir * beat_kick;

  // 2. BASS BREATHING — outward push only, no inward pull.
  let breath = max(0.0, bass_em - 0.25) * 0.6 * exp(-dc * 0.9);
  p.vel = p.vel + safe_dir * breath;

  // 3. AMBIENT CURL FLOW — only active when there's music to react to.
  let flow_gate = clamp(u.bass + u.mid * 0.5, 0.0, 1.0);
  let curl_force = curl((p.pos - 0.5) * u.flow_scale, u.time);
  p.vel = p.vel + curl_force * u.flow_strength * flow_gate;

  // 4. TREBLE JITTER — random per-particle wiggle on bright transients.
  let jit_x = hash21(vec2f(f32(idx) * 0.5, u.time * 8.0)) - 0.5;
  let jit_y = hash21(vec2f(f32(idx) * 0.5, u.time * 8.0 + 13.7)) - 0.5;
  p.vel = p.vel + vec2f(jit_x, jit_y) * u.treble * 0.5 * u.dt;

  // === DAMPING ===
  // Stays strong — surfaces, not trails. Only a small release on big peaks.
  let energy = u.beat * 0.4 + bass_em * 0.2;
  let effective_damping = u.damping * (1.0 - clamp(energy * 0.25, 0.0, 0.35));
  let damp = exp(-effective_damping * u.dt);
  p.vel = p.vel * damp;

  // === INTEGRATE ===
  p.pos = p.pos + p.vel * u.dt;

  if (p.pos.x < -0.2 || p.pos.x > 1.2 || p.pos.y < -0.2 || p.pos.y > 1.2) {
    p.age = 0.0;
  } else {
    p.age = p.age - u.dt;
  }

  particles[idx] = p;
}
