import updateShader from "./shaders/fluid-update.wgsl?raw";
import renderShader from "./shaders/fluid-render.wgsl?raw";
import type { GPUContext } from "./webgpu-init";
import type { AudioFeatures } from "../audio-features";
import type { CompiledPreset } from "../preset";
import type { Tuning } from "../tuning";
import type { Palette } from "../palette";

const FIELD_SIZE = 512;
const EMITTER_BYTES = 48; // 12 f32s: (x, y, sigma, intensity), (r, g, b, _), (source, vortex, _, _)
const MAX_EMITTERS = 128;
const UPDATE_UNIFORM_BYTES = 20 * 4;
const RENDER_UNIFORM_BYTES = 12 * 4;
const PALETTE_W = 1024;
const PALETTE_H = 256;
const N_SLOTS = 4; // images in the strip
const MAX_STAMPS = 14;
const STAMP_BYTES = 32; // 8 floats per stamp
const STAMP_BUFFER_BYTES = MAX_STAMPS * STAMP_BYTES;

interface StampState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  lifetime: number;
  imageIdx: number;
  maxScale: number;
  rot: number;
}

export class FluidSurface {
  private readonly gpu: GPUContext;
  private readonly fieldA: GPUTexture;
  private readonly fieldB: GPUTexture;
  private readonly sampler: GPUSampler;
  private readonly emitterBuffer: GPUBuffer;
  private readonly updateUniformBuffer: GPUBuffer;
  private readonly renderUniformBuffer: GPUBuffer;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly renderPipeline: GPURenderPipeline;
  private bindGroupAB: GPUBindGroup;
  private bindGroupBA: GPUBindGroup;
  private renderBindGroupA: GPUBindGroup;
  private renderBindGroupB: GPUBindGroup;

  private readonly emitterScratch = new ArrayBuffer(MAX_EMITTERS * EMITTER_BYTES);
  private readonly emitterScratchF32 = new Float32Array(this.emitterScratch);
  private readonly updateScratch = new Float32Array(UPDATE_UNIFORM_BYTES / 4);
  private readonly updateScratchU32 = new Uint32Array(this.updateScratch.buffer);
  private readonly renderScratch = new Float32Array(RENDER_UNIFORM_BYTES / 4);

  private currentIsA = true;
  private audioTime = 0;
  private autoHue = 0;
  private readonly paletteTexture: GPUTexture;
  private paletteVersion = -1;
  private readonly stampsBuffer: GPUBuffer;
  private readonly stampsScratch: Float32Array;
  private readonly stampsScratchU32: Uint32Array;
  private readonly stamps: StampState[] = [];
  private outputTexture: GPUTexture;
  private outputWidth: number;
  private outputHeight: number;

  constructor(gpu: GPUContext, initialWidth: number, initialHeight: number) {
    this.gpu = gpu;
    const device = gpu.device;
    this.outputWidth = Math.max(1, initialWidth);
    this.outputHeight = Math.max(1, initialHeight);
    this.outputTexture = device.createTexture({
      size: [this.outputWidth, this.outputHeight],
      format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const makeField = (): GPUTexture =>
      device.createTexture({
        size: [FIELD_SIZE, FIELD_SIZE],
        format: "rgba16float",
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST,
      });

    this.fieldA = makeField();
    this.fieldB = makeField();

    this.paletteTexture = device.createTexture({
      size: [PALETTE_W, PALETTE_H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.stampsBuffer = device.createBuffer({
      size: STAMP_BUFFER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.stampsScratch = new Float32Array(MAX_STAMPS * 8);
    this.stampsScratchU32 = new Uint32Array(this.stampsScratch.buffer);

    // Initialize a pool of stamps with staggered ages so they don't all spawn/die together.
    for (let i = 0; i < MAX_STAMPS; i++) {
      this.stamps.push(this.spawnStamp(true));
      // Stagger the ages so they're at different lifecycle phases.
      this.stamps[i].age = (i / MAX_STAMPS) * this.stamps[i].lifetime;
    }

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.emitterBuffer = device.createBuffer({
      size: MAX_EMITTERS * EMITTER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.updateUniformBuffer = device.createBuffer({
      size: UPDATE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.renderUniformBuffer = device.createBuffer({
      size: RENDER_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const updateModule = device.createShaderModule({ code: updateShader });
    this.updatePipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: updateModule, entryPoint: "cs_main" },
    });

    const renderModule = device.createShaderModule({ code: renderShader });
    this.renderPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: renderModule, entryPoint: "vs_main" },
      fragment: {
        module: renderModule,
        entryPoint: "fs_main",
        targets: [{ format: gpu.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Compute bind group: reads prev, writes next. Two flavors for ping-pong.
    const makeUpdateBindGroup = (prev: GPUTexture, next: GPUTexture): GPUBindGroup =>
      device.createBindGroup({
        layout: this.updatePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: prev.createView() },
          { binding: 1, resource: next.createView() },
          { binding: 2, resource: { buffer: this.emitterBuffer } },
          { binding: 3, resource: { buffer: this.updateUniformBuffer } },
          { binding: 4, resource: this.sampler },
          { binding: 5, resource: this.paletteTexture.createView() },
          { binding: 6, resource: { buffer: this.stampsBuffer } },
        ],
      });

    this.bindGroupAB = makeUpdateBindGroup(this.fieldA, this.fieldB);
    this.bindGroupBA = makeUpdateBindGroup(this.fieldB, this.fieldA);

    const makeRenderBindGroup = (src: GPUTexture): GPUBindGroup =>
      device.createBindGroup({
        layout: this.renderPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.renderUniformBuffer } },
        ],
      });

    this.renderBindGroupA = makeRenderBindGroup(this.fieldA);
    this.renderBindGroupB = makeRenderBindGroup(this.fieldB);
  }

  private spawnStamp(initial = false): StampState {
    const lifetime = 5 + Math.random() * 4;
    return {
      x: 0.15 + Math.random() * 0.70,
      y: 0.15 + Math.random() * 0.70,
      vx: (Math.random() - 0.5) * 0.03,
      vy: (Math.random() - 0.5) * 0.03 - 0.005,
      age: initial ? 0 : 0,
      lifetime,
      imageIdx: Math.floor(Math.random() * N_SLOTS),
      maxScale: 0.16 + Math.random() * 0.18,
      rot: Math.random() * Math.PI * 2,
    };
  }

  private updateStamps(dt: number, audio: AudioFeatures): void {
    for (let i = 0; i < this.stamps.length; i++) {
      const s = this.stamps[i];
      s.age += dt;
      if (s.age >= s.lifetime) {
        this.stamps[i] = this.spawnStamp();
        continue;
      }
      // Drift with slow random walk, slight upward bias.
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // Audio nudges — bass pushes up, mid scatters sideways, treble jitters.
      s.vy -= audio.bass * 0.04 * dt;
      s.vx += (Math.random() - 0.5) * audio.mid * 0.05 * dt;
      s.vx *= 0.995;
      s.vy *= 0.995;
      // Wrap around boundaries with damping.
      if (s.x < 0.05) { s.x = 0.05; s.vx = Math.abs(s.vx) * 0.7; }
      if (s.x > 0.95) { s.x = 0.95; s.vx = -Math.abs(s.vx) * 0.7; }
      if (s.y < 0.05) { s.y = 0.05; s.vy = Math.abs(s.vy) * 0.7; }
      if (s.y > 0.95) { s.y = 0.95; s.vy = -Math.abs(s.vy) * 0.7; }
      s.rot += dt * 0.15;
    }
  }

  private packStamps(): number {
    let n = 0;
    for (let i = 0; i < this.stamps.length; i++) {
      const s = this.stamps[i];
      const lifeT = s.age / s.lifetime;
      // Smooth fade-in then fade-out across lifetime.
      const envelope = Math.sin(lifeT * Math.PI);
      if (envelope < 0.01) continue;
      const opacity = envelope;
      const scale = s.maxScale * envelope;
      const off = n * 8;
      this.stampsScratch[off + 0] = s.x;
      this.stampsScratch[off + 1] = s.y;
      this.stampsScratch[off + 2] = scale;
      this.stampsScratch[off + 3] = opacity;
      this.stampsScratchU32[off + 4] = s.imageIdx;
      this.stampsScratch[off + 5] = s.rot;
      this.stampsScratch[off + 6] = 0;
      this.stampsScratch[off + 7] = 0;
      n++;
    }
    return n;
  }

  /** Upload the palette strip to the GPU if it has changed since last upload. */
  private syncPalette(palette: Palette): void {
    if (palette.version === this.paletteVersion) return;
    const strip = palette.getStrip();
    // Copy into a fresh ArrayBuffer-backed Uint8Array (writeTexture needs strict ArrayBuffer).
    const u8 = new Uint8Array(new ArrayBuffer(strip.data.byteLength));
    u8.set(strip.data);
    this.gpu.device.queue.writeTexture(
      { texture: this.paletteTexture },
      u8,
      { bytesPerRow: strip.width * 4, rowsPerImage: strip.height },
      { width: strip.width, height: strip.height },
    );
    this.paletteVersion = palette.version;
  }

  step(
    dt: number,
    time: number,
    preset: CompiledPreset,
    audio: AudioFeatures,
    tuning: Tuning,
    palette: Palette,
  ): void {
    const device = this.gpu.device;
    this.syncPalette(palette);

    // Update + pack floating image stamps.
    this.updateStamps(dt, audio);
    const stampCount = this.packStamps();
    device.queue.writeBuffer(this.stampsBuffer, 0, this.stampsScratch.buffer as ArrayBuffer);

    // Pack emitters: x, y, sigma, intensity, r, g, b, _pad.
    this.emitterScratchF32.fill(0);
    let emitterCount = 0;
    for (let i = 0; i < preset.injections.length && emitterCount < MAX_EMITTERS; i++) {
      const inj = preset.injections[i];
      const intensity = Math.max(0, inj.intensity(audio, time));
      if (intensity < 0.005) continue;
      const x = inj.x(audio, time);
      const y = inj.y(audio, time);
      const sigma = Math.max(0.005, inj.sigma(audio, time));
      const off = emitterCount * 12;
      this.emitterScratchF32[off + 0] = x;
      this.emitterScratchF32[off + 1] = y;
      this.emitterScratchF32[off + 2] = sigma;
      this.emitterScratchF32[off + 3] = intensity;
      let cr = inj.color[0](audio, time);
      let cg = inj.color[1](audio, time);
      let cb = inj.color[2](audio, time);
      if (tuning.paint > 0.001) {
        const [pr, pg, pb] = palette.sample(x, y);
        cr = cr + (pr - cr) * tuning.paint;
        cg = cg + (pg - cg) * tuning.paint;
        cb = cb + (pb - cb) * tuning.paint;
      }
      this.emitterScratchF32[off + 4] = cr;
      this.emitterScratchF32[off + 5] = cg;
      this.emitterScratchF32[off + 6] = cb;
      this.emitterScratchF32[off + 7] = 0;
      this.emitterScratchF32[off + 8] = inj.source(audio, time);
      this.emitterScratchF32[off + 9] = inj.vortex(audio, time);
      this.emitterScratchF32[off + 10] = 0;
      this.emitterScratchF32[off + 11] = 0;
      emitterCount++;
    }
    device.queue.writeBuffer(this.emitterBuffer, 0, this.emitterScratch);

    // Update uniforms.
    this.updateScratch[0] = dt;
    this.updateScratch[1] = time;
    this.updateScratch[2] = audio.bass;
    this.updateScratch[3] = audio.mid;
    this.updateScratch[4] = audio.treble;
    this.updateScratch[5] = audio.beat;
    // Beat drives motion, not brightness: flow_strength jumps when a beat hits.
    this.updateScratch[6] = tuning.flow_strength
      + audio.bass * tuning.bass_flow
      + audio.mid * 0.08
      + audio.beat * 0.45;
    this.updateScratch[7] = tuning.flow_scale + audio.beat * 0.4;
    this.updateScratch[8] = tuning.decay;
    this.updateScratch[9] = tuning.diffusion;
    this.updateScratch[10] = tuning.inject_gain;
    this.updateScratchU32[11] = emitterCount;
    // Audio-driven time accumulator: vortex centers dance faster when music has energy.
    this.audioTime += dt * (audio.bass * 8.0 + audio.mid * 3.0 + audio.beat * 14.0) * tuning.music_motion;
    this.updateScratch[12] = tuning.gravity;
    this.updateScratch[13] = this.audioTime;
    this.updateScratch[14] = tuning.mass;
    this.updateScratch[15] = tuning.waves;
    this.updateScratch[16] = tuning.paint;
    this.updateScratchU32[17] = stampCount;
    this.updateScratch[18] = 0;
    this.updateScratch[19] = 0;
    device.queue.writeBuffer(this.updateUniformBuffer, 0, this.updateScratch.buffer);

    // Render uniforms.
    this.renderScratch[0] = audio.bass;
    this.renderScratch[1] = audio.beat;
    this.renderScratch[2] = audio.treble;
    this.renderScratch[3] = audio.rms;
    this.renderScratch[4] = tuning.slope_gain + audio.bass * 8.0 + audio.beat * tuning.beat_relief;
    this.renderScratch[5] = tuning.saturation;
    this.renderScratch[6] = tuning.chroma;
    // Auto-hue advances over time; manual hue offsets on top.
    this.autoHue = (this.autoHue + dt * tuning.hue_speed) % 1.0;
    this.renderScratch[7] = tuning.hue + this.autoHue;
    // Light direction subtly tilts with bass.
    this.renderScratch[8] = 0.3 + audio.bass * 0.2;
    this.renderScratch[9] = 0.3;
    this.renderScratch[10] = 1.0;
    this.renderScratch[11] = 0;
    device.queue.writeBuffer(this.renderUniformBuffer, 0, this.renderScratch);

    const encoder = device.createCommandEncoder();
    const updateBG = this.currentIsA ? this.bindGroupAB : this.bindGroupBA;
    const renderBG = this.currentIsA ? this.renderBindGroupB : this.renderBindGroupA;

    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.updatePipeline);
      pass.setBindGroup(0, updateBG);
      pass.dispatchWorkgroups(Math.ceil(FIELD_SIZE / 8), Math.ceil(FIELD_SIZE / 8));
      pass.end();
    }

    {
      const view = this.outputTexture.createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.renderPipeline);
      pass.setBindGroup(0, renderBG);
      pass.draw(6, 1);
      pass.end();
      // Note: the bind-group rebind is invalidated when the output texture
      // is recreated; rebindFluid is called by the host after resize.
    }

    device.queue.submit([encoder.finish()]);

    this.currentIsA = !this.currentIsA;
  }

  getOutputTextureView(): GPUTextureView {
    return this.outputTexture.createView();
  }

  /** The NASA palette atlas texture (1024x256, rgba8unorm). Shared with the compositor. */
  getPaletteTextureView(): GPUTextureView {
    return this.paletteTexture.createView();
  }

  resizeOutput(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.outputWidth && h === this.outputHeight) return;
    this.outputTexture.destroy();
    this.outputTexture = this.gpu.device.createTexture({
      size: [w, h],
      format: this.gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.outputWidth = w;
    this.outputHeight = h;
  }
}
