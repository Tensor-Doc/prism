import updateShader from "./shaders/update.wgsl?raw";
import renderShader from "./shaders/render.wgsl?raw";
import type { GPUContext } from "./webgpu-init";
import type { AudioFeatures } from "../audio-features";
import type { CompiledPreset } from "../preset";

const PARTICLE_BYTES = 32;
const EMITTER_BYTES = 32;
const MAX_PARTICLES = 1_500_000;
const MAX_EMITTERS = 32;
const UPDATE_UNIFORM_BYTES = 16 * 4;
const RENDER_UNIFORM_BYTES = 8 * 4;

export class ParticleSystem {
  private readonly gpu: GPUContext;
  private readonly particleBuffer: GPUBuffer;
  private readonly emitterBuffer: GPUBuffer;
  private readonly updateUniformBuffer: GPUBuffer;
  private readonly renderUniformBuffer: GPUBuffer;
  private readonly updatePipeline: GPUComputePipeline;
  private readonly renderPipeline: GPURenderPipeline;
  private readonly updateBindGroup: GPUBindGroup;
  private readonly renderBindGroup: GPUBindGroup;

  private readonly emitterScratch = new ArrayBuffer(MAX_EMITTERS * EMITTER_BYTES);
  private readonly emitterScratchF32 = new Float32Array(this.emitterScratch);
  private readonly emitterScratchU32 = new Uint32Array(this.emitterScratch);
  private readonly updateScratch = new ArrayBuffer(UPDATE_UNIFORM_BYTES);
  private readonly updateScratchF32 = new Float32Array(this.updateScratch);
  private readonly updateScratchU32 = new Uint32Array(this.updateScratch);
  private readonly renderScratch = new Float32Array(RENDER_UNIFORM_BYTES / 4);

  private spawnOffset = 0;

  constructor(gpu: GPUContext) {
    this.gpu = gpu;
    const device = gpu.device;

    this.particleBuffer = device.createBuffer({
      size: MAX_PARTICLES * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(this.particleBuffer.getMappedRange()).fill(0);
    this.particleBuffer.unmap();

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
        targets: [{
          format: gpu.format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.updateBindGroup = device.createBindGroup({
      layout: this.updatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.emitterBuffer } },
        { binding: 2, resource: { buffer: this.updateUniformBuffer } },
      ],
    });

    this.renderBindGroup = device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.renderUniformBuffer } },
      ],
    });
  }

  step(
    dt: number,
    time: number,
    preset: CompiledPreset,
    audio: AudioFeatures,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    const device = this.gpu.device;

    const phys = preset.physics;

    // Pack emitters from preset injections.
    this.emitterScratchF32.fill(0);
    let totalSpawn = 0;
    let emitterCount = 0;

    for (let i = 0; i < preset.injections.length && emitterCount < MAX_EMITTERS; i++) {
      const inj = preset.injections[i];
      const x = inj.x(audio, time);
      const y = inj.y(audio, time);
      const intensity = Math.max(0, Math.min(1.5, inj.intensity(audio, time)));
      const sigma = Math.max(0.001, inj.sigma(audio, time));
      const spawnCount = Math.floor(intensity * phys.spawn_rate);
      if (spawnCount === 0) continue;

      const off = emitterCount * 8;
      this.emitterScratchF32[off + 0] = x;
      this.emitterScratchF32[off + 1] = y;
      this.emitterScratchF32[off + 2] = sigma;
      this.emitterScratchU32[off + 3] = spawnCount;
      this.emitterScratchF32[off + 4] = inj.color[0](audio, time);
      this.emitterScratchF32[off + 5] = inj.color[1](audio, time);
      this.emitterScratchF32[off + 6] = inj.color[2](audio, time);
      this.emitterScratchF32[off + 7] = 1.0;

      totalSpawn += spawnCount;
      emitterCount++;
    }

    if (totalSpawn > MAX_PARTICLES) totalSpawn = MAX_PARTICLES;

    device.queue.writeBuffer(this.emitterBuffer, 0, this.emitterScratch);

    // Update uniforms.
    this.updateScratchF32[0] = dt;
    this.updateScratchF32[1] = time;
    this.updateScratchF32[2] = phys.flow_strength + audio.bass * phys.bass_flow_coupling;
    this.updateScratchF32[3] = phys.flow_scale;
    this.updateScratchF32[4] = audio.bass;
    this.updateScratchF32[5] = audio.mid;
    this.updateScratchF32[6] = audio.treble;
    this.updateScratchF32[7] = audio.rms;
    this.updateScratchU32[8] = MAX_PARTICLES;
    this.updateScratchU32[9] = emitterCount;
    this.updateScratchU32[10] = this.spawnOffset;
    this.updateScratchU32[11] = totalSpawn;
    this.updateScratchF32[12] = phys.damping;
    this.updateScratchF32[13] = phys.max_age;
    this.updateScratchF32[14] = audio.beat;
    this.updateScratchF32[15] = 0;
    device.queue.writeBuffer(this.updateUniformBuffer, 0, this.updateScratch);

    this.spawnOffset = (this.spawnOffset + totalSpawn) % MAX_PARTICLES;

    // Render uniforms.
    this.renderScratch[0] = canvasWidth;
    this.renderScratch[1] = canvasHeight;
    this.renderScratch[2] = phys.particle_size;
    this.renderScratch[3] = phys.max_age;
    this.renderScratch[4] = audio.bass;
    this.renderScratch[5] = audio.beat;
    this.renderScratch[6] = audio.treble;
    this.renderScratch[7] = 0;
    device.queue.writeBuffer(this.renderUniformBuffer, 0, this.renderScratch);

    const encoder = device.createCommandEncoder();

    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.updatePipeline);
      pass.setBindGroup(0, this.updateBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_PARTICLES / 64));
      pass.end();
    }

    {
      const view = this.gpu.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.renderPipeline);
      pass.setBindGroup(0, this.renderBindGroup);
      pass.draw(6, MAX_PARTICLES);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }
}
