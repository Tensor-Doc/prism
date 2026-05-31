// gpu-detect.ts — quick check whether the browser has real GPU
// acceleration or has fallen back to a CPU rasterizer.
//
// We can't perfectly classify devices from the browser, but we can
// catch the obvious CPU-fallback cases by looking at the renderer
// string. The known software renderers are:
//
//   SwiftShader   Chrome's CPU fallback (when GPU access fails)
//   llvmpipe      Mesa software renderer (Linux, VMs)
//   WARP          Windows D3D11 software adapter
//   Software      Generic "software" tag (rare)
//
// "no-webgl" covers ancient browsers + locked-down kiosks where
// WebGL2 isn't available at all.

export type GpuTier = "gpu" | "cpu" | "no-webgl";

export interface GpuInfo {
  tier: GpuTier;
  /** The raw UNMASKED_RENDERER_WEBGL string when available. */
  renderer: string;
  /** Whether we're on a small viewport — used to caveat the warning
   *  (a phone with a real GPU can still struggle with heavy shaders). */
  mobile: boolean;
}

const SOFTWARE_MARKERS = ["swiftshader", "llvmpipe", "warp", "software"];

export function detectGpu(): GpuInfo {
  const mobile = /iPhone|Android.*Mobile|iPad/i.test(navigator.userAgent);
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    if (!gl) return { tier: "no-webgl", renderer: "", mobile };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) {
      // Renderer info is hidden (privacy mode, Firefox default). We
      // can't classify — assume GPU since that's overwhelmingly the
      // common case when WebGL2 is available.
      return { tier: "gpu", renderer: "(hidden)", mobile };
    }
    const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
    const r = renderer.toLowerCase();
    for (const marker of SOFTWARE_MARKERS) {
      if (r.includes(marker)) return { tier: "cpu", renderer, mobile };
    }
    return { tier: "gpu", renderer, mobile };
  } catch {
    return { tier: "no-webgl", renderer: "", mobile };
  }
}
