import "./style.css";
import { startTabCapture, type AudioCapture } from "./audio";
import { AudioFeatureExtractor } from "./audio-features";
import { compilePreset, type CompiledPreset, type PresetSpec } from "./preset";
import { initWebGPU, type GPUContext } from "./gpu/webgpu-init";
import { FluidSurface } from "./gpu/fluid";
import { Compositor } from "./gpu/compositor";
import { createTuning } from "./tuning";
import { Palette, loadDefaultPalette } from "./palette";
import { createMilkdrop, type MilkdropLayer } from "./milkdrop";
import {
  BUILTIN_COMPOSITORS,
  loadUserPresets,
  saveUserPresets,
  loadSelectedName,
  saveSelectedName,
  type CompositorPreset,
} from "./compositor-presets";
import { aiInsertNasa } from "./gemini";
import defaultPresetJson from "../presets/default.json";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const milkdropCanvas = document.getElementById("milkdrop-canvas") as HTMLCanvasElement;
const button = document.getElementById("capture") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;
const presetName = document.getElementById("preset-name") as HTMLSpanElement;
const mdPresetSelect = document.getElementById("md-preset") as HTMLSelectElement;
const mdRandomBtn = document.getElementById("md-random") as HTMLButtonElement;
const mdHeartBtn = document.getElementById("md-heart") as HTMLButtonElement;
const mdFavCount = document.getElementById("md-fav-count") as HTMLSpanElement;
const mdStatus = document.getElementById("md-status") as HTMLDivElement;
const mdPlayBtn = document.getElementById("md-play") as HTMLButtonElement;
const mdPlayInterval = document.getElementById("md-play-interval") as HTMLInputElement;
const mdEditor = document.getElementById("md-editor") as HTMLTextAreaElement;
const mdEditorApply = document.getElementById("md-editor-apply") as HTMLButtonElement;
const mdEditorRevert = document.getElementById("md-editor-revert") as HTMLButtonElement;
const mdEditorSave = document.getElementById("md-editor-save") as HTMLButtonElement;
const mdEditorDelete = document.getElementById("md-editor-delete") as HTMLButtonElement;
const mdEditorAI = document.getElementById("md-editor-ai") as HTMLButtonElement;
const mdEditorStatus = document.getElementById("md-editor-status") as HTMLSpanElement;

function refreshMdDeleteState(): void {
  if (!milkdrop) return;
  mdEditorDelete.disabled = !milkdrop.isUserPreset(milkdrop.currentName());
}

/**
 * Escape literal newlines / carriage returns / tabs that appear *inside* JSON
 * string literals, so users can format shader code with real line breaks in
 * the editor without breaking JSON.parse. Walks a small state machine: inside
 * a "..." string, raw control chars become their escape equivalents.
 */
function escapeControlCharsInStrings(text: string): string {
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") { result += "\\n"; continue; }
      if (ch === "\r") { result += "\\r"; continue; }
      if (ch === "\t") { result += "\\t"; continue; }
    }
    result += ch;
  }
  return result;
}

function parseMdEditorJson(): unknown {
  // Tolerate raw newlines inside string literals.
  return JSON.parse(escapeControlCharsInStrings(mdEditor.value));
}
let randomPool: "all" | "favs" = "all";

function refreshMdEditor(): void {
  if (!milkdrop) {
    mdEditor.value = "";
    return;
  }
  try {
    const data = milkdrop.getCurrentPresetData();
    mdEditor.value = JSON.stringify(data, null, 2);
    mdEditorStatus.textContent = milkdrop.currentName();
  } catch (e) {
    mdEditor.value = `// failed to serialize: ${(e as Error).message}`;
    mdEditorStatus.textContent = "serialize error";
  }
}

mdEditorApply.addEventListener("click", () => {
  if (!milkdrop) return;
  try {
    const data = parseMdEditorJson();
    milkdrop.loadCustomPreset(data);
    mdEditorStatus.textContent = "✓ applied edits";
  } catch (e) {
    mdEditorStatus.textContent = `✗ ${(e as Error).message}`;
  }
});

mdEditorRevert.addEventListener("click", () => {
  refreshMdEditor();
});

mdEditor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    mdEditorApply.click();
  }
});

mdEditorSave.addEventListener("click", () => {
  if (!milkdrop) return;
  let data: unknown;
  try {
    data = parseMdEditorJson();
  } catch (e) {
    mdEditorStatus.textContent = `✗ JSON: ${(e as Error).message}`;
    return;
  }
  const currentName = milkdrop.currentName();
  const suggested = currentName.startsWith("Custom: ")
    ? currentName
    : `Custom: ${currentName}`;
  const name = prompt("Save milkdrop preset as:", suggested);
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (milkdrop.isUserPreset(trimmed) && !confirm(`Replace existing "${trimmed}"?`)) return;
  milkdrop.saveUserPreset(trimmed, data);
  milkdrop.loadCustomPreset(data, 0);
  populatePresetSelect();
  mdPresetSelect.value = trimmed;
  refreshHeartUI();
  refreshMdDeleteState();
  mdEditorStatus.textContent = `✓ saved "${trimmed}"`;
});

mdEditorDelete.addEventListener("click", () => {
  if (!milkdrop) return;
  const name = milkdrop.currentName();
  if (!milkdrop.isUserPreset(name)) {
    mdEditorStatus.textContent = "delete only works for saved presets";
    return;
  }
  if (!confirm(`Delete "${name}"?`)) return;
  milkdrop.deleteUserPreset(name);
  const newName = milkdrop.randomPreset();
  populatePresetSelect();
  mdPresetSelect.value = newName;
  refreshHeartUI();
  refreshMdEditor();
  refreshMdDeleteState();
  mdEditorStatus.textContent = `deleted "${name}"`;
});

let aiInFlight: AbortController | null = null;
mdEditorAI.addEventListener("click", async () => {
  if (aiInFlight) {
    aiInFlight.abort();
    aiInFlight = null;
    mdEditorAI.disabled = false;
    mdEditorAI.textContent = "✨ AI: insert NASA";
    mdEditorStatus.textContent = "cancelled";
    return;
  }
  // Use the current editor content as the source preset (so user-edited
  // changes are also sent to the model).
  const source = mdEditor.value.trim();
  if (!source) {
    mdEditorStatus.textContent = "no preset to modify";
    return;
  }
  mdEditorAI.disabled = false; // stays enabled so user can click to cancel
  mdEditorAI.textContent = "cancel…";
  mdEditorStatus.textContent = "✨ asking gemini…";
  const ctl = new AbortController();
  aiInFlight = ctl;
  try {
    const result = await aiInsertNasa(source, ctl.signal);
    mdEditor.value = result;
    mdEditorStatus.textContent = "✓ AI inserted NASA samplers — review then apply (⌘↩)";
  } catch (e) {
    if (ctl.signal.aborted) {
      mdEditorStatus.textContent = "cancelled";
    } else {
      mdEditorStatus.textContent = `✗ ${(e as Error).message}`;
    }
  } finally {
    aiInFlight = null;
    mdEditorAI.disabled = false;
    mdEditorAI.textContent = "✨ AI: insert NASA";
  }
});

const cmpPresetSelect = document.getElementById("cmp-preset") as HTMLSelectElement;
const cmpEditor = document.getElementById("cmp-editor") as HTMLTextAreaElement;
const cmpApplyBtn = document.getElementById("cmp-apply") as HTMLButtonElement;
const cmpSaveBtn = document.getElementById("cmp-save") as HTMLButtonElement;
const cmpDeleteBtn = document.getElementById("cmp-delete") as HTMLButtonElement;
const cmpStatus = document.getElementById("cmp-status") as HTMLSpanElement;

let userPresets: CompositorPreset[] = loadUserPresets();
let activeCompositor: CompositorPreset = BUILTIN_COMPOSITORS[2]; // default to screen-blend
const vuBass = document.getElementById("vu-bass") as HTMLDivElement;
const vuMid = document.getElementById("vu-mid") as HTMLDivElement;
const vuTreble = document.getElementById("vu-treble") as HTMLDivElement;
const vuBeat = document.getElementById("vu-beat") as HTMLDivElement;
const djBoard = document.getElementById("dj-board") as HTMLDivElement;
const djToggle = document.getElementById("dj-toggle") as HTMLButtonElement;
const djClose = document.getElementById("dj-close") as HTMLButtonElement;

const tuning = createTuning(djBoard);
const palette = new Palette();
void loadDefaultPalette(palette);

// Hoisted runtime state — refreshThumbs() references `milkdrop` below.
let gpu: GPUContext | null = null;
let fluid: FluidSurface | null = null;
let compositor: Compositor | null = null;
let milkdrop: MilkdropLayer | null = null;

// Palette thumbnail strip in the DJ drawer.
const thumbContainer = document.getElementById("palette-thumbs") as HTMLDivElement;
interface ThumbWidget {
  ctx: CanvasRenderingContext2D;
  label: HTMLDivElement;
}
const thumbWidgets: ThumbWidget[] = [];
for (let i = 0; i < palette.slotCount; i++) {
  const wrap = document.createElement("div");
  wrap.className = "palette-thumb";
  const c = document.createElement("canvas");
  c.width = 72;
  c.height = 72;
  const label = document.createElement("div");
  label.className = "palette-thumb-label";
  label.textContent = "—";
  wrap.append(c, label);
  thumbContainer.append(wrap);
  const ctx = c.getContext("2d");
  if (ctx) thumbWidgets.push({ ctx, label });
}
let lastPaletteVersion = -1;
function refreshThumbs(): void {
  if (palette.version !== lastPaletteVersion) {
    lastPaletteVersion = palette.version;
    const src = palette.getSourceCanvas();
    for (let i = 0; i < thumbWidgets.length; i++) {
      const w = thumbWidgets[i];
      w.ctx.drawImage(
        src,
        i * palette.slotWidth, 0, palette.slotWidth, palette.slotHeight,
        0, 0, 72, 72,
      );
      w.label.textContent = palette.sourceLabels[i] ?? "—";
    }
    // Also push palette images into butterchurn as named samplers so any
    // Milkdrop preset can reference them via tex2D(sampler_nasa_1, uv).
    if (milkdrop) {
      const names = milkdrop.registerPaletteImages(palette);
      mdStatus.textContent = `samplers: ${names.join(", ")}`;
    }
  }
  requestAnimationFrame(refreshThumbs);
}
refreshThumbs();

function setDJOpen(open: boolean): void {
  document.body.classList.toggle("dj-open", open);
}
djToggle.addEventListener("click", () => {
  setDJOpen(!document.body.classList.contains("dj-open"));
});
djClose.addEventListener("click", () => setDJOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setDJOpen(false);
});

// DJ board tab switching
djBoard.querySelectorAll<HTMLButtonElement>(".dj-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    djBoard.querySelectorAll<HTMLButtonElement>(".dj-tab").forEach((t) => {
      t.classList.toggle("active", t === tab);
    });
    djBoard.querySelectorAll<HTMLDivElement>(".dj-tab-content").forEach((c) => {
      c.hidden = c.dataset.tab !== target;
    });
  });
});

let preset: CompiledPreset = compilePreset(defaultPresetJson as PresetSpec);
presetName.textContent = preset.name;

if (import.meta.hot) {
  import.meta.hot.accept("../presets/default.json", (mod) => {
    if (!mod) return;
    preset = compilePreset((mod as unknown as { default: PresetSpec }).default);
    presetName.textContent = preset.name;
    status.textContent = `preset reloaded: ${preset.name}`;
  });
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  // Milkdrop canvas — runs at a lower internal resolution for performance;
  // CSS stretches it to fill.
  const MD_BASE = 720;
  const aspect = window.innerWidth / window.innerHeight;
  milkdropCanvas.width = Math.round(MD_BASE * aspect);
  milkdropCanvas.height = MD_BASE;
  if (milkdrop) milkdrop.setSize(milkdropCanvas.width, milkdropCanvas.height);
  if (fluid && compositor) {
    fluid.resizeOutput(canvas.width, canvas.height);
    compositor.setFluidTexture(fluid.getOutputTextureView());
  }
}
resize();
addEventListener("resize", resize);
let capture: AudioCapture | null = null;
let extractor: AudioFeatureExtractor | null = null;
let raf = 0;
const startedAt = performance.now();
let lastFrameAt = startedAt;

function populatePresetSelect(): void {
  if (!milkdrop) return;
  mdPresetSelect.innerHTML = "";

  const userPresets = milkdrop.userPresetNames();
  const userSet = new Set(userPresets);

  if (userPresets.length > 0) {
    const savedGrp = document.createElement("optgroup");
    savedGrp.label = "saved";
    for (const name of userPresets) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      savedGrp.append(opt);
    }
    mdPresetSelect.append(savedGrp);
  }

  const builtinGrp = document.createElement("optgroup");
  builtinGrp.label = "built-in";
  for (const name of milkdrop.presetNames()) {
    if (userSet.has(name)) continue;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    builtinGrp.append(opt);
  }
  mdPresetSelect.append(builtinGrp);

  mdPresetSelect.value = milkdrop.currentName();
}

function refreshHeartUI(): void {
  if (!milkdrop) return;
  const isFav = milkdrop.isFavorite(milkdrop.currentName());
  mdHeartBtn.classList.toggle("active", isFav);
  mdHeartBtn.textContent = isFav ? "♥" : "♡";
  const favCount = milkdrop.favorites().length;
  mdFavCount.textContent = favCount === 1 ? "1 favorite" : `${favCount} favorites`;
}

mdPresetSelect.addEventListener("change", () => {
  if (!milkdrop) return;
  milkdrop.loadPreset(mdPresetSelect.value);
  refreshHeartUI();
  refreshMdEditor();
  refreshMdDeleteState();
});

mdHeartBtn.addEventListener("click", () => {
  if (!milkdrop) return;
  milkdrop.toggleFavorite(milkdrop.currentName());
  refreshHeartUI();
});

mdRandomBtn.addEventListener("click", () => {
  if (!milkdrop) return;
  let name: string | null;
  if (randomPool === "favs") {
    name = milkdrop.randomFromFavorites();
    if (name === null) {
      mdStatus.textContent = "no favorites yet — heart some first ♡";
      return;
    }
  } else {
    name = milkdrop.randomPreset();
  }
  mdPresetSelect.value = name;
  mdStatus.textContent = `loaded: ${name}`;
  refreshHeartUI();
  refreshMdEditor();
  refreshMdDeleteState();
});

document.querySelectorAll<HTMLInputElement>('input[name="md-pool"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) randomPool = radio.value as "all" | "favs";
  });
});

// ===== Play mode =====
const PLAY_MODE_KEY = "prism.milkdrop.play_mode";
const PLAY_INTERVAL_KEY = "prism.milkdrop.play_interval";
let playTimer: number | null = null;
let playMode = false;

function advancePreset(): void {
  if (!milkdrop) return;
  let name: string | null;
  if (randomPool === "favs") {
    name = milkdrop.randomFromFavorites();
    if (name === null) name = milkdrop.randomPreset(); // graceful fallback
  } else {
    name = milkdrop.randomPreset();
  }
  if (!name) return;
  mdPresetSelect.value = name;
  refreshHeartUI();
  refreshMdEditor();
  refreshMdDeleteState();
}

function startPlayTimer(): void {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  if (!playMode) return;
  const seconds = Math.max(3, Math.min(120, parseFloat(mdPlayInterval.value) || 15));
  playTimer = window.setInterval(advancePreset, seconds * 1000);
}

function setPlayMode(on: boolean): void {
  playMode = on;
  mdPlayBtn.classList.toggle("active", on);
  mdPlayBtn.textContent = on ? "⏸ pause" : "▶ play";
  try { localStorage.setItem(PLAY_MODE_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  startPlayTimer();
}

mdPlayBtn.addEventListener("click", () => setPlayMode(!playMode));

mdPlayInterval.addEventListener("change", () => {
  const val = Math.max(3, Math.min(120, parseFloat(mdPlayInterval.value) || 15));
  mdPlayInterval.value = String(val);
  try { localStorage.setItem(PLAY_INTERVAL_KEY, String(val)); } catch { /* ignore */ }
  startPlayTimer();
});

// Restore saved interval at load; play mode is restored after milkdrop init.
try {
  const savedInterval = parseFloat(localStorage.getItem(PLAY_INTERVAL_KEY) ?? "15");
  if (Number.isFinite(savedInterval) && savedInterval >= 3 && savedInterval <= 120) {
    mdPlayInterval.value = String(savedInterval);
  }
} catch { /* ignore */ }

// ===== Compositor preset UI =====

function allCompositors(): CompositorPreset[] {
  return [...BUILTIN_COMPOSITORS, ...userPresets];
}

function findCompositor(name: string): CompositorPreset | undefined {
  return allCompositors().find((p) => p.name === name);
}

function isUserPreset(name: string): boolean {
  return userPresets.some((p) => p.name === name);
}

function refreshCmpPresetSelect(): void {
  cmpPresetSelect.innerHTML = "";
  const builtins = document.createElement("optgroup");
  builtins.label = "built-in";
  for (const p of BUILTIN_COMPOSITORS) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name;
    builtins.append(o);
  }
  cmpPresetSelect.append(builtins);
  if (userPresets.length > 0) {
    const grp = document.createElement("optgroup");
    grp.label = "saved";
    for (const p of userPresets) {
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.name;
      grp.append(o);
    }
    cmpPresetSelect.append(grp);
  }
  cmpPresetSelect.value = activeCompositor.name;
  cmpDeleteBtn.disabled = !isUserPreset(activeCompositor.name);
}

async function applyCompositorBody(body: string): Promise<void> {
  if (!compositor) {
    cmpStatus.textContent = "compositor not initialized yet";
    return;
  }
  cmpStatus.textContent = "compiling…";
  const result = await compositor.setBody(body);
  if (result.ok) {
    cmpStatus.textContent = "✓ live";
  } else {
    cmpStatus.textContent = `✗ ${result.errors[0] ?? "compile failed"}`;
    console.warn("[prism] compositor compile errors:", result.errors);
  }
}

cmpPresetSelect.addEventListener("change", () => {
  const sel = findCompositor(cmpPresetSelect.value);
  if (!sel) return;
  activeCompositor = sel;
  cmpEditor.value = sel.body;
  cmpDeleteBtn.disabled = !isUserPreset(sel.name);
  saveSelectedName(sel.name);
  void applyCompositorBody(sel.body);
});

cmpApplyBtn.addEventListener("click", () => {
  activeCompositor = { ...activeCompositor, body: cmpEditor.value };
  void applyCompositorBody(cmpEditor.value);
});

cmpEditor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    cmpApplyBtn.click();
  }
});

cmpSaveBtn.addEventListener("click", () => {
  const name = prompt("Save compositor as:", `${activeCompositor.name} (copy)`);
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = userPresets.find((p) => p.name === trimmed);
  if (existing) {
    if (!confirm(`Replace existing "${trimmed}"?`)) return;
    existing.body = cmpEditor.value;
  } else {
    userPresets.push({ name: trimmed, body: cmpEditor.value });
  }
  saveUserPresets(userPresets);
  activeCompositor = { name: trimmed, body: cmpEditor.value };
  saveSelectedName(trimmed);
  refreshCmpPresetSelect();
  cmpStatus.textContent = `saved "${trimmed}"`;
});

cmpDeleteBtn.addEventListener("click", () => {
  if (!isUserPreset(activeCompositor.name)) return;
  if (!confirm(`Delete "${activeCompositor.name}"?`)) return;
  userPresets = userPresets.filter((p) => p.name !== activeCompositor.name);
  saveUserPresets(userPresets);
  activeCompositor = BUILTIN_COMPOSITORS[0];
  cmpEditor.value = activeCompositor.body;
  saveSelectedName(activeCompositor.name);
  refreshCmpPresetSelect();
  void applyCompositorBody(activeCompositor.body);
});

// Restore last-selected compositor.
{
  const lastName = loadSelectedName();
  if (lastName) {
    const found = findCompositor(lastName);
    if (found) activeCompositor = found;
  }
  cmpEditor.value = activeCompositor.body;
  refreshCmpPresetSelect();
}

async function ensureGPU(): Promise<void> {
  if (gpu) return;
  gpu = await initWebGPU(canvas);
  fluid = new FluidSurface(gpu, canvas.width, canvas.height);
  compositor = new Compositor(gpu);
  compositor.setFluidTexture(fluid.getOutputTextureView());
  compositor.setPaletteTexture(fluid.getPaletteTextureView());
  // Apply the active compositor body now that GPU is ready.
  void applyCompositorBody(activeCompositor.body);
}

button.addEventListener("click", async () => {
  if (capture) {
    capture.stop();
    capture = null;
    extractor = null;
    cancelAnimationFrame(raf);
    button.textContent = "Capture tab audio";
    status.textContent = "Stopped.";
    return;
  }

  try {
    status.textContent = "Initializing GPU…";
    await ensureGPU();
    if (!gpu || !fluid) throw new Error("GPU init failed.");

    status.textContent = 'Pick a tab and check "Share tab audio"…';
    const c = await startTabCapture();
    capture = c;
    extractor = new AudioFeatureExtractor(c.analyser);
    button.textContent = "Stop capture";
    status.textContent = "Capturing.";
    lastFrameAt = performance.now();

    // Initialize Milkdrop layer if not already up.
    if (!milkdrop) {
      try {
        milkdrop = createMilkdrop(c.ctx, milkdropCanvas, c.analyser);
        milkdrop.setSize(milkdropCanvas.width, milkdropCanvas.height);
        if (compositor) compositor.setMilkdropCanvas(milkdropCanvas);
        populatePresetSelect();
        refreshHeartUI();
        refreshMdEditor();
        refreshMdDeleteState();
        // Register palette images as butterchurn samplers so presets can use them.
        const samplerNames = milkdrop.registerPaletteImages(palette);
        mdStatus.textContent =
          `${milkdrop.presetNames().length} presets · ${samplerNames.join(", ")} available`;
        // Restore play mode from previous session.
        try {
          if (localStorage.getItem(PLAY_MODE_KEY) === "1") setPlayMode(true);
        } catch { /* ignore */ }
      } catch (e) {
        mdStatus.textContent = `milkdrop init failed: ${(e as Error).message}`;
        console.error("[prism] milkdrop init failed:", e);
      }
    }

    const loop = (): void => {
      if (!extractor || !fluid) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
      lastFrameAt = now;
      const t = (now - startedAt) / 1000;

      const audio = extractor.update();
      fluid.step(dt, t, preset, audio, tuning, palette);

      // Milkdrop renders to its (off-screen) canvas; compositor samples it.
      if (milkdrop) milkdrop.render();

      // Compositor: reads fluid + milkdrop, blends per chaos slider, writes to screen.
      if (compositor) {
        compositor.render(t, audio, Math.min(1, Math.max(0, tuning.chaos)));
      }

      vuBass.style.width = `${Math.min(100, audio.bass * 100)}%`;
      vuMid.style.width = `${Math.min(100, audio.mid * 100)}%`;
      vuTreble.style.width = `${Math.min(100, audio.treble * 100)}%`;
      vuBeat.style.width = `${Math.min(100, audio.beat * 100)}%`;

      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    status.textContent = `Error: ${(e as Error).message}`;
    button.textContent = "Capture tab audio";
  }
});
