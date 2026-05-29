import type { GPUContext } from "./webgpu-init";
import type { AudioFeatures } from "../audio-features";

const UNIFORM_BYTES = 8 * 4;

const TEMPLATE_HEADER = `
struct Uniforms {
  audio: vec4f,
  t: f32,
  chaos: f32,
  has_milkdrop: f32,
  _pad: f32,
}

@group(0) @binding(0) var fluid_tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var milkdrop_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: Uniforms;
@group(0) @binding(4) var palette_tex: texture_2d<f32>;

fn sample_fluid(uv: vec2f) -> vec3f { return textureSample(fluid_tex, samp, uv).rgb; }
fn sample_milkdrop(uv: vec2f) -> vec3f { return textureSample(milkdrop_tex, samp, uv).rgb; }
fn sample_palette(uv: vec2f) -> vec3f { return textureSample(palette_tex, samp, uv).rgb; }
// sample_nasa(i, uv) -> sample image i (0..3) from the strip atlas at local uv [0,1]^2.
fn sample_nasa(i: f32, uv: vec2f) -> vec3f {
  let slot = clamp(floor(i), 0.0, 3.0);
  let local = clamp(uv, vec2f(0.0), vec2f(1.0));
  return sample_palette(vec2f((slot + local.x) * 0.25, local.y));
}
fn chaos_amt() -> f32 { return u.chaos; }
fn bass() -> f32 { return u.audio.x; }
fn mid() -> f32 { return u.audio.y; }
fn treble() -> f32 { return u.audio.z; }
fn beat() -> f32 { return u.audio.w; }
fn t_s() -> f32 { return u.t; }
fn has_milkdrop() -> f32 { return u.has_milkdrop; }

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

fn compose(uv: vec2f) -> vec3f {
`;

const TEMPLATE_FOOTER = `
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let c = compose(in.uv);
  return vec4f(c, 1.0);
}
`;

const DEFAULT_BODY = `  return sample_fluid(uv);`;

export interface CompileResult {
  ok: boolean;
  errors: string[];
}

export class Compositor {
  private readonly gpu: GPUContext;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformScratch = new Float32Array(UNIFORM_BYTES / 4);
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;

  private pipeline: GPURenderPipeline | null = null;
  private fluidView: GPUTextureView | null = null;
  private paletteView: GPUTextureView | null = null;
  private milkdropTexture: GPUTexture;
  private milkdropCanvas: HTMLCanvasElement | null = null;
  private milkdropWidth = 0;
  private milkdropHeight = 0;
  private bindGroup: GPUBindGroup | null = null;
  // 1x1 fallback so the binding is always valid even before palette is wired.
  private fallbackPaletteTexture: GPUTexture;

  constructor(gpu: GPUContext) {
    this.gpu = gpu;
    const device = gpu.device;

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Explicit layout so user shaders that don't reference all bindings
    // (e.g. "return sample_fluid(uv)" ignoring milkdrop/uniforms) still get
    // a layout with all four entries.
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.milkdropTexture = this.createMilkdropTexture(2, 2);
    this.milkdropWidth = 2;
    this.milkdropHeight = 2;

    this.fallbackPaletteTexture = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    void this.setBody(DEFAULT_BODY);
  }

  private createMilkdropTexture(w: number, h: number): GPUTexture {
    return this.gpu.device.createTexture({
      size: [w, h],
      format: this.gpu.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** Recompile the compositor with a new `compose` body. Returns errors if any. */
  async setBody(body: string): Promise<CompileResult> {
    const device = this.gpu.device;
    const code = TEMPLATE_HEADER + body + TEMPLATE_FOOTER;

    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code });
    const validationError = await device.popErrorScope();

    const info = await module.getCompilationInfo();
    const errors: string[] = info.messages
      .filter((m) => m.type === "error")
      .map((m) => `line ${m.lineNum}: ${m.message}`);
    if (validationError) errors.push(validationError.message);
    if (errors.length > 0) {
      return { ok: false, errors };
    }

    try {
      const pipeline = device.createRenderPipeline({
        layout: this.pipelineLayout,
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{ format: this.gpu.format }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.pipeline = pipeline;
      this.rebuildBindGroup();
      return { ok: true, errors: [] };
    } catch (e) {
      return { ok: false, errors: [(e as Error).message] };
    }
  }

  setFluidTexture(view: GPUTextureView): void {
    this.fluidView = view;
    this.rebuildBindGroup();
  }

  setPaletteTexture(view: GPUTextureView): void {
    this.paletteView = view;
    this.rebuildBindGroup();
  }

  setMilkdropCanvas(canvas: HTMLCanvasElement | null): void {
    this.milkdropCanvas = canvas;
    if (canvas) this.ensureMilkdropSize(canvas.width, canvas.height);
  }

  private ensureMilkdropSize(w: number, h: number): void {
    if (w === this.milkdropWidth && h === this.milkdropHeight) return;
    this.milkdropTexture.destroy();
    this.milkdropTexture = this.createMilkdropTexture(Math.max(1, w), Math.max(1, h));
    this.milkdropWidth = w;
    this.milkdropHeight = h;
    this.rebuildBindGroup();
  }

  private rebuildBindGroup(): void {
    if (!this.fluidView) return;
    const palette = this.paletteView ?? this.fallbackPaletteTexture.createView();
    this.bindGroup = this.gpu.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.fluidView },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.milkdropTexture.createView() },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
        { binding: 4, resource: palette },
      ],
    });
  }

  render(time: number, audio: AudioFeatures, chaos: number): void {
    if (!this.bindGroup || !this.pipeline) return;
    const device = this.gpu.device;

    let hasMilkdrop = 0;
    if (this.milkdropCanvas && this.milkdropCanvas.width > 0 && this.milkdropCanvas.height > 0) {
      this.ensureMilkdropSize(this.milkdropCanvas.width, this.milkdropCanvas.height);
      try {
        device.queue.copyExternalImageToTexture(
          { source: this.milkdropCanvas },
          { texture: this.milkdropTexture },
          [this.milkdropWidth, this.milkdropHeight],
        );
        hasMilkdrop = 1;
      } catch {
        hasMilkdrop = 0;
      }
    }

    this.uniformScratch[0] = audio.bass;
    this.uniformScratch[1] = audio.mid;
    this.uniformScratch[2] = audio.treble;
    this.uniformScratch[3] = audio.beat;
    this.uniformScratch[4] = time;
    this.uniformScratch[5] = chaos;
    this.uniformScratch[6] = hasMilkdrop;
    this.uniformScratch[7] = 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch);

    const encoder = device.createCommandEncoder();
    const view = this.gpu.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, 1);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
