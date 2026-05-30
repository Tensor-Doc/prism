// shadertoy-bg.ts — render a Shadertoy-style GLSL fragment shader to a
// background canvas. Mirrors milkdrop-bg.ts's role: takes audio in,
// produces a live visual. The two backends are swapped by GraphRuntime
// based on whether the graph has a lf.milkdrop or lf.shadertoy node.
//
// Shadertoy convention: the user shader defines
//   void mainImage(out vec4 fragColor, in vec2 fragCoord)
// We wrap that with our standard uniforms:
//   iTime, iResolution, iMouse, iChannel0 (audio FFT 256x1)

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // Fullscreen triangle (no buffer needed; gl_VertexID drives positions).
  vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAGMENT_PREAMBLE = `#version 300 es
precision highp float;
precision highp int;

uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec3 iResolution;
uniform vec4 iMouse;
uniform sampler2D iChannel0;
in vec2 v_uv;
out vec4 outColor;

`;

const FRAGMENT_EPILOGUE = `

void main() {
  vec4 c;
  mainImage(c, gl_FragCoord.xy);
  outColor = vec4(c.rgb, 1.0);
}
`;

export interface ShadertoyBg {
  /** Pretty name from the source URL, useful for SKILL readout. */
  readonly presetName: string;
  /** URL of the currently-loaded shader. */
  readonly currentUrl: string | null;
  /** Connect a Web Audio source — Shadertoy's iChannel0 sees its FFT. */
  connectAudio: (node: AudioNode) => void;
  /** Fetch + compile + render a new shader. Resolves once first frame
   *  paints. Throws on compile error. */
  loadFromUrl: (url: string) => Promise<string>;
  /** Pause the render loop + free GL resources. */
  destroy: () => void;
}

export function createShadertoyBackground(
  audioCtx: AudioContext,
  canvas: HTMLCanvasElement,
  silentSource: AudioNode,
): ShadertoyBg {
  const glOrNull = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!glOrNull) throw new Error("WebGL2 not available");
  const gl: WebGL2RenderingContext = glOrNull;

  const sizeTo = (w: number, h: number): void => {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  };
  sizeTo(window.innerWidth, window.innerHeight);

  // Audio analyser → 256-bin FFT texture for iChannel0.
  let audioSource: AudioNode = silentSource;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512; // 256 frequency bins
  audioSource.connect(analyser);
  const fftBytes = new Uint8Array(256);
  const audioTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, audioTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // WebGL2 single-channel texture: R8 internal + RED format. LUMINANCE
  // is deprecated and unreliable in WebGL2 / GLSL 300 es shaders.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);

  const dummyVao = gl.createVertexArray()!; // needed for vertexAttrib-less rendering

  let currentProgram: WebGLProgram | null = null;
  let currentUrl: string | null = null;
  let currentName = "—";
  const startTime = performance.now();
  let lastFrameTime = startTime;
  let frame = 0;
  let mouseX = 0;
  let mouseY = 0;
  let mouseDown = false;
  let running = true;

  function compile(type: GLenum, src: string): WebGLShader {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? "(no log)";
      gl.deleteShader(sh);
      throw new Error(`GLSL compile error:\n${log}\n--- source ---\n${numberLines(src)}`);
    }
    return sh;
  }

  function numberLines(src: string): string {
    return src.split("\n").map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join("\n");
  }

  function link(userSource: string): WebGLProgram {
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_PREAMBLE + userSource + FRAGMENT_EPILOGUE);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? "(no log)";
      gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog);
      throw new Error(`Shader link error: ${log}`);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    return prog;
  }

  function frameLoop(): void {
    if (!running) return;
    const now = performance.now();
    const iTime = (now - startTime) * 0.001;
    const iTimeDelta = (now - lastFrameTime) * 0.001;
    lastFrameTime = now;
    frame++;

    analyser.getByteFrequencyData(fftBytes);
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, fftBytes);

    if (currentProgram) {
      gl.useProgram(currentProgram);
      const loc = (name: string): WebGLUniformLocation | null =>
        gl.getUniformLocation(currentProgram!, name);
      gl.uniform1f(loc("iTime"), iTime);
      gl.uniform1f(loc("iTimeDelta"), iTimeDelta);
      gl.uniform1i(loc("iFrame"), frame);
      gl.uniform3f(loc("iResolution"), canvas.width, canvas.height, 1.0);
      gl.uniform4f(loc("iMouse"), mouseX, canvas.height - mouseY, mouseDown ? 1 : 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, audioTex);
      gl.uniform1i(loc("iChannel0"), 0);
      gl.bindVertexArray(dummyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  const onResize = (): void => sizeTo(window.innerWidth, window.innerHeight);
  const onPointerMove = (e: PointerEvent): void => { mouseX = e.clientX; mouseY = e.clientY; };
  const onPointerDown = (): void => { mouseDown = true; };
  const onPointerUp = (): void => { mouseDown = false; };
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });

  return {
    get presetName(): string { return currentName; },
    get currentUrl(): string | null { return currentUrl; },
    connectAudio: (node) => {
      audioSource.disconnect();
      audioSource = node;
      audioSource.connect(analyser);
    },
    loadFromUrl: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
      const src = await res.text();
      const prog = link(src);
      if (currentProgram) gl.deleteProgram(currentProgram);
      currentProgram = prog;
      currentUrl = url;
      currentName = url.split("/").pop()?.replace(/\.glsl$/, "") ?? url;
      return currentName;
    },
    destroy: () => {
      running = false;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      if (currentProgram) gl.deleteProgram(currentProgram);
      gl.deleteTexture(audioTex);
      gl.deleteVertexArray(dummyVao);
    },
  };
}
