// Butterchurn (WebGL Milkdrop) wrapper.
// The package is a UMD bundle that exports the Butterchurn class as `default`;
// Vite's CJS/ESM interop sometimes leaves the `default` property in place, so
// we unwrap defensively here.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import butterchurnRaw from "butterchurn";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import butterchurnPresetsRaw from "butterchurn-presets";

interface ButterchurnAPI {
  createVisualizer(
    audioCtx: AudioContext,
    canvas: HTMLCanvasElement,
    opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
  ): {
    connectAudio(node: AudioNode): void;
    loadPreset(preset: unknown, blendTime?: number): void;
    setRendererSize(width: number, height: number): void;
    render(): void;
    loadExtraImages(images: Record<string, { data: string; width: number; height: number }>): void;
  };
}
interface PresetsAPI {
  getPresets(): Record<string, unknown>;
}

function unwrap<T>(mod: unknown): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = mod as any;
  return (m && typeof m === "object" && "default" in m ? m.default : m) as T;
}

const butterchurn = unwrap<ButterchurnAPI>(butterchurnRaw);
const butterchurnPresets = unwrap<PresetsAPI>(butterchurnPresetsRaw);

import type { Palette } from "./palette";

export interface MilkdropLayer {
  setSize(width: number, height: number): void;
  render(): void;
  loadPreset(name: string, blendSeconds?: number): void;
  randomPreset(): string;
  randomFromFavorites(): string | null;
  presetNames(): string[];
  currentName(): string;
  isFavorite(name: string): boolean;
  toggleFavorite(name: string): boolean;
  favorites(): string[];
  getCurrentPresetData(): unknown;
  loadCustomPreset(data: unknown, blendSeconds?: number): void;
  /** Register each palette slot as a named butterchurn sampler (sampler_nasa_1..N). */
  registerPaletteImages(palette: Palette): string[];
  saveUserPreset(name: string, data: unknown): void;
  deleteUserPreset(name: string): void;
  isUserPreset(name: string): boolean;
  userPresetNames(): string[];
}

const FAV_STORAGE_KEY = "prism.milkdrop.favorites";
const USER_PRESET_STORAGE_KEY = "prism.milkdrop.user_presets";

function loadUserPresets(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(USER_PRESET_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function saveUserPresetsToStorage(presets: Record<string, unknown>): void {
  try {
    localStorage.setItem(USER_PRESET_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore — storage may be full or disabled
  }
}

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return new Set(arr.filter((s): s is string => typeof s === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>): void {
  try {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favs].sort()));
  } catch {
    // ignore — storage may be full or disabled
  }
}

export function createMilkdrop(
  audioCtx: AudioContext,
  canvas: HTMLCanvasElement,
  audioNode: AudioNode,
): MilkdropLayer {
  const builtinMap = butterchurnPresets.getPresets();
  const userMap = loadUserPresets();
  // Combined preset map: built-ins + user-saved. User presets can shadow built-ins.
  const presetMap: Record<string, unknown> = { ...builtinMap, ...userMap };
  let names = Object.keys(presetMap).sort();
  const favorites = loadFavorites();

  const visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
    textureRatio: 1,
  });
  visualizer.connectAudio(audioNode);

  function pickRandom(list: string[]): string {
    return list[Math.floor(Math.random() * list.length)];
  }
  let current = pickRandom(names);
  // Track the actual preset DATA currently in use (may diverge from `current`
  // when the user edits and applies via loadCustomPreset). Used to re-compile
  // shaders after samplers change without losing in-editor edits.
  let currentData: unknown = presetMap[current];
  visualizer.loadPreset(currentData, 0);

  return {
    setSize(w, h) {
      canvas.width = w;
      canvas.height = h;
      visualizer.setRendererSize(w, h);
    },
    render() {
      visualizer.render();
    },
    loadPreset(name, blendSeconds = 2.0) {
      if (presetMap[name] === undefined) return;
      current = name;
      currentData = presetMap[name];
      visualizer.loadPreset(presetMap[name], blendSeconds);
    },
    randomPreset() {
      current = pickRandom(names);
      currentData = presetMap[current];
      visualizer.loadPreset(presetMap[current], 2.0);
      return current;
    },
    randomFromFavorites() {
      const list = [...favorites].filter((n) => presetMap[n] !== undefined);
      if (list.length === 0) return null;
      current = pickRandom(list);
      currentData = presetMap[current];
      visualizer.loadPreset(presetMap[current], 2.0);
      return current;
    },
    presetNames() {
      return names;
    },
    currentName() {
      return current;
    },
    isFavorite(name) {
      return favorites.has(name);
    },
    toggleFavorite(name) {
      if (favorites.has(name)) {
        favorites.delete(name);
        saveFavorites(favorites);
        return false;
      }
      favorites.add(name);
      saveFavorites(favorites);
      return true;
    },
    favorites() {
      return [...favorites].sort();
    },
    getCurrentPresetData() {
      return presetMap[current];
    },
    loadCustomPreset(data, blendSeconds = 2.0) {
      currentData = data;
      visualizer.loadPreset(data as Record<string, unknown>, blendSeconds);
    },
    saveUserPreset(name, data) {
      userMap[name] = data;
      presetMap[name] = data;
      saveUserPresetsToStorage(userMap);
      if (!names.includes(name)) {
        names = [...names, name].sort();
      }
      current = name;
      currentData = data;
    },
    deleteUserPreset(name) {
      if (!(name in userMap)) return;
      delete userMap[name];
      saveUserPresetsToStorage(userMap);
      // If the name also exists as a built-in, restore that; otherwise remove.
      if (name in builtinMap) {
        presetMap[name] = builtinMap[name];
      } else {
        delete presetMap[name];
        names = names.filter((n) => n !== name);
      }
    },
    isUserPreset(name) {
      return name in userMap;
    },
    userPresetNames() {
      return Object.keys(userMap).sort();
    },
    registerPaletteImages(palette: Palette): string[] {
      const slotW = palette.slotWidth;
      const slotH = palette.slotHeight;
      const source = palette.getSourceCanvas();

      const tmp = document.createElement("canvas");
      tmp.width = slotW;
      tmp.height = slotH;
      const ctx = tmp.getContext("2d");
      if (!ctx) return [];

      // Butterchurn caches samplers and refuses to reload an existing one,
      // so reach into its internals to clear any prior registrations before
      // we re-upload (e.g. after NASA APOD images load asynchronously).
      const vAny = visualizer as unknown as {
        renderer?: { image?: { samplers?: Record<string, unknown> } };
      };
      const samplers = vAny.renderer?.image?.samplers;

      const images: Record<string, { data: string; width: number; height: number }> = {};
      const samplerNames: string[] = [];
      for (let i = 0; i < palette.slotCount; i++) {
        const name = `nasa_${i + 1}`;
        if (samplers && samplers[name]) delete samplers[name];
        ctx.clearRect(0, 0, slotW, slotH);
        ctx.drawImage(source, i * slotW, 0, slotW, slotH, 0, 0, slotW, slotH);
        images[name] = {
          data: tmp.toDataURL("image/png"),
          width: slotW,
          height: slotH,
        };
        samplerNames.push(`sampler_${name}`);
      }
      visualizer.loadExtraImages(images);
      // Butterchurn loads the data-URL images asynchronously via image.onload.
      // The first preset compile (above) happened before samplers existed, so
      // its texture lookups bound to the fallback (clouds2). Re-load the
      // current preset shortly so its shaders recompile with the new samplers
      // visible. We use currentData (not the name) so user edits via
      // loadCustomPreset survive across palette refreshes.
      setTimeout(() => {
        if (currentData !== undefined) {
          visualizer.loadPreset(currentData as Record<string, unknown>, 0);
        }
      }, 250);
      return samplerNames;
    },
  };
}
