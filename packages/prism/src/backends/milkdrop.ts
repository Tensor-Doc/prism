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

  // Feed butterchurn the texture pack at /textures/ so .milk presets that
  // reference sampler_<name> (worms, clouds, fire_alpha, manyfish, …) can
  // actually sample them. Without this, butterchurn only has its own 6
  // bundled textures and every other reference reads black. Fire-and-
  // forget — presets that load before this completes will see black
  // textures until the next loadPreset.
  void loadTexturePack(visualizer).catch((err) => {
    console.warn("[milkdrop] texture pack load failed:", err);
  });

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
  visualizer.loadPreset(presetMap[currentRaw], 0);

  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    sizeTo(w, h);
    visualizer.setRendererSize(w, h);
  };
  window.addEventListener("resize", onResize, { passive: true });

  let running = true;
  let firstFrame = true;
  const loop = (): void => {
    if (!running) return;
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
      visualizer.loadPreset(presetMap[next], blendSeconds);
      currentRaw = next;
      return prettyPresetName(next);
    },
    loadByName: (name, blendSeconds = 2.5) => {
      const key = findPresetKey(names, name);
      if (!key) return null;
      visualizer.loadPreset(presetMap[key], blendSeconds);
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
      visualizer.loadPreset(converted, blendSeconds);
      // Display name is derived from the URL's last path segment.
      const stem = url.split("/").pop()?.replace(/\.milk$/, "") ?? url;
      currentRaw = stem;
      return prettyPresetName(stem);
    },
    destroy: () => {
      running = false;
      window.removeEventListener("resize", onResize);
    },
  };
}

/** Fetch /textures/index.json and feed every entry to butterchurn via
 *  loadExtraImages(). Names match what .milk presets expect (lowercase,
 *  no extension, underscores for spaces). Each image is fetched as a
 *  Blob and converted to a base64 dataURL because that's the format
 *  butterchurn's loadExtraImages accepts.
 *
 *  Also generates Milkdrop's procedural noise textures (noise_lq, _mq,
 *  _hq plus the pw_* mirrors and rand00/01/02) — Geiss spec is
 *  256x256, 64x64 (cubic-filtered), 32x32 (cubic-filtered) RGBA random
 *  pixels. */
async function loadTexturePack(visualizer: VisualizerHandle): Promise<void> {
  const res = await fetch("/textures/index.json");
  if (!res.ok) {
    throw new Error(`/textures/index.json → ${res.status}`);
  }
  const manifest = (await res.json()) as Record<string, string>;
  const entries = Object.entries(manifest);
  const loaded: Record<string, { data: string }> = {};
  await Promise.all(entries.map(async ([key, filename]) => {
    try {
      const r = await fetch(`/textures/${encodeURIComponent(filename)}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const blob = await r.blob();
      const dataUrl = await blobToDataUrl(blob);
      loaded[key] = { data: dataUrl };
    } catch (err) {
      console.warn(`[milkdrop] texture ${key} failed:`, err);
    }
  }));
  Object.assign(loaded, generateNoiseTextures());
  if (Object.keys(loaded).length === 0) return;
  visualizer.loadExtraImages(loaded);
  console.log(`[milkdrop] loaded ${Object.keys(loaded).length} textures`);
}

/** Generate Milkdrop's procedural 2D noise textures via Canvas.
 *  - noise_lq / pw_noise_lq / rand00-02: 256x256 raw RGBA white noise
 *  - noise_mq / pw_noise_mq: 64x64 white noise upsampled from 16x16
 *    with high-quality smoothing — fakes Milkdrop's cubic filter
 *  - noise_hq / pw_noise_hq: 32x32 from 8x8 upsampled with smoothing
 *  Returns a dataURL map ready for visualizer.loadExtraImages(). */
function generateNoiseTextures(): Record<string, { data: string }> {
  const out: Record<string, { data: string }> = {};
  const lqUrl = randomNoiseDataUrl(256, 256, 1);
  const mqUrl = smoothNoiseDataUrl(16, 64);
  const hqUrl = smoothNoiseDataUrl(8, 32);
  out["noise_lq"] = { data: lqUrl };
  out["pw_noise_lq"] = { data: lqUrl };
  out["noise_mq"] = { data: mqUrl };
  out["pw_noise_mq"] = { data: mqUrl };
  out["noise_hq"] = { data: hqUrl };
  out["pw_noise_hq"] = { data: hqUrl };
  out["rand00"] = { data: randomNoiseDataUrl(256, 256, 2) };
  out["rand01"] = { data: randomNoiseDataUrl(256, 256, 3) };
  out["rand02"] = { data: randomNoiseDataUrl(256, 256, 4) };
  return out;
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
