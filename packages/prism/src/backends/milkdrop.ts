// milkdrop.ts — boot a butterchurn (Milkdrop) visualizer onto a caller-
// supplied canvas. Picks a random preset on each load. Starts on a silent
// source so the visual runs without audio; the caller can call connectAudio()
// later when real audio is shared.

import butterchurnRaw from "butterchurn";
import butterchurnPresetsRaw from "butterchurn-presets";
import * as milkdropConverterRaw from "milkdrop-preset-converter";
const milkdropConverter = milkdropConverterRaw as unknown as {
  convertPreset: (text: string) => Promise<unknown>;
};

interface VisualizerHandle {
  connectAudio(node: AudioNode): void;
  loadPreset(preset: unknown, blendTime?: number): void;
  setRendererSize(w: number, h: number): void;
  render(): void;
  loadExtraImages(images: Record<string, { data: string }>): void;
}
interface ButterchurnAPI {
  createVisualizer(
    ctx: AudioContext,
    canvas: HTMLCanvasElement,
    opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
  ): VisualizerHandle;
}
interface PresetsAPI {
  getPresets(): Record<string, unknown>;
}

function unwrap<T>(mod: unknown): T {
  const m = mod as { default?: T };
  return (m && typeof m === "object" && "default" in m ? (m.default as T) : (mod as T));
}
const butterchurn = unwrap<ButterchurnAPI>(butterchurnRaw);
const butterchurnPresets = unwrap<PresetsAPI>(butterchurnPresetsRaw);

export interface MilkdropBg {
  /** Pretty name of the currently-loaded preset (live; updates on rotation). */
  readonly presetName: string;
  /** Raw preset key (matches catalog `preset_id`). Stable for share / API use. */
  readonly currentPresetId: string;
  /** Swap the audio source — call when real tab-audio comes in. */
  connectAudio: (node: AudioNode) => void;
  /** Load a new random preset (with a blend transition). Returns the
   *  pretty name of the newly-loaded preset. */
  loadRandom: (blendSeconds?: number) => string;
  /** Load a specific preset by its raw key (matches catalog `preset_id`).
   *  Returns the pretty name on success; `null` if no preset with that key
   *  exists in the bundled library. */
  loadByName: (name: string, blendSeconds?: number) => string | null;
  /** Load a .milk preset from a URL: fetch text → convertPreset → loadPreset.
   *  Used for the 526 favorites and future contributor uploads which live
   *  at public/presets/milkdrop/<slug>.milk. Returns the pretty name on
   *  success; throws on fetch / parse error so callers can surface it. */
  loadFromUrl: (url: string, blendSeconds?: number) => Promise<string>;
  /** Override the preset's flow-center coords (cx, cy) every frame.
   *  Pass null on either axis to release that override. Values are 0..1
   *  (0.5, 0.5 = canvas center; (0,0) = top-left). Persists across
   *  preset swaps. Implemented as a one-time prototype patch on
   *  butterchurn's PresetEquationRunner that runs *after* the preset's
   *  per_frame eqs, so it wins regardless of what the preset writes. */
  setCxCy: (cx: number | null, cy: number | null) => void;
  destroy: () => void;
}

export interface MilkdropBgOptions {
  /** Preset key to load on cold open. Falls back to a random pick if the
   *  name doesn't exist in the bundle. Lets the landing pin a curated
   *  "atelier" default instead of getting random_$$$ Royal Mashup. */
  initialPresetName?: string;
}

export function createMilkdropBackground(
  audioCtx: AudioContext,
  canvas: HTMLCanvasElement,
  silentSource: AudioNode,
  onReady?: () => void,
  options: MilkdropBgOptions = {},
): MilkdropBg {
  // Size canvas to viewport (raw pixels — butterchurn does its own DPR math via pixelRatio).
  const sizeTo = (w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
  };
  sizeTo(window.innerWidth, window.innerHeight);

  const visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
    textureRatio: 1,
  });
  visualizer.connectAudio(silentSource);

  // Per-preset texture loading. Most milkdrop presets reference 0-3
  // textures; loading all 86 up front was hugely wasteful. Instead we
  // scan each preset's shader source for `sampler_<name>` references
  // and fetch just those, caching the dataURLs so a preset that
  // re-uses a texture pays zero cost the second time.
  const loadedSamplerNames = new Set<string>();
  let manifestPromise: Promise<Record<string, string>> | null = null;
  function getManifest(): Promise<Record<string, string>> {
    if (!manifestPromise) {
      manifestPromise = fetch("/textures/index.json")
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return manifestPromise;
  }
  async function ensureTexturesForPreset(presetData: unknown): Promise<void> {
    const wanted = scanSamplerNames(presetData);
    const toLoad: string[] = [];
    for (const name of wanted) {
      if (loadedSamplerNames.has(name)) continue;
      if (BUILTIN_SAMPLER_NAMES.has(name)) {
        loadedSamplerNames.add(name);
        continue;
      }
      toLoad.push(name);
    }
    if (toLoad.length === 0) return;
    const manifest = await getManifest();
    const loaded: Record<string, { data: string }> = {};
    await Promise.all(
      toLoad.map(async (name) => {
        try {
          if (PROCEDURAL_SAMPLER_NAMES.has(name)) {
            loaded[name] = { data: generateProceduralTexture(name) };
            return;
          }
          const filename = manifest[name];
          if (!filename) return;
          const r = await fetch(`/textures/${encodeURIComponent(filename)}`);
          if (!r.ok) return;
          const blob = await r.blob();
          loaded[name] = { data: await blobToDataUrl(blob) };
        } catch (err) {
          console.warn(`[milkdrop] texture ${name} failed:`, err);
        }
      }),
    );
    if (Object.keys(loaded).length > 0) {
      visualizer.loadExtraImages(loaded);
    }
    for (const n of toLoad) loadedSamplerNames.add(n);
  }

  // Pick the curated default if it exists in the bundle; otherwise random.
  const presetMap = butterchurnPresets.getPresets();
  const names = Object.keys(presetMap);
  let currentRaw: string;
  const requested = options.initialPresetName;
  const requestedKey = requested ? findPresetKey(names, requested) : null;
  if (requestedKey) {
    currentRaw = requestedKey;
  } else {
    currentRaw = names[Math.floor(Math.random() * names.length)];
  }
  // Cold-open: load textures the curated default needs, then the
  // preset. ensureTextures returns immediately for presets that
  // don't reference any extras (the common case).
  void ensureTexturesForPreset(presetMap[currentRaw]).then(() => {
    visualizer.loadPreset(presetMap[currentRaw], 0);
  });

  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    sizeTo(w, h);
    visualizer.setRendererSize(w, h);
  };
  window.addEventListener("resize", onResize, { passive: true });

  // ── cx/cy override ──────────────────────────────────────────
  // Butterchurn's PresetEquationRunner writes cx/cy into mdVSFrame
  // during runFrameEquations(). The warp pass reads them right after.
  // To override from outside, we patch the runner's prototype once so
  // every preset's per_frame eqs run, then our values stomp the result.
  // Lazy: the runner only exists after the first preset loads, so we
  // try to patch on each render until it succeeds, then no-op forever.
  let overrideCx: number | null = null;
  let overrideCy: number | null = null;
  let prototypePatched = false;
  const tryPatchPrototype = (): void => {
    if (prototypePatched) return;
    const vAny = visualizer as unknown as {
      renderer?: { presetEquationRunner?: object };
    };
    const runner = vAny.renderer?.presetEquationRunner;
    if (!runner) return;
    const proto = Object.getPrototypeOf(runner) as {
      runFrameEquations: (globalVars: unknown) => void;
      __prismPatched?: boolean;
    };
    if (proto.__prismPatched) {
      prototypePatched = true;
      return;
    }
    const original = proto.runFrameEquations;
    proto.runFrameEquations = function patched(
      this: { mdVSFrame?: Record<string, number> },
      globalVars: unknown,
    ): void {
      original.call(this, globalVars);
      if (this.mdVSFrame) {
        if (overrideCx !== null) this.mdVSFrame.cx = overrideCx;
        if (overrideCy !== null) this.mdVSFrame.cy = overrideCy;
      }
    };
    proto.__prismPatched = true;
    prototypePatched = true;
  };

  let running = true;
  let firstFrame = true;
  const loop = (): void => {
    if (!running) return;
    if (!prototypePatched) tryPatchPrototype();
    visualizer.render();
    if (firstFrame) {
      firstFrame = false;
      // Defer slightly so the canvas actually has paint before consumers
      // remove their "loading" UI — gives a smoother transition.
      window.setTimeout(() => onReady?.(), 0);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const pickNew = (): string => {
    // avoid immediately re-picking the same preset
    if (names.length < 2) return currentRaw;
    let next = currentRaw;
    while (next === currentRaw) next = names[Math.floor(Math.random() * names.length)];
    return next;
  };

  return {
    get presetName(): string { return prettyPresetName(currentRaw); },
    get currentPresetId(): string { return currentRaw; },
    connectAudio: (node) => visualizer.connectAudio(node),
    loadRandom: (blendSeconds = 2.5) => {
      const next = pickNew();
      const data = presetMap[next];
      void ensureTexturesForPreset(data).then(() => {
        visualizer.loadPreset(data, blendSeconds);
      });
      currentRaw = next;
      return prettyPresetName(next);
    },
    loadByName: (name, blendSeconds = 2.5) => {
      const key = findPresetKey(names, name);
      if (!key) return null;
      const data = presetMap[key];
      void ensureTexturesForPreset(data).then(() => {
        visualizer.loadPreset(data, blendSeconds);
      });
      currentRaw = key;
      return prettyPresetName(key);
    },
    loadFromUrl: async (url, blendSeconds = 2.5) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
      }
      const milkText = await res.text();
      const converted = await milkdropConverter.convertPreset(milkText);
      await ensureTexturesForPreset(converted);
      visualizer.loadPreset(converted, blendSeconds);
      // Display name is derived from the URL's last path segment.
      const stem = url.split("/").pop()?.replace(/\.milk$/, "") ?? url;
      currentRaw = stem;
      return prettyPresetName(stem);
    },
    setCxCy: (cx, cy) => {
      overrideCx = cx;
      overrideCy = cy;
    },
    destroy: () => {
      running = false;
      window.removeEventListener("resize", onResize);
    },
  };
}

/** Scan a converted milkdrop preset object for `sampler_<name>`
 *  references in any of its shader source fields. Returns the
 *  lowercase names of textures the preset will actually try to
 *  sample, so we only load those instead of the entire 86-texture
 *  pack. */
function scanSamplerNames(preset: unknown): Set<string> {
  const names = new Set<string>();
  if (!preset || typeof preset !== "object") return names;
  const p = preset as Record<string, unknown>;
  const sources: string[] = [];
  for (const field of ["warp", "comp", "warp_eqs_str", "comp_eqs_str",
                        "init_eqs_str", "frame_eqs_str", "pixel_eqs_str"]) {
    const v = p[field];
    if (typeof v === "string") sources.push(v);
  }
  // Butterchurn-presets bundled objects sometimes nest the warp/comp
  // strings inside a `compiledEqs` or `presetText` field. Walk one
  // level deeper for those.
  for (const v of Object.values(p)) {
    if (typeof v === "string" && v.includes("sampler_")) sources.push(v);
  }
  const regex = /sampler_([a-z_0-9]+)/gi;
  for (const src of sources) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src)) !== null) {
      names.add(m[1].toLowerCase());
    }
  }
  return names;
}

/** Butterchurn ships these six textures inside its own bundle, so we
 *  never need to fetch or generate them ourselves. Plus the framebuffer
 *  sampler names that aren't textures at all — they're the preset's
 *  own previous-frame buffers and blur levels. */
const BUILTIN_SAMPLER_NAMES = new Set([
  "cells", "lichen", "mage", "prayerwheel", "seaweed", "smalltiled_lizard_scales",
  "main", "pw_main", "pc_main", "fc_main", "fw_main",
  "blur1", "blur2", "blur3",
]);

/** Noise textures Milkdrop generates at runtime. We do the same via
 *  canvas + putImageData, on demand and cached after first generation. */
const PROCEDURAL_SAMPLER_NAMES = new Set([
  "noise_lq", "pw_noise_lq",
  "noise_mq", "pw_noise_mq",
  "noise_hq", "pw_noise_hq",
  "rand00", "rand01", "rand02",
]);

function generateProceduralTexture(name: string): string {
  if (name === "noise_lq" || name === "pw_noise_lq") return randomNoiseDataUrl(256, 256, 1);
  if (name === "noise_mq" || name === "pw_noise_mq") return smoothNoiseDataUrl(16, 64);
  if (name === "noise_hq" || name === "pw_noise_hq") return smoothNoiseDataUrl(8, 32);
  if (name === "rand00") return randomNoiseDataUrl(256, 256, 2);
  if (name === "rand01") return randomNoiseDataUrl(256, 256, 3);
  if (name === "rand02") return randomNoiseDataUrl(256, 256, 4);
  return "";
}

/** Fill a canvas with seeded pseudo-random RGBA pixels and return a
 *  PNG dataURL. The seed lets Milkdrop's three rand0X textures be
 *  deterministic per session. */
function randomNoiseDataUrl(w: number, h: number, seed: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const rand = mulberry32(seed * 0x9E3779B9);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (rand() * 256) | 0;
    img.data[i + 1] = (rand() * 256) | 0;
    img.data[i + 2] = (rand() * 256) | 0;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Render random noise at `lowRes`x`lowRes`, then upscale to
 *  `outRes`x`outRes` with high-quality smoothing. This approximates
 *  Milkdrop's cubic-filtered medium/high quality noise textures. */
function smoothNoiseDataUrl(lowRes: number, outRes: number): string {
  const lowCanvas = document.createElement("canvas");
  lowCanvas.width = lowCanvas.height = lowRes;
  const lowCtx = lowCanvas.getContext("2d")!;
  const img = lowCtx.createImageData(lowRes, lowRes);
  const rand = mulberry32(0xC0DE5EED);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (rand() * 256) | 0;
    img.data[i + 1] = (rand() * 256) | 0;
    img.data[i + 2] = (rand() * 256) | 0;
    img.data[i + 3] = 255;
  }
  lowCtx.putImageData(img, 0, 0);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outCanvas.height = outRes;
  const outCtx = outCanvas.getContext("2d")!;
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(lowCanvas, 0, 0, outRes, outRes);
  return outCanvas.toDataURL("image/png");
}

/** Tiny seeded RNG so the noise textures are reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Match a preset key tolerantly: exact, case-insensitive, then
 *  punctuation-stripped substring. Returns the raw key from the library
 *  so loadPreset gets the exact object it expects. */
function findPresetKey(names: string[], requested: string): string | null {
  if (names.includes(requested)) return requested;
  const lower = requested.toLowerCase();
  const ci = names.find((n) => n.toLowerCase() === lower);
  if (ci) return ci;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(requested);
  return names.find((n) => norm(n) === target) ?? null;
}

/** Strip leading punctuation, kebab-ish format, lowercase. */
function prettyPresetName(raw: string): string {
  return raw
    .replace(/^[\W\d]+/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
