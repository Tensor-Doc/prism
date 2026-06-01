// particles.ts — render a fluid of N textured particles to a canvas.
// Each particle is a quad sprite that samples one tile from an image
// atlas, stretched along its velocity vector. The flow field is driven
// by curl noise + audio so the particles behave as a fluid medium.
// Same role as backends/milkdrop.ts and backends/shadertoy.ts: takes
// audio in, paints a live visual. GraphRuntime swaps to this backend
// when the graph has an lf.particles node.

const PARTICLE_GRID = 256;                  // 65,536 particles total
const STATE_SIZE = PARTICLE_GRID;           // state texture dimension
const PARTICLE_COUNT = STATE_SIZE * STATE_SIZE;

// ── shader source ──────────────────────────────────────────────────

const VS_FULLSCREEN = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// Update pass: per-particle physics. Reads previous state, writes new.
const FS_UPDATE = `#version 300 es
precision highp float;

uniform sampler2D uState;       // RGBA32F: rg=pos, ba=vel
uniform sampler2D uAudio;       // 256x1 R8 FFT
uniform vec2 uStateSize;
uniform float uTime;
uniform float uDt;
uniform float uCurlScale;
uniform float uVelocityDamp;
uniform float uAudioGain;
out vec4 outState;

float hash21(vec2 p) {
  p = fract(p * vec2(123.45, 678.91));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 curl(vec2 p) {
  float e = 0.05;
  float n1 = noise2(p + vec2(e, 0.0));
  float n2 = noise2(p - vec2(e, 0.0));
  float n3 = noise2(p + vec2(0.0, e));
  float n4 = noise2(p - vec2(0.0, e));
  return vec2(n4 - n3, n1 - n2) / (2.0 * e);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uStateSize;
  vec4 prev = texture(uState, uv);
  vec2 pos = prev.rg;
  vec2 vel = prev.ba;

  float bass = texture(uAudio, vec2(0.05, 0.5)).r;
  float mid  = texture(uAudio, vec2(0.40, 0.5)).r;

  // Curl-noise flow field, time-evolving + audio-modulated.
  vec2 flow = curl(pos * uCurlScale + vec2(uTime * 0.05, uTime * 0.03));
  flow *= 0.4 + uAudioGain * (bass + mid * 0.5);

  // Velocity blends toward the flow target; damping keeps it bounded.
  vel = mix(vel, flow * 0.5, 0.15);
  vel *= uVelocityDamp;

  pos += vel * uDt;

  // Respawn at a deterministic random position when the particle leaves
  // the canvas. The hash uses the state-tex coord as seed so each
  // particle has a consistent spawn point per cycle.
  if (pos.x < -0.05 || pos.x > 1.05 || pos.y < -0.05 || pos.y > 1.05) {
    vec2 seed = uv + vec2(floor(uTime * 0.5));
    pos = vec2(hash21(seed), hash21(seed + 17.3));
    vel = vec2(0.0);
  }

  outState = vec4(pos, vel);
}
`;

// Render pass: instanced quads, vertex shader stretches each along
// velocity, fragment samples one atlas tile per particle and applies
// a soft elliptical mask.
const VS_RENDER = `#version 300 es
precision highp float;

uniform sampler2D uState;
uniform vec2 uStateSize;
uniform float uParticleSize;
uniform float uVelocityStretch;
uniform float uAtlasSize;
uniform vec2 uAspect;           // canvas width/height normalization

out vec2 vTileUv;               // [0,1] inside the tile
out float vTileIndex;
out float vSpeed;

// Unit quad vertices, driven by gl_VertexID.
vec2 quadCorner(int id) {
  return vec2(float(id & 1) - 0.5, float((id >> 1) & 1) - 0.5);
}

void main() {
  int instance = gl_InstanceID;
  vec2 stateUV = (vec2(float(instance % int(uStateSize.x)),
                       float(instance / int(uStateSize.x))) + 0.5) / uStateSize;
  vec4 state = texture(uState, stateUV);
  vec2 pos = state.rg;
  vec2 vel = state.ba;

  float speed = length(vel);
  vec2 dir = speed > 1e-6 ? vel / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float stretch = 1.0 + speed * uVelocityStretch;

  vec2 corner = quadCorner(gl_VertexID);
  vTileUv = corner + 0.5;

  // Build the stretched-quad offset in world (uv) space.
  vec2 local = corner * uParticleSize;
  vec2 offset = local.x * stretch * dir + local.y * perp;
  // Compensate aspect so particles aren't squished on wide canvases.
  offset *= uAspect;
  vec2 world = pos + offset;

  // Per-particle tile index from a stable hash of state position.
  float h = fract(sin(dot(stateUV, vec2(127.1, 311.7))) * 43758.5453);
  vTileIndex = floor(h * uAtlasSize * uAtlasSize);
  vSpeed = speed;

  gl_Position = vec4(world * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FS_RENDER = `#version 300 es
precision highp float;

uniform sampler2D uAtlas;
uniform float uAtlasSize;

in vec2 vTileUv;
in float vTileIndex;
in float vSpeed;
out vec4 outColor;

void main() {
  // Soft elliptical mask — particle fades at the edges.
  vec2 c = vTileUv - 0.5;
  float r = length(c);
  float mask = smoothstep(0.5, 0.15, r);
  if (mask < 0.001) discard;

  // Atlas tile lookup.
  float col = floor(mod(vTileIndex, uAtlasSize));
  float row = floor(vTileIndex / uAtlasSize);
  vec2 atlasUv = (vec2(col, row) + clamp(vTileUv, 0.01, 0.99)) / uAtlasSize;
  vec4 tile = texture(uAtlas, atlasUv);

  outColor = vec4(tile.rgb, tile.a * mask * 0.75);
}
`;

// ── public API ─────────────────────────────────────────────────────

export interface ParticlesBg {
  readonly presetName: string;
  readonly currentUrl: string | null;
  connectAudio: (node: AudioNode) => void;
  /** Load a particle preset by URL — the JSON describes atlas + tunables. */
  loadFromUrl: (url: string) => Promise<string>;
  bindImage: (url: string | null) => Promise<void>;
  destroy: () => void;
}

export interface ParticlesPreset {
  /** Display name. */
  name?: string;
  /** Atlas image URL (overrides bindImage default). */
  atlas_url?: string;
  /** Tiles per row in the atlas. Defaults to 4. */
  atlas_size?: number;
  /** Particle size in uv units. Defaults to 0.02. */
  particle_size?: number;
  /** How much velocity stretches the particle quad. Defaults to 2.5. */
  velocity_stretch?: number;
  /** Curl noise spatial frequency. Defaults to 6.0. */
  curl_scale?: number;
  /** Per-frame velocity damping (0.95–0.999 typical). Defaults to 0.985. */
  velocity_damp?: number;
  /** Audio reactivity gain. Defaults to 1.2. */
  audio_gain?: number;
}

export function createParticlesBackground(
  audioCtx: AudioContext,
  canvas: HTMLCanvasElement,
  silentSource: AudioNode,
): ParticlesBg {
  const glOrNull = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    // preserveDrawingBuffer so canvas.toDataURL reads pixels (capture path).
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!glOrNull) throw new Error("WebGL2 not available");
  const gl = glOrNull;

  // RGBA32F render target support is required for state textures.
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

  // ── state textures (ping-pong) ────────────────────────
  const stateA = makeStateTexture(gl, STATE_SIZE);
  const stateB = makeStateTexture(gl, STATE_SIZE);
  let readState = stateA;
  let writeState = stateB;
  const fbo = gl.createFramebuffer()!;

  // Seed initial positions randomly across the canvas.
  seedStateTexture(gl, readState, STATE_SIZE);

  // ── atlas (iChannel1 equivalent) ──────────────────────
  const atlasTex = makeTexture(gl, gl.RGBA, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([32, 32, 38, 255]));

  // ── programs ──────────────────────────────────────────
  const updateProg = makeProgram(gl, VS_FULLSCREEN, FS_UPDATE);
  const renderProg = makeProgram(gl, VS_RENDER, FS_RENDER);
  const dummyVao = gl.createVertexArray()!;
  const loc = (p: WebGLProgram, name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(p, name);

  // ── runtime state ─────────────────────────────────────
  let currentUrl: string | null = null;
  let currentName = "particles";
  let preset: Required<ParticlesPreset> = {
    name: "particles",
    atlas_url: "",
    atlas_size: 4,
    particle_size: 0.02,
    velocity_stretch: 2.5,
    curl_scale: 6.0,
    velocity_damp: 0.985,
    audio_gain: 1.2,
  };
  let running = true;
  const startTime = performance.now();
  let lastTime = startTime;

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

    // ── update pass ─────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, writeState, 0);
    gl.viewport(0, 0, STATE_SIZE, STATE_SIZE);
    gl.useProgram(updateProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readState);
    gl.uniform1i(loc(updateProg, "uState"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
    gl.uniform1i(loc(updateProg, "uAudio"), 1);
    gl.uniform2f(loc(updateProg, "uStateSize"), STATE_SIZE, STATE_SIZE);
    gl.uniform1f(loc(updateProg, "uTime"), t);
    gl.uniform1f(loc(updateProg, "uDt"), dt);
    gl.uniform1f(loc(updateProg, "uCurlScale"), preset.curl_scale);
    gl.uniform1f(loc(updateProg, "uVelocityDamp"), preset.velocity_damp);
    gl.uniform1f(loc(updateProg, "uAudioGain"), preset.audio_gain);
    gl.bindVertexArray(dummyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // swap state
    [readState, writeState] = [writeState, readState];

    // ── render pass ─────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(renderProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readState);
    gl.uniform1i(loc(renderProg, "uState"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(loc(renderProg, "uAtlas"), 1);
    gl.uniform2f(loc(renderProg, "uStateSize"), STATE_SIZE, STATE_SIZE);
    gl.uniform1f(loc(renderProg, "uParticleSize"), preset.particle_size);
    gl.uniform1f(loc(renderProg, "uVelocityStretch"), preset.velocity_stretch);
    gl.uniform1f(loc(renderProg, "uAtlasSize"), preset.atlas_size);
    const aspect = canvas.height / canvas.width;
    gl.uniform2f(loc(renderProg, "uAspect"), aspect, 1.0);
    gl.bindVertexArray(dummyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, PARTICLE_COUNT);

    gl.disable(gl.BLEND);

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
      // Reseed positions on each preset load so the field starts fresh.
      seedStateTexture(gl, readState, STATE_SIZE);
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

// ── helpers ────────────────────────────────────────────────────────

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

function makeStateTexture(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
  return tex;
}

function seedStateTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, size: number): void {
  const data = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    data[o] = Math.random();      // x
    data[o + 1] = Math.random();  // y
    data[o + 2] = 0;              // vx
    data[o + 3] = 0;              // vy
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, data);
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

