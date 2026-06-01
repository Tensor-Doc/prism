// particles.ts — render a fluid of N textured 3D particles to a canvas.
// Each particle is a billboarded sprite that samples one tile from an
// image atlas, drifting through a 3D curl-noise flow field, with a
// slow camera orbit. Same role as backends/milkdrop.ts and
// backends/shadertoy.ts: takes audio in, paints a live visual.
//
// Architecture
// ─────────────
// Two state textures (RGBA32F) per ping-pong slot:
//   posTex: rgb = world position (x, y, z), a = life (0..1)
//   velTex: rgb = velocity (x, y, z), a = unused
// Each frame:
//   1) Update velocity into writeVel via curl noise + audio
//   2) Update position into writePos by integrating writeVel
//      (uses MRT so both writes happen in one pass)
//   3) Swap pointers
//   4) Render N instanced quads, each billboarded toward the camera
//      and stretched along its velocity vector.

const PARTICLE_GRID = 256;                  // 65,536 particles
const STATE_SIZE = PARTICLE_GRID;
const PARTICLE_COUNT = STATE_SIZE * STATE_SIZE;

// Spatial-hash flocking grid. We voxelize the simulation volume into
// FLOCK_GRID³ cells. Cells are stored in a flat 2D texture by
// stacking z-slices in an FLOCK_GRID_TILES × FLOCK_GRID_TILES grid.
// WebGL2 can't render directly into a 3D texture without gl_Layer
// (not in the WebGL2 spec) so this flat layout is the standard
// workaround. Niagara uses the same approach internally.
//
// 32³ = 32k cells. For 65k particles that averages 2 particles per
// cell when fully populated, which is enough for emergent flocking
// without over-binning. Texture is 32*6 = 192 in each axis (we use
// 6x6 = 36 tiles to cover 32 slices = 4 wasted; cheap headroom).
const FLOCK_GRID = 32;
const FLOCK_GRID_TILES = 6;
const FLOCK_TEX_SIZE = FLOCK_GRID * FLOCK_GRID_TILES;  // 192

// ── shader source ──────────────────────────────────────────────────

const VS_FULLSCREEN = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// Update pass writes both new position and new velocity via MRT.
const FS_UPDATE = `#version 300 es
precision highp float;

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uAudio;
uniform vec2 uStateSize;
uniform float uTime;
uniform float uDt;
uniform float uCurlScale;
uniform float uVelocityDamp;
uniform float uAudioGain;
uniform float uVolumeRadius;
uniform vec3 uVolumeSize;   // x, y, z half-extents of the slab
uniform float uWaveAmp;     // wave attractor amplitude
uniform float uFlowDriftX;  // dominant horizontal current
uniform float uCoronaBoost; // multiplier on bass-driven vertical curl

// Flocking inputs. uGrid0 holds (position_sum, count) per cell, uGrid1
// holds (velocity_sum, _). All three Reynolds weights at 0 disables
// the entire flocking term — the lookups still happen but contribute
// nothing, so existing presets behave identically.
uniform sampler2D uGrid0;
uniform sampler2D uGrid1;
uniform vec3 uVolumeMin;
uniform vec3 uVolumeMax;
uniform float uGridSize;
uniform float uGridTiles;
uniform float uTexSize;
uniform float uFlockSeparation;  // weight of separation force
uniform float uFlockAlignment;   // weight of alignment force
uniform float uFlockCohesion;    // weight of cohesion force
uniform float uFlockRadius;      // distance within which neighbors count

layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;

// Sample one cell of the flat-tiled spatial-hash grid. Returns
// (position_sum, count) in .xyzw of grid0 and (velocity_sum, _) in
// .xyz of grid1. Pass clamped cell coords in [0, FLOCK_GRID).
vec4 sampleGrid0(ivec3 cell) {
  int gridSz = int(uGridSize);
  int tiles = int(uGridTiles);
  cell = clamp(cell, ivec3(0), ivec3(gridSz - 1));
  int sliceX = cell.z % tiles;
  int sliceY = cell.z / tiles;
  vec2 uv = (vec2(float(sliceX * gridSz + cell.x), float(sliceY * gridSz + cell.y)) + 0.5) / uTexSize;
  return texture(uGrid0, uv);
}
vec3 sampleGrid1(ivec3 cell) {
  int gridSz = int(uGridSize);
  int tiles = int(uGridTiles);
  cell = clamp(cell, ivec3(0), ivec3(gridSz - 1));
  int sliceX = cell.z % tiles;
  int sliceY = cell.z / tiles;
  vec2 uv = (vec2(float(sliceX * gridSz + cell.x), float(sliceY * gridSz + cell.y)) + 0.5) / uTexSize;
  return texture(uGrid1, uv).rgb;
}

// 3D hash + value noise — needed for analytic curl in 3D.
float hash31(vec3 p) {
  p = fract(p * vec3(123.45, 678.91, 234.56));
  p += dot(p, p + 45.32);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// 3D curl of a vector potential field. Three orthogonal scalar noise
// fields make up the potential; finite differences give the curl.
vec3 curl3(vec3 p) {
  const float e = 0.05;
  // Potential field components, each sampled at an offset domain so
  // the three components are uncorrelated.
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);
  vec3 a = vec3(noise3(p + vec3(17.1, 0.0, 0.0)),
                noise3(p + vec3(0.0, 31.7, 0.0)),
                noise3(p + vec3(0.0, 0.0, 53.3)));
  float a1x = noise3(p + dx + vec3(17.1, 0.0, 0.0));
  float a1y = noise3(p + dx + vec3(0.0, 31.7, 0.0));
  float a1z = noise3(p + dx + vec3(0.0, 0.0, 53.3));
  float a2x = noise3(p + dy + vec3(17.1, 0.0, 0.0));
  float a2y = noise3(p + dy + vec3(0.0, 31.7, 0.0));
  float a2z = noise3(p + dy + vec3(0.0, 0.0, 53.3));
  float a3x = noise3(p + dz + vec3(17.1, 0.0, 0.0));
  float a3y = noise3(p + dz + vec3(0.0, 31.7, 0.0));
  float a3z = noise3(p + dz + vec3(0.0, 0.0, 53.3));
  // curl = (dAz/dy - dAy/dz, dAx/dz - dAz/dx, dAy/dx - dAx/dy)
  return vec3(
    (a2z - a.z) - (a3y - a.y),
    (a3x - a.x) - (a1z - a.z),
    (a1y - a.y) - (a2x - a.x)
  ) / e;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uStateSize;
  vec4 prevPos = texture(uPos, uv);
  vec4 prevVel = texture(uVel, uv);
  vec3 pos = prevPos.rgb;
  float life = prevPos.a;
  vec3 vel = prevVel.rgb;

  float bass = texture(uAudio, vec2(0.05, 0.5)).r;
  float mid  = texture(uAudio, vec2(0.40, 0.5)).r;

  // 3D curl flow, slowly evolving.
  vec3 flow = curl3(pos * uCurlScale + vec3(uTime * 0.05, uTime * 0.03, uTime * 0.04));
  flow *= 0.4 + uAudioGain * (bass + mid * 0.5);

  // Amplify vertical curl with bass — when the music hits, particles
  // get launched upward in dramatic arcs (solar-corona effect).
  flow.y *= 1.0 + uCoronaBoost * bass * uAudioGain;

  // Dominant horizontal current. Curl noise alone gives turbulent
  // motion; this adds a steady left-to-right drift on top so the
  // medium reads as flowing, not just swirling.
  flow.x += uFlowDriftX;

  vel = mix(vel, flow * 0.5, 0.15);

  // ── Flocking forces (Reynolds Boids) ─────────────────────
  // Read 27 cells (3×3×3) around the particle's voxel. Sum the
  // (position_sum, velocity_sum, count) from each, weight by inverse
  // distance to the particle so closer cells dominate, then compute
  // the three steering forces. When all three flock weights are 0
  // the force is the zero vector and the existing curl + wave system
  // behaves exactly as before.
  if (uFlockSeparation > 0.0 || uFlockAlignment > 0.0 || uFlockCohesion > 0.0) {
    vec3 norm = clamp((pos - uVolumeMin) / (uVolumeMax - uVolumeMin), 0.0, 0.9999);
    ivec3 myCell = ivec3(norm * uGridSize);
    vec3 neighborPos = vec3(0.0);
    vec3 neighborVel = vec3(0.0);
    vec3 separation = vec3(0.0);
    float totalCount = 0.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          ivec3 cell = myCell + ivec3(dx, dy, dz);
          vec4 g0 = sampleGrid0(cell);
          vec3 g1 = sampleGrid1(cell);
          if (g0.a > 0.0) {
            // Subtract THIS particle's own contribution so the
            // average doesn't include itself.
            float contrib = g0.a;
            vec3 sumPos = g0.rgb;
            vec3 sumVel = g1;
            // Within-cell average position relative to particle. If
            // the cell holds our particle plus k-1 others, sumPos
            // already contains our pos once.
            vec3 cellCenter = sumPos / contrib;
            vec3 toCenter = cellCenter - pos;
            float d = length(toCenter);
            // Separation: push away from crowded cells, weighted by
            // inverse distance so very close neighbors push hardest.
            if (d > 0.0001 && d < uFlockRadius) {
              separation -= toCenter / max(d * d, 0.01) * contrib;
            }
            neighborPos += sumPos;
            neighborVel += sumVel;
            totalCount += contrib;
          }
        }
      }
    }
    if (totalCount > 1.0) {
      // Subtract this particle's own contribution from the averages.
      vec3 avgPos = (neighborPos - pos) / max(totalCount - 1.0, 1.0);
      vec3 avgVel = (neighborVel - vel) / max(totalCount - 1.0, 1.0);
      vec3 cohesion = avgPos - pos;
      vec3 alignment = avgVel - vel;
      vec3 flockForce = separation * uFlockSeparation
                      + alignment * uFlockAlignment
                      + cohesion * uFlockCohesion;
      // Cap the per-frame influence so flocking doesn't override the
      // other dynamics. The 0.08 cap is empirical — strong enough
      // for emergent flocks, weak enough to coexist with curl + wave.
      float maxForce = 0.08;
      float fLen = length(flockForce);
      if (fLen > maxForce) flockForce *= maxForce / fLen;
      vel += flockForce;
    }
  }

  // Wave attractor — pull particles toward a layered swell surface
  // in y as a function of (x, z). Four overlapping wave packs at
  // different frequencies, directions, and phases. Sums to a
  // rolling ocean with multiple-scale structure (long swells +
  // shorter chop on top), not a single sine.
  float wavY = sin(pos.x * 0.9 + uTime * 0.6) * uWaveAmp
             + cos(pos.z * 0.7 - uTime * 0.5) * uWaveAmp * 0.75
             + sin(pos.x * 1.7 + pos.z * 1.3 + uTime * 0.95) * uWaveAmp * 0.42
             + cos(pos.x * 2.6 - pos.z * 0.5 + uTime * 0.3) * uWaveAmp * 0.26
             + sin(pos.x * 4.1 + pos.z * 3.3 + uTime * 1.4) * uWaveAmp * 0.14;
  vel.y -= (pos.y - wavY) * 0.6;

  vel *= uVelocityDamp;

  pos += vel * uDt;
  life = min(life + uDt * 0.4, 1.0);

  // Respawn inside the slab volume — wide in x and z, narrow in y.
  // Slab geometry is what gives the ocean-surface read.
  vec3 vsz = uVolumeSize;
  bool outX = abs(pos.x) > vsz.x;
  bool outY = abs(pos.y) > vsz.y * 3.0;  // generous Y bound for arcs
  bool outZ = abs(pos.z) > vsz.z;
  if (outX || outY || outZ) {
    vec3 seed = vec3(uv, floor(uTime * 0.5));
    pos = vec3((hash31(seed)        - 0.5) * 2.0 * vsz.x,
               (hash31(seed + 17.3) - 0.5) * 0.4 * vsz.y,
               (hash31(seed + 53.7) - 0.5) * 2.0 * vsz.z);
    vel = vec3(0.0);
    life = 0.0;
  }

  outPos = vec4(pos, life);
  outVel = vec4(vel, 0.0);
}
`;

// Render pass: instanced "crossed billboards" — two perpendicular
// flat quads per particle, both showing the same flower texture.
// Classic Mario/Zelda foliage trick: from any camera angle one of
// the quads is roughly face-on so the silhouette always reads as a
// flower. 12 vertices per particle (2 quads × 6 verts). Each
// particle's cross is rotated by a stable per-particle 3D rotation
// so we don't see a repeating grid of identical "+" shapes.
const VS_RENDER = `#version 300 es
precision highp float;

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform vec2 uStateSize;
uniform float uParticleSize;
uniform float uSizeVariance;
uniform float uAtlasSize;
uniform float uTime;
uniform float uBass;
uniform float uDanceAmount;
uniform mat4 uView;
uniform mat4 uProj;

out vec2 vTileUv;
out float vTileIndex;
out float vLife;
out float vDepth;

// Standard CCW quad triangle pattern: 0,1,2 + 0,2,3 in (u,v) space.
const vec2 quadVerts[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

// Rodrigues rotation matrix for an arbitrary axis + angle.
mat3 rotAxisAngle(vec3 axis, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  float k = 1.0 - c;
  return mat3(
    c + axis.x*axis.x*k,         axis.y*axis.x*k + axis.z*s, axis.z*axis.x*k - axis.y*s,
    axis.x*axis.y*k - axis.z*s,  c + axis.y*axis.y*k,        axis.z*axis.y*k + axis.x*s,
    axis.x*axis.z*k + axis.y*s,  axis.y*axis.z*k - axis.x*s, c + axis.z*axis.z*k
  );
}

void main() {
  int instance = gl_InstanceID;
  vec2 stateUV = (vec2(float(instance % int(uStateSize.x)),
                       float(instance / int(uStateSize.x))) + 0.5) / uStateSize;
  vec4 posData = texture(uPos, stateUV);
  vec3 world = posData.rgb;
  float life = posData.a;

  int quadId = gl_VertexID / 6;   // 0 = "X-facing" plane, 1 = "Z-facing" plane
  int v = gl_VertexID % 6;
  vec2 q = quadVerts[v];
  vec2 corner = q - 0.5;          // [-0.5, 0.5]

  // Both quads share the vertical (Y) axis. Quad 0 lies in the YZ
  // plane (its picture faces along ±X); quad 1 lies in the XY plane
  // (its picture faces along ±Z). Together they form a "+" shape
  // when viewed from above.
  vec3 localPos = quadId == 0
    ? vec3(0.0, corner.y, corner.x)
    : vec3(corner.x, corner.y, 0.0);

  // Per-particle size from a stable hash, power-law distribution.
  float sizeHash = fract(sin(dot(stateUV, vec2(91.7, 23.1))) * 12345.67);
  float sizeScale = mix(1.0, mix(0.35, 3.2, pow(sizeHash, 1.8)), uSizeVariance);

  // Per-particle 3D rotation around a stable axis. Bass + dance amount
  // very gently modulate the angle so flowers nod, never spin.
  vec3 rotHash3 = vec3(
    fract(sin(dot(stateUV, vec2(45.3, 71.9))) * 9876.54),
    fract(sin(dot(stateUV, vec2(33.7, 89.1))) * 5432.10),
    fract(sin(dot(stateUV, vec2(11.3, 51.7))) * 7654.32)
  );
  vec3 rotAxis = normalize(rotHash3 - 0.5);
  float baseAngle = rotHash3.x * 6.28318;
  float wobbleSpeed = 0.04 + rotHash3.x * 0.12;
  float angle = baseAngle
              + uTime * wobbleSpeed * uBass * uDanceAmount
              + sin(uTime * (0.25 + rotHash3.y * 0.4)) * 0.05 * uBass * uDanceAmount;
  mat3 R = rotAxisAngle(rotAxis, angle);

  vec3 worldOffset = R * (localPos * uParticleSize * sizeScale);
  vec3 worldPos = world + worldOffset;

  vec4 viewPos = uView * vec4(worldPos, 1.0);
  gl_Position = uProj * viewPos;

  vTileUv = q;
  float h = fract(sin(dot(stateUV, vec2(127.1, 311.7))) * 43758.5453);
  vTileIndex = floor(h * uAtlasSize * uAtlasSize);
  vLife = life;
  vDepth = -viewPos.z;
}
`;

const FS_RENDER = `#version 300 es
precision highp float;

uniform sampler2D uAtlas;
uniform float uAtlasSize;
uniform float uFogNear;
uniform float uFogFar;

in vec2 vTileUv;
in float vTileIndex;
in float vLife;
in float vDepth;
out vec4 outColor;

void main() {
  // Soft elliptical mask so the quad edges fade — keeps the silhouette
  // organic instead of revealing the rectangle.
  vec2 c = vTileUv - 0.5;
  float mask = smoothstep(0.5, 0.18, length(c));
  if (mask < 0.001) discard;

  // Atlas tile lookup — same tile on both quads of the cross so the
  // particle reads as one flower seen from two perpendicular sheets.
  float col = floor(mod(vTileIndex, uAtlasSize));
  float row = floor(vTileIndex / uAtlasSize);
  vec2 atlasUv = (vec2(col, row) + clamp(vTileUv, 0.01, 0.99)) / uAtlasSize;
  vec4 tile = texture(uAtlas, atlasUv);

  float lifeFade = smoothstep(0.0, 0.3, vLife);
  float fog = clamp((uFogFar - vDepth) / (uFogFar - uFogNear), 0.0, 1.0);

  vec3 rgb = tile.rgb * mix(0.3, 1.0, fog);
  float alpha = tile.a * mask * lifeFade * 0.75;
  outColor = vec4(rgb, alpha);
}
`;

// Blit pass — copies a texture to the current render target with an
// optional alpha multiplier. Used by the trails pipeline to fade the
// previous accumulator frame before drawing the new particles on top,
// and to display the final accumulator to the canvas.
const FS_BLIT = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 c = texture(uTex, uv);
  outColor = vec4(c.rgb * uAlpha, c.a * uAlpha);
}
`;

// ── flocking spatial-hash scatter ───────────────────────────────
// Each frame we render PARTICLE_COUNT POINT primitives with additive
// blending into the spatial-hash grid. The vertex shader reads each
// particle's state and outputs gl_Position pointing at the texel of
// the voxel containing that particle. The fragment shader writes the
// particle's position + 1.0 (a count contribution) into one MRT
// target, and its velocity into the other. Repeated writes from
// multiple particles in the same cell accumulate via gl.blendFunc(ONE,
// ONE) so we get position_sum, velocity_sum, and count per cell in a
// single draw call.
const VS_SCATTER = `#version 300 es
precision highp float;

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform vec2 uStateSize;
uniform vec3 uVolumeMin;
uniform vec3 uVolumeMax;
uniform float uGridSize;
uniform float uGridTiles;
uniform float uTexSize;

out vec3 vPos;
out vec3 vVel;

void main() {
  int instance = gl_VertexID;
  int sx = int(uStateSize.x);
  vec2 stateUV = (vec2(float(instance % sx), float(instance / sx)) + 0.5) / uStateSize;
  vec3 p = texture(uPos, stateUV).rgb;
  vec3 v = texture(uVel, stateUV).rgb;

  // Map world position into [0, uGridSize) per axis. Particles that
  // drift outside the simulation volume clamp to the edge cells so we
  // don't sample garbage; the update pass respawn handles their reset.
  vec3 norm = clamp((p - uVolumeMin) / (uVolumeMax - uVolumeMin), 0.0, 0.9999);
  ivec3 cell = ivec3(norm * uGridSize);

  // Pack the 3D cell into a 2D texel coord by tiling z-slices in a
  // uGridTiles × uGridTiles grid (FLOCK_GRID_TILES × FLOCK_GRID_TILES).
  int tiles = int(uGridTiles);
  int gridSz = int(uGridSize);
  int sliceX = cell.z % tiles;
  int sliceY = cell.z / tiles;
  int texelX = sliceX * gridSz + cell.x;
  int texelY = sliceY * gridSz + cell.y;

  vec2 ndc = (vec2(float(texelX), float(texelY)) + 0.5) / uTexSize * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 1.0;
  vPos = p;
  vVel = v;
}
`;

const FS_SCATTER = `#version 300 es
precision highp float;

in vec3 vPos;
in vec3 vVel;

layout(location = 0) out vec4 outGrid0;  // (position_sum, count_contribution)
layout(location = 1) out vec4 outGrid1;  // (velocity_sum, unused)

void main() {
  outGrid0 = vec4(vPos, 1.0);
  outGrid1 = vec4(vVel, 0.0);
}
`;

// ── public API ─────────────────────────────────────────────────────

export interface ParticlesBg {
  readonly presetName: string;
  readonly currentUrl: string | null;
  connectAudio: (node: AudioNode) => void;
  loadFromUrl: (url: string) => Promise<string>;
  bindImage: (url: string | null) => Promise<void>;
  destroy: () => void;
}

export interface ParticlesPreset {
  name?: string;
  atlas_url?: string;
  atlas_size?: number;
  particle_size?: number;
  /** 0 = all particles same size. 1 = wide power-distributed range
   *  (0.35x to 3.2x base). Default 0.85. */
  size_variance?: number;
  velocity_stretch?: number;
  curl_scale?: number;
  velocity_damp?: number;
  audio_gain?: number;
  /** Legacy spherical bound (used only if volume_size unset). */
  volume_radius?: number;
  /** Slab half-extents: [x, y, z]. Default [3.5, 0.4, 3.5] — wide
   *  rolling-ocean shape. */
  volume_size?: [number, number, number];
  /** Amplitude of the sinusoidal wave attractor in y. Default 0.5. */
  wave_amplitude?: number;
  /** Steady horizontal current added on top of curl noise. Default 0.6. */
  flow_drift_x?: number;
  /** Bass-driven vertical curl boost — drives corona arcs. Default 4.0. */
  corona_boost?: number;
  /** How strongly bass drives per-particle rotation wobble. 0 = no
   *  dancing; 1.5 = visible per-flower wobble on every bass hit.
   *  Default 1.2. */
  dance_amount?: number;
  /** Camera orbit radius. Default 4.5. */
  camera_radius?: number;
  /** Camera height above the wave plane. Default 0.6. */
  camera_height?: number;
  /** Camera orbit speed in rad/s. Default 0.025. */
  camera_orbit_speed?: number;
  /** Vertical FOV in degrees. Default 50. */
  fov_degrees?: number;
  /** Screen-space trail decay per frame. 0 = no trails (particles
   *  redraw fresh each frame). 0.92 = Magnetosphere-style smoky
   *  streams. 0.97 = long-persistence light painting. Default 0 so
   *  existing presets aren't affected. */
  trail_decay?: number;
  /** Reynolds Boids flocking — separation, alignment, cohesion. All
   *  three default to 0, which short-circuits the scatter pass and
   *  the flocking computation entirely. Typical strong-flocking
   *  values: separation 0.5, alignment 0.4, cohesion 0.25, radius 0.3. */
  flock_separation?: number;
  flock_alignment?: number;
  flock_cohesion?: number;
  /** Neighbor radius in world units. Particles closer than this
   *  influence each other; particles further apart see no flocking
   *  force. Must be at most the cell size (about 0.13 world units
   *  for the default 32³ grid over a 4-unit volume) for the
   *  spatial-hash approximation to be valid. Default 0.15. */
  flock_radius?: number;
}

export function createParticlesBackground(
  audioCtx: AudioContext,
  canvas: HTMLCanvasElement,
  silentSource: AudioNode,
): ParticlesBg {
  const glOrNull = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!glOrNull) throw new Error("WebGL2 not available");
  const gl = glOrNull;

  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("EXT_color_buffer_float not supported — particles backend needs it");
  }

  // ── audio ─────────────────────────────────────────────
  let audioSource: AudioNode = silentSource;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioSource.connect(analyser);
  const fftBytes = new Uint8Array(256);
  const audioTex = makeTexture(gl, gl.R8, 256, 1, gl.RED, gl.UNSIGNED_BYTE, null);

  // ── state textures (ping-pong, two per slot) ─────────
  const posA = makeStateTexture(gl, STATE_SIZE);
  const posB = makeStateTexture(gl, STATE_SIZE);
  const velA = makeStateTexture(gl, STATE_SIZE);
  const velB = makeStateTexture(gl, STATE_SIZE);
  let readPos = posA, writePos = posB;
  let readVel = velA, writeVel = velB;
  const fbo = gl.createFramebuffer()!;
  seedStateTextures(gl, readPos, readVel, STATE_SIZE);

  // ── atlas ─────────────────────────────────────────────
  const atlasTex = makeTexture(gl, gl.RGBA, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([32, 32, 38, 255]));

  // ── programs ──────────────────────────────────────────
  const updateProg = makeProgram(gl, VS_FULLSCREEN, FS_UPDATE);
  const renderProg = makeProgram(gl, VS_RENDER, FS_RENDER);
  const blitProg = makeProgram(gl, VS_FULLSCREEN, FS_BLIT);
  const scatterProg = makeProgram(gl, VS_SCATTER, FS_SCATTER);
  const dummyVao = gl.createVertexArray()!;
  const loc = (p: WebGLProgram, name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(p, name);

  // ── flocking spatial-hash grid ────────────────────────
  // Two RGBA32F textures (FLOCK_TEX_SIZE × FLOCK_TEX_SIZE) holding
  // accumulated (position_sum, count) and (velocity_sum, _) per voxel.
  // Cleared and re-scattered each frame just before the update pass.
  const flockGrid0 = makeColorFloatTexture(gl, FLOCK_TEX_SIZE, FLOCK_TEX_SIZE);
  const flockGrid1 = makeColorFloatTexture(gl, FLOCK_TEX_SIZE, FLOCK_TEX_SIZE);
  const flockFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, flockFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, flockGrid0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, flockGrid1, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // ── trail accumulator (ping-pong RGBA8 textures the canvas size) ─
  // Created lazily on first trail-enabled frame, recreated on resize.
  // When trail_decay = 0 the whole path is skipped and we render
  // directly to the canvas as before.
  let trailA: WebGLTexture | null = null;
  let trailB: WebGLTexture | null = null;
  let trailW = 0, trailH = 0;
  const trailFbo = gl.createFramebuffer()!;

  function ensureTrailTextures(w: number, h: number): void {
    if (trailA && trailB && trailW === w && trailH === h) return;
    if (trailA) gl.deleteTexture(trailA);
    if (trailB) gl.deleteTexture(trailB);
    trailA = makeColorTexture(gl, w, h);
    trailB = makeColorTexture(gl, w, h);
    trailW = w;
    trailH = h;
  }

  // ── runtime state ─────────────────────────────────────
  let currentUrl: string | null = null;
  let currentName = "particles";
  let preset: Required<ParticlesPreset> = {
    name: "particles",
    atlas_url: "",
    atlas_size: 4,
    particle_size: 0.06,
    size_variance: 0.85,
    velocity_stretch: 1.5,
    curl_scale: 0.8,
    velocity_damp: 0.985,
    audio_gain: 1.4,
    volume_radius: 1.5,
    volume_size: [3.5, 0.4, 3.5],
    wave_amplitude: 0.5,
    flow_drift_x: 0.6,
    corona_boost: 4.0,
    dance_amount: 0.4,
    camera_radius: 4.5,
    camera_height: 0.6,
    camera_orbit_speed: 0.025,
    fov_degrees: 50,
    trail_decay: 0,
    flock_separation: 0,
    flock_alignment: 0,
    flock_cohesion: 0,
    flock_radius: 0.15,
  };
  let running = true;
  const startTime = performance.now();
  let lastTime = startTime;
  let bassSmooth = 0;

  const sizeTo = (w: number, h: number): void => {
    canvas.width = w;
    canvas.height = h;
  };
  sizeTo(window.innerWidth, window.innerHeight);

  function frameLoop(): void {
    if (!running) return;
    const now = performance.now();
    const t = (now - startTime) * 0.001;
    const dt = Math.min(0.05, (now - lastTime) * 0.001);
    lastTime = now;

    analyser.getByteFrequencyData(fftBytes);
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, fftBytes);

    // Bass scalar = mean of FFT bins 4..16 (~50-200 Hz). Smoothed
    // toward the current value so dance wobble doesn't jitter wildly
    // between frames. Used by the render shader for per-particle rotation.
    let bassRaw = 0;
    for (let i = 4; i < 16; i++) bassRaw += fftBytes[i];
    bassRaw = (bassRaw / 12) / 255;
    bassSmooth = bassSmooth * 0.7 + bassRaw * 0.3;

    // ── flocking scatter pass ───────────────────────────
    // Render 65k POINT primitives into the spatial-hash grid with
    // additive blending. Each particle's point lands in the 2D
    // texel of its voxel; the FS writes (position, 1.0) into MRT0
    // and (velocity, 0) into MRT1. Blending accumulates per-cell.
    // Skipped entirely when all three Reynolds weights are zero.
    const flockOn =
      preset.flock_separation > 0 ||
      preset.flock_alignment > 0 ||
      preset.flock_cohesion > 0;
    if (flockOn) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, flockFbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, FLOCK_TEX_SIZE, FLOCK_TEX_SIZE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(scatterProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readPos);
      gl.uniform1i(loc(scatterProg, "uPos"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, readVel);
      gl.uniform1i(loc(scatterProg, "uVel"), 1);
      gl.uniform2f(loc(scatterProg, "uStateSize"), STATE_SIZE, STATE_SIZE);
      const vmin: [number, number, number] = [
        -preset.volume_size[0], -preset.volume_size[1] * 3.0, -preset.volume_size[2],
      ];
      const vmax: [number, number, number] = [
        preset.volume_size[0], preset.volume_size[1] * 3.0, preset.volume_size[2],
      ];
      gl.uniform3f(loc(scatterProg, "uVolumeMin"), vmin[0], vmin[1], vmin[2]);
      gl.uniform3f(loc(scatterProg, "uVolumeMax"), vmax[0], vmax[1], vmax[2]);
      gl.uniform1f(loc(scatterProg, "uGridSize"), FLOCK_GRID);
      gl.uniform1f(loc(scatterProg, "uGridTiles"), FLOCK_GRID_TILES);
      gl.uniform1f(loc(scatterProg, "uTexSize"), FLOCK_TEX_SIZE);
      gl.bindVertexArray(dummyVao);
      gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
      gl.disable(gl.BLEND);
    }

    // ── update pass (MRT: both pos + vel) ───────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, writePos, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, writeVel, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, STATE_SIZE, STATE_SIZE);
    gl.useProgram(updateProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readPos);
    gl.uniform1i(loc(updateProg, "uPos"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readVel);
    gl.uniform1i(loc(updateProg, "uVel"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
    gl.uniform1i(loc(updateProg, "uAudio"), 2);
    gl.uniform2f(loc(updateProg, "uStateSize"), STATE_SIZE, STATE_SIZE);
    gl.uniform1f(loc(updateProg, "uTime"), t);
    gl.uniform1f(loc(updateProg, "uDt"), dt);
    gl.uniform1f(loc(updateProg, "uCurlScale"), preset.curl_scale);
    gl.uniform1f(loc(updateProg, "uVelocityDamp"), preset.velocity_damp);
    gl.uniform1f(loc(updateProg, "uAudioGain"), preset.audio_gain);
    gl.uniform1f(loc(updateProg, "uVolumeRadius"), preset.volume_radius);
    gl.uniform3f(loc(updateProg, "uVolumeSize"),
      preset.volume_size[0], preset.volume_size[1], preset.volume_size[2]);
    gl.uniform1f(loc(updateProg, "uWaveAmp"), preset.wave_amplitude);
    gl.uniform1f(loc(updateProg, "uFlowDriftX"), preset.flow_drift_x);
    gl.uniform1f(loc(updateProg, "uCoronaBoost"), preset.corona_boost);
    // Flocking inputs. The grid textures contain the cell sums from
    // this frame's scatter pass; the update pass reads 27 cells around
    // each particle's voxel to compute Reynolds steering forces.
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, flockGrid0);
    gl.uniform1i(loc(updateProg, "uGrid0"), 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, flockGrid1);
    gl.uniform1i(loc(updateProg, "uGrid1"), 4);
    gl.uniform3f(loc(updateProg, "uVolumeMin"),
      -preset.volume_size[0], -preset.volume_size[1] * 3.0, -preset.volume_size[2]);
    gl.uniform3f(loc(updateProg, "uVolumeMax"),
      preset.volume_size[0], preset.volume_size[1] * 3.0, preset.volume_size[2]);
    gl.uniform1f(loc(updateProg, "uGridSize"), FLOCK_GRID);
    gl.uniform1f(loc(updateProg, "uGridTiles"), FLOCK_GRID_TILES);
    gl.uniform1f(loc(updateProg, "uTexSize"), FLOCK_TEX_SIZE);
    gl.uniform1f(loc(updateProg, "uFlockSeparation"), preset.flock_separation);
    gl.uniform1f(loc(updateProg, "uFlockAlignment"), preset.flock_alignment);
    gl.uniform1f(loc(updateProg, "uFlockCohesion"), preset.flock_cohesion);
    gl.uniform1f(loc(updateProg, "uFlockRadius"), preset.flock_radius);
    gl.bindVertexArray(dummyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // swap state
    [readPos, writePos] = [writePos, readPos];
    [readVel, writeVel] = [writeVel, readVel];

    // ── render pass ─────────────────────────────────────
    // When trail_decay > 0 we render into a ping-pong accumulator
    // texture: first blit the previous accumulator into the new one
    // with alpha = trail_decay (fades old content), then draw the new
    // particles on top, then display the accumulator to the canvas.
    // When trail_decay = 0 we render directly to the canvas as before.
    const trailDecay = preset.trail_decay;
    if (trailDecay > 0) {
      ensureTrailTextures(canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, trailFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, trailB!, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, trailW, trailH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(blitProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trailA!);
      gl.uniform1i(loc(blitProg, "uTex"), 0);
      gl.uniform2f(loc(blitProg, "uResolution"), trailW, trailH);
      gl.uniform1f(loc(blitProg, "uAlpha"), trailDecay);
      gl.bindVertexArray(dummyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    gl.enable(gl.BLEND);
    // Standard alpha over compositing. Particles aren't depth-sorted
    // so order is random per frame, but with thousands of small
    // overlapping sprites it averages out — and we avoid the
    // additive-blend saturation that crushes the center to white.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Camera: low elevation looking across the wave surface. Slow
    // orbit at the same height so we always see the surface plane
    // edge-on rather than top-down, giving us depth and horizon.
    const camAngle = t * preset.camera_orbit_speed;
    const eye: Vec3 = [
      Math.cos(camAngle) * preset.camera_radius,
      preset.camera_height + Math.sin(t * 0.04) * 0.15,
      Math.sin(camAngle) * preset.camera_radius,
    ];
    const target: Vec3 = [0, 0, 0];
    const up: Vec3 = [0, 1, 0];
    const view = lookAtMatrix(eye, target, up);
    const aspect = canvas.width / canvas.height;
    const proj = perspectiveMatrix(preset.fov_degrees * Math.PI / 180, aspect, 0.1, 50);

    gl.useProgram(renderProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readPos);
    gl.uniform1i(loc(renderProg, "uPos"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readVel);
    gl.uniform1i(loc(renderProg, "uVel"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(loc(renderProg, "uAtlas"), 2);
    gl.uniform2f(loc(renderProg, "uStateSize"), STATE_SIZE, STATE_SIZE);
    gl.uniform1f(loc(renderProg, "uParticleSize"), preset.particle_size);
    gl.uniform1f(loc(renderProg, "uSizeVariance"), preset.size_variance);
    gl.uniform1f(loc(renderProg, "uAtlasSize"), preset.atlas_size);
    gl.uniformMatrix4fv(loc(renderProg, "uView"), false, view);
    gl.uniformMatrix4fv(loc(renderProg, "uProj"), false, proj);
    gl.uniform1f(loc(renderProg, "uTime"), t);
    gl.uniform1f(loc(renderProg, "uBass"), bassSmooth);
    gl.uniform1f(loc(renderProg, "uDanceAmount"), preset.dance_amount);
    gl.uniform1f(loc(renderProg, "uFogNear"), 0.5);
    gl.uniform1f(loc(renderProg, "uFogFar"), preset.camera_radius * 2.5);
    gl.bindVertexArray(dummyVao);
    // 12 vertices per crossed-billboard particle: two perpendicular
    // quads, each 6 vertices (2 triangles).
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 12, PARTICLE_COUNT);

    gl.disable(gl.BLEND);

    // ── trail display pass ─────────────────────────────────
    // If we rendered into the accumulator, swap and blit the now-
    // current trail to the canvas at full alpha.
    if (trailDecay > 0) {
      [trailA, trailB] = [trailB, trailA];
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(blitProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trailA!);
      gl.uniform1i(loc(blitProg, "uTex"), 0);
      gl.uniform2f(loc(blitProg, "uResolution"), canvas.width, canvas.height);
      gl.uniform1f(loc(blitProg, "uAlpha"), 1.0);
      gl.bindVertexArray(dummyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  const onResize = (): void => sizeTo(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", onResize, { passive: true });

  return {
    get presetName(): string { return currentName; },
    get currentUrl(): string | null { return currentUrl; },
    connectAudio: (node) => {
      audioSource.disconnect(analyser);
      audioSource = node;
      audioSource.connect(analyser);
    },
    loadFromUrl: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
      const json = (await res.json()) as ParticlesPreset;
      preset = { ...preset, ...json };
      if (json.atlas_url) await loadAtlas(json.atlas_url);
      currentUrl = url;
      currentName = json.name ?? url.split("/").pop()?.replace(/\.json$/, "") ?? "particles";
      seedStateTextures(gl, readPos, readVel, STATE_SIZE);
      return currentName;
    },
    bindImage: async (url) => {
      if (url) await loadAtlas(url);
    },
    destroy: () => {
      running = false;
      window.removeEventListener("resize", onResize);
    },
  };

  async function loadAtlas(url: string): Promise<void> {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`failed to load atlas: ${url}`));
      img.src = url;
    });
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}

// ── matrix helpers (no external deps) ──────────────────────────────

type Vec3 = [number, number, number];

function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}
function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0]/len, a[1]/len, a[2]/len];
}

/** Right-handed lookAt matrix, column-major, matching standard
 *  WebGL uniformMatrix4fv(transpose=false) expectations. */
function lookAtMatrix(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  const f = normalize(subtract(target, eye));
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -(s[0]*eye[0] + s[1]*eye[1] + s[2]*eye[2]),
    -(u[0]*eye[0] + u[1]*eye[1] + u[2]*eye[2]),
     (f[0]*eye[0] + f[1]*eye[1] + f[2]*eye[2]),
    1,
  ]);
}

function perspectiveMatrix(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0,
  ]);
}

// ── GL helpers ─────────────────────────────────────────────────────

function makeTexture(
  gl: WebGL2RenderingContext,
  internal: GLenum,
  w: number,
  h: number,
  format: GLenum,
  type: GLenum,
  data: ArrayBufferView | null,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  return tex;
}

/** RGBA32F color target. Used by the spatial-hash flocking grid so
 *  per-voxel sums of position + velocity can overflow safely past the
 *  255-value cap of RGBA8 — at 65k particles per cell the sums easily
 *  reach the thousands. NEAREST filtering since we always read at
 *  texel centers. */
function makeColorFloatTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  return tex;
}

/** RGBA8 color target sized to the canvas. Used by the trail
 *  ping-pong accumulator. LINEAR filtering so the blit pass reads
 *  smoothly even when the canvas is on a fractional pixel offset. */
function makeColorTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return tex;
}

function makeStateTexture(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // NEAREST so reads aren't smeared between neighbouring particles.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
  return tex;
}

function seedStateTextures(
  gl: WebGL2RenderingContext,
  posTex: WebGLTexture,
  velTex: WebGLTexture,
  size: number,
): void {
  const radius = 1.2;
  const posData = new Float32Array(size * size * 4);
  const velData = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    posData[o]     = (Math.random() - 0.5) * 2 * radius;
    posData[o + 1] = (Math.random() - 0.5) * 2 * radius;
    posData[o + 2] = (Math.random() - 0.5) * 2 * radius;
    posData[o + 3] = Math.random();  // initial life staggered
    // velocity stays 0; curl noise picks it up
  }
  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, posData);
  gl.bindTexture(gl.TEXTURE_2D, velTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, velData);
}

function makeProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) ?? "(no log)";
    throw new Error(`particles link error: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "(no log)";
    gl.deleteShader(sh);
    throw new Error(`particles GLSL compile error:\n${log}\n${src}`);
  }
  return sh;
}
