// milkdrop-bg.ts — boot a butterchurn (Milkdrop) visualizer as the landing
// page background. Picks a random preset on each load. Starts on a silent
// source so the visual runs without audio; the caller can call connectAudio()
// later when tab audio is shared.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import butterchurnRaw from "butterchurn";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import butterchurnPresetsRaw from "butterchurn-presets";
// milkdrop-preset-converter ships as CJS without types; pull the named
// export we need with a structural cast. convertPreset is async — it
// returns a Promise<preset object> regardless of input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as milkdropConverterRaw from "milkdrop-preset-converter";
const milkdropConverter = milkdropConverterRaw as unknown as {
  convertPreset: (text: string) => Promise<unknown>;
};

interface VisualizerHandle {
  connectAudio(node: AudioNode): void;
  loadPreset(preset: unknown, blendTime?: number): void;
  setRendererSize(w: number, h: number): void;
  render(): void;
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
