// slideshow.ts — image cycle driven by GL transition shaders.
//
//   hold (3s)          image floats centered as a card
//   transition (≈1.2s) one of N GL transitions runs, with progress 0→1
//   → re-sample, advance to the next transition, repeat
//
// The "to" texture in every transition is treated as transparent so the
// milkdrop background shows through as the image transitions away. Each
// cycle picks the next shader from TRANSITIONS so the slideshow rotates
// through visual flavours just like the milkdrop preset rotation.

import type { ImageSlots } from "./image-sources/slots";
import { PASS_THROUGH, TRANSITIONS, type TransitionDef } from "./transitions";

const HOLD_MS = 3000;

const IMG_MAX_W = 0.58;
const IMG_MAX_H = 0.54;
const IMG_TOP   = 0.16;

// Collapsed-thumb position + size (upper-right of viewport, below status bar).
const THUMB_W = 200;
const THUMB_H = THUMB_W * (9 / 16);
const THUMB_MARGIN = 16;
const STATUS_BAR_H = 36;

type Phase = "idle" | "hold" | "transition";

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 vUv;
void main() {
  // a_position is a [-1,1] full-quad. Map to [0,1] for sampling, then flip Y
  // so the image is right-side up when the source canvas has Y-down origin.
  vUv = vec2((a_position.x + 1.0) * 0.5, 1.0 - (a_position.y + 1.0) * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

class GLRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly vbo: WebGLBuffer;
  private readonly vertexShader: WebGLShader;
  // Two textures — at any moment one is "current" (the held image) and the
  // other is "next" (the upcoming image). The currentIsA flag tracks which
  // is which; after a transition the flag flips, so the texture we were
  // transitioning *to* is now the new current, and the previous current is
  // freed for the next sample.
  private readonly texA: WebGLTexture;
  private readonly texB: WebGLTexture;
  private currentIsA = true;

  private readonly programs = new Map<string, WebGLProgram>();
  private activeName = "";

  // Cached attrib / uniform locations per program
  private cache = new Map<
    string,
    {
      posLoc: number;
      fromLoc: WebGLUniformLocation | null;
      toLoc: WebGLUniformLocation | null;
      progressLoc: WebGLUniformLocation | null;
      resLoc: WebGLUniformLocation | null;
    }
  >();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      // True so the rendered transition pixels remain readable by
      // another GL context after the browser composites. Required for
      // the shader-feed pump in main.ts to sample this canvas every
      // frame and pipe it into the shader's iChannel1.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Vertex shader (shared)
    this.vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);

    // Full-screen quad — two triangles in NDC.
    const buf = gl.createBuffer();
    if (!buf) throw new Error("Failed to allocate VBO");
    this.vbo = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    // Two textures (current / next). Initial 1×1 transparent placeholder so
    // both samplers are always valid even before the first image lands.
    this.texA = this.makeTexture(gl);
    this.texB = this.makeTexture(gl);
  }

  private makeTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) throw new Error("Failed to allocate texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    return tex;
  }

  registerTransition(def: TransitionDef): void {
    const gl = this.gl;
    if (this.programs.has(def.name)) return;
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, def.fragmentShader);
    const prog = gl.createProgram();
    if (!prog) throw new Error("Failed to create program");
    gl.attachShader(prog, this.vertexShader);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[slideshow] link failed for", def.name, gl.getProgramInfoLog(prog));
    }
    this.programs.set(def.name, prog);
    this.cache.set(def.name, {
      posLoc: gl.getAttribLocation(prog, "a_position"),
      fromLoc: gl.getUniformLocation(prog, "fromTex"),
      toLoc: gl.getUniformLocation(prog, "toTex"),
      progressLoc: gl.getUniformLocation(prog, "progress"),
      resLoc: gl.getUniformLocation(prog, "resolution"),
    });
  }

  setActive(name: string): void { this.activeName = name; }

  /** Upload into the texture that will be sampled as `from` next render. */
  uploadCurrent(source: TexImageSource): void {
    this.uploadTo(this.currentIsA ? this.texA : this.texB, source);
  }

  /** Upload into the texture that will be sampled as `to` next render. */
  uploadNext(source: TexImageSource): void {
    this.uploadTo(this.currentIsA ? this.texB : this.texA, source);
  }

  /** After a transition completes, swap so the previous "next" becomes the
   *  new "current" and the previous "current" is free for the next sample. */
  swapCurrent(): void { this.currentIsA = !this.currentIsA; }

  private uploadTo(tex: WebGLTexture, source: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  resize(pxW: number, pxH: number): void {
    const gl = this.gl;
    if (gl.canvas.width !== pxW) gl.canvas.width = pxW;
    if (gl.canvas.height !== pxH) gl.canvas.height = pxH;
  }

  /** Render with the active program. rectPx = image rect in raw pixel units
   *  (already DPR-scaled). Outside the rect the canvas stays transparent. */
  render(progress: number, rectPx: { x: number; y: number; w: number; h: number }): void {
    const gl = this.gl;
    const prog = this.programs.get(this.activeName);
    const refs = this.cache.get(this.activeName);
    if (!prog || !refs) return;

    // Clear full canvas first so areas outside the rect are transparent.
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Render into the image rect only (Y flipped: WebGL origin is bottom-left).
    const ch = gl.canvas.height;
    gl.viewport(
      Math.floor(rectPx.x),
      Math.floor(ch - rectPx.y - rectPx.h),
      Math.floor(rectPx.w),
      Math.floor(rectPx.h),
    );

    gl.useProgram(prog);
    const fromTex = this.currentIsA ? this.texA : this.texB;
    const toTex = this.currentIsA ? this.texB : this.texA;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fromTex);
    if (refs.fromLoc) gl.uniform1i(refs.fromLoc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, toTex);
    if (refs.toLoc) gl.uniform1i(refs.toLoc, 1);
    if (refs.progressLoc) gl.uniform1f(refs.progressLoc, progress);
    if (refs.resLoc) gl.uniform2f(refs.resLoc, rectPx.w, rectPx.h);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(refs.posLoc);
    gl.vertexAttribPointer(refs.posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("[slideshow] compile failed", gl.getShaderInfoLog(shader), "\n", src);
  }
  return shader;
}

export class Slideshow {
  private readonly slots: ImageSlots;
  private readonly slotIndex: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly progressEl: HTMLElement;
  private readonly gl: GLRenderer;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);

  private phase: Phase = "idle";
  private phaseStart = 0;
  private cycleTimer: number | null = null;
  private rafHandle = 0;
  private running = false;
  private hasCurrent = false;

  private w = 0;
  private h = 0;
  private transitionIndex = -1;
  private currentTransition: TransitionDef = PASS_THROUGH;

  // Mutable card rect — drag/resize updates this in CSS pixels. Render
  // reads it each frame, so visual changes are immediate.
  public readonly cardRect = { x: 0, y: 0, w: 0, h: 0 };
  private cardInitialised = false;
  private collapsed = false;
  // Pre-collapse rect, restored on expand.
  private uncollapsedRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Called whenever the card rect / collapsed state mutates — so the
   *  overlay in main.ts can mirror it. */
  public onCardChanged: (() => void) | null = null;

  constructor(slots: ImageSlots, slotIndex: number, canvas: HTMLCanvasElement, progress: HTMLElement) {
    this.slots = slots;
    this.slotIndex = slotIndex;
    this.canvas = canvas;
    this.progressEl = progress;
    this.gl = new GLRenderer(canvas);

    // Register the pass-through + every rotating transition.
    this.gl.registerTransition(PASS_THROUGH);
    for (const t of TRANSITIONS) this.gl.registerTransition(t);

    this.resize();
    window.addEventListener("resize", this.resize, { passive: true });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runCycle();
    this.loop();
  }

  stop(): void {
    this.running = false;
    this.hasCurrent = false;
    if (this.cycleTimer != null) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.phase = "idle";
    this.progressEl.style.transition = "none";
    this.progressEl.style.width = "0%";
    this.canvas.style.opacity = "0";
    this.canvas.classList.remove("is-melting");
    // Single render to clear the canvas to transparent.
    this.gl.render(0, { x: 0, y: 0, w: 1, h: 1 });
  }

  private resize = (): void => {
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.gl.resize(Math.floor(this.w * this.dpr), Math.floor(this.h * this.dpr));
    if (!this.cardInitialised) {
      Object.assign(this.cardRect, this.defaultRect());
      this.cardInitialised = true;
      this.onCardChanged?.();
    } else if (this.collapsed) {
      // Re-anchor the thumb to the new upper-right corner.
      Object.assign(this.cardRect, this.thumbRect());
      this.onCardChanged?.();
    }
  };

  /** Default centered rect — used at first init / after disconnect. */
  private defaultRect(): { x: number; y: number; w: number; h: number } {
    const src = this.slots.canvas(this.slotIndex);
    const aspect = src.width / Math.max(1, src.height);
    let rw = this.w * IMG_MAX_W;
    let rh = rw / aspect;
    const maxH = this.h * IMG_MAX_H;
    if (rh > maxH) { rh = maxH; rw = rh * aspect; }
    return { x: (this.w - rw) / 2, y: this.h * IMG_TOP, w: rw, h: rh };
  }

  private thumbRect(): { x: number; y: number; w: number; h: number } {
    return {
      x: this.w - THUMB_W - THUMB_MARGIN,
      y: STATUS_BAR_H + THUMB_MARGIN,
      w: THUMB_W,
      h: THUMB_H,
    };
  }

  // ── Public card manipulation API ──────────────────────────
  isCollapsed(): boolean { return this.collapsed; }

  setCardRect(next: { x: number; y: number; w: number; h: number }): void {
    Object.assign(this.cardRect, next);
    this.onCardChanged?.();
  }

  collapseCard(): void {
    if (this.collapsed) return;
    this.uncollapsedRect = { ...this.cardRect };
    Object.assign(this.cardRect, this.thumbRect());
    this.collapsed = true;
    this.onCardChanged?.();
  }

  expandCard(): void {
    if (!this.collapsed) return;
    Object.assign(this.cardRect, this.uncollapsedRect ?? this.defaultRect());
    this.collapsed = false;
    this.onCardChanged?.();
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;

    // First cycle: sample the initial "current" image. After that, the
    // previous transition's "next" has been swapped into current already.
    if (!this.hasCurrent) {
      const ok = await this.slots.refresh(this.slotIndex);
      if (!ok) {
        this.cycleTimer = window.setTimeout(() => { void this.runCycle(); }, 1000);
        return;
      }
      this.gl.uploadCurrent(this.slots.canvas(this.slotIndex));
      this.hasCurrent = true;
    }

    this.canvas.style.opacity = "1";

    // HOLD: render the current image (passthrough at progress 0).
    this.gl.setActive(PASS_THROUGH.name);
    this.phase = "hold";
    this.phaseStart = performance.now();
    this.animateProgress(HOLD_MS);

    // Begin loading the next image during the hold — when the hold ends,
    // we await this so the transition only starts once the next image is
    // actually ready.
    const nextReady = this.sampleNext();

    this.cycleTimer = window.setTimeout(() => {
      void (async () => {
        const ok = await nextReady;
        if (!this.running) return;
        if (!ok) {
          // Couldn't get a next image — stay on current, retry shortly.
          this.cycleTimer = window.setTimeout(() => { void this.runCycle(); }, 1000);
          return;
        }
        // Pick the next transition in the rotation.
        this.transitionIndex = (this.transitionIndex + 1) % TRANSITIONS.length;
        this.currentTransition = TRANSITIONS[this.transitionIndex];
        this.gl.setActive(this.currentTransition.name);
        this.phase = "transition";
        this.phaseStart = performance.now();

        this.cycleTimer = window.setTimeout(() => {
          // Transition done — the previous "next" texture is now current.
          this.gl.swapCurrent();
          void this.runCycle();
        }, this.currentTransition.durationMs);
      })();
    }, HOLD_MS);
  }

  private async sampleNext(): Promise<boolean> {
    const ok = await this.slots.refresh(this.slotIndex);
    if (!ok) return false;
    this.gl.uploadNext(this.slots.canvas(this.slotIndex));
    return true;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.render();
    this.rafHandle = requestAnimationFrame(this.loop);
  };

  private render(): void {
    if (this.phase === "idle") return;

    const dpr = this.dpr;
    const rectPx = {
      x: this.cardRect.x * dpr,
      y: this.cardRect.y * dpr,
      w: this.cardRect.w * dpr,
      h: this.cardRect.h * dpr,
    };

    let progress = 0;
    if (this.phase === "transition") {
      const elapsed = performance.now() - this.phaseStart;
      progress = Math.min(1, elapsed / this.currentTransition.durationMs);
    }

    this.gl.render(progress, rectPx);
  }

  private animateProgress(durMs: number): void {
    const el = this.progressEl;
    el.style.transition = "none";
    el.style.width = "0%";
    void el.offsetWidth;
    el.style.transition = `width ${durMs}ms linear`;
    el.style.width = "100%";
  }
}
