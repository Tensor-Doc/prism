// main.ts — landing page entry point.
// Orchestrates the background field, telemetry, VU bars, audio capture,
// and prompt-input keyboard handling. Touches no studio code on this pass.

import { CursorField } from "./cursor-field";
import { Telemetry } from "./telemetry";
import { Vu } from "./vu";
import { Spectrum } from "./spectrum";
import { AudioCapture, type AudioFeatures } from "./audio";
import { createMilkdropBackground } from "./milkdrop-bg";
import { createShadertoyBackground } from "./shadertoy-bg";
import { GraphRuntime } from "./graph/runtime";
import type { PrismGraph } from "./graph/types";
import { GraphFlow } from "./graph-flow";
import { AmbientSignals } from "./ambient-signals";
import { ChromeIdle } from "./chrome-idle";
import { TestSignalRecorder } from "./test-signal";
import { SyntheticSignal } from "./synthetic-signal";
import { PulsoidStream } from "./pulsoid";
import { InputPulses } from "./input-pulses";
import { ImageSlots } from "./image-sources/slots";
import { TabVideoSource } from "./image-sources/tab-video";
import { NasaImagesSource } from "./image-sources/nasa-images";
import { Slideshow } from "./slideshow";

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`prism landing: missing element ${sel}`);
  return el;
}

// Stamp the build SHA + time into the corner tag + console banner.
// Tooltip shows PT (PST/PDT) since that's where you're debugging from.
const versionTag = document.getElementById("version-tag");
if (versionTag) {
  versionTag.textContent = __PRISM_BUILD_SHA__;
  const pt = new Date(__PRISM_BUILD_TIME__).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "medium",
    timeStyle: "short",
  });
  versionTag.title = `prism build ${__PRISM_BUILD_SHA__} · built ${pt} PT`;
}
console.log(
  `%cprism · build ${__PRISM_BUILD_SHA__}%c · ${__PRISM_BUILD_TIME__}`,
  "color:#3dffe5;font-family:JetBrains Mono,monospace;font-weight:600;",
  "color:#6a6a72;font-family:JetBrains Mono,monospace;",
);

// ── rotation helpers (declared first so onReady / onSource can call them) ──
const ROTATE_INTERVAL_MS = 22_000;
const ROTATE_BLEND_S = 3;
const AUDIO_FIRST_ROTATION_MS = 9_000; // first new preset within 9s of audio
let rotateTimer: number | null = null;

// Atelier rotation pool — entries from catalog/index.json filtered to
// brand_safe + atelier. Loaded once on boot, cached for life of the
// session. Until it loads, rotation falls back to milkdrop.loadRandom.
interface RotEntry {
  id: string;
  slug: string;
  name: string;
  source_type: "milkdrop" | "shadertoy" | "isf" | "wgsl";
  source_loader: "url" | "npm-butterchurn-presets";
  source_url?: string;
  source_ref?: string;
  default_image?: string;
}
let rotationPool: RotEntry[] = [];
void fetch("/catalog/index.json")
  .then((r) => r.ok ? r.json() : null)
  .then((data) => {
    if (!data?.entries) return;
    rotationPool = (data.entries as RotEntry[] & { brand_safe: boolean; atelier: boolean }[])
      .filter((e) => (e as unknown as { brand_safe: boolean }).brand_safe
                  && (e as unknown as { atelier: boolean }).atelier);
    console.log(`[rotate] atelier pool loaded: ${rotationPool.length} entries`);
  })
  .catch((err) => console.warn("[rotate] catalog fetch failed:", err));

function pickRotationEntry(): RotEntry | null {
  if (rotationPool.length === 0) return null;
  return rotationPool[Math.floor(Math.random() * rotationPool.length)];
}

function rotEntryToGraph(e: RotEntry): PrismGraph {
  const mainParams: Record<string, string> = {};
  let mainType: "lf.milkdrop" | "lf.shadertoy";
  if (e.source_type === "shadertoy") {
    mainType = "lf.shadertoy";
    if (e.source_url) mainParams.shader_url = e.source_url;
    if (e.default_image) mainParams.image_url = e.default_image;
  } else {
    mainType = "lf.milkdrop";
    if (e.source_loader === "url" && e.source_url) {
      mainParams.preset_url = e.source_url;
    } else if (e.source_ref) {
      mainParams.preset_name = e.source_ref;
    }
  }
  return {
    schema: "prism.graph/0.1",
    id: `rotate:${e.slug}`,
    intent: e.name,
    nodes: {
      audio: { type: "signal.audio" },
      main: { type: mainType, params: mainParams, inputs: { audio: "audio.signal" } },
      screen: { type: "sink.display", inputs: { frame: "main.frame" } },
    },
    output: "screen",
  };
}

function updateSkillDisplay(name: string, flash = false): void {
  const display = name.length > 26 ? name.slice(0, 24) + "…" : name;
  const el = document.getElementById("skill");
  if (el) {
    el.textContent = display;
    el.title = name;
    if (flash) {
      // Re-trigger the flash animation by removing + re-adding the class.
      el.classList.remove("has-update");
      // Force reflow so removing then re-adding actually restarts the keyframe.
      void el.offsetWidth;
      el.classList.add("has-update");
    }
  }
}

function showResult(intent: string): void {
  const el = document.getElementById("prompt-result");
  if (!el) return;
  el.textContent = intent;
  el.removeAttribute("data-hidden");
  // Re-trigger the result-pop animation when the same element updates.
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}

const thinkingPopup = document.getElementById("thinking-popup");
const thinkingPromptEl = document.getElementById("thinking-prompt");
function showThinking(prompt: string): void {
  if (thinkingPromptEl) {
    const truncated = prompt.length > 60 ? prompt.slice(0, 58) + "…" : prompt;
    thinkingPromptEl.textContent = `"${truncated}"`;
  }
  thinkingPopup?.removeAttribute("data-hidden");
}
function hideThinking(): void {
  thinkingPopup?.setAttribute("data-hidden", "");
}

function startRotation(initialMs = ROTATE_INTERVAL_MS): void {
  if (rotateTimer != null) return;
  const tick = (): void => {
    // Try the atelier pool first — picks across both milkdrop and
    // shadertoy entries flagged brand_safe + atelier. The runtime
    // handles backend switching, so the play button visibly cycles
    // no matter which backend was active.
    const entry = pickRotationEntry();
    if (entry) {
      const graph = rotEntryToGraph(entry);
      const result = runtime.apply(graph, ROTATE_BLEND_S);
      if (result.ok) {
        activeBackend = result.backend ?? activeBackend;
        graphFlow.render(graph);
        refreshShaderFeed();
        updateSkillDisplay(entry.name);
      }
    } else {
      // Catalog hasn't loaded yet — fall back to bundle random so the
      // button isn't dead on first ticks. Same milkdrop-only safeguard
      // as before: drop back to milkdrop so the swap is visible.
      if (activeBackend === "shadertoy") {
        setActiveBackend("milkdrop");
        activeBackend = "milkdrop";
        graphFlow.showChain(["signal.audio", "lf.milkdrop", "sink.display"], "rotate");
        refreshShaderFeed();
      }
      const newName = milkdrop.loadRandom(ROTATE_BLEND_S);
      updateSkillDisplay(newName);
    }
    rotateTimer = window.setTimeout(tick, ROTATE_INTERVAL_MS);
  };
  rotateTimer = window.setTimeout(tick, initialMs);
  const btn = document.getElementById("skill-play");
  if (btn) {
    btn.setAttribute("data-playing", "");
    btn.textContent = "⏸";
    btn.title = "Auto-rotate presets (playing)";
  }
}

function stopRotation(): void {
  if (rotateTimer != null) {
    clearTimeout(rotateTimer);
    rotateTimer = null;
  }
  const btn = document.getElementById("skill-play");
  if (btn) {
    btn.removeAttribute("data-playing");
    btn.textContent = "▶";
    btn.title = "Auto-rotate presets (paused)";
  }
}

// ── shared audio context ───────────────────────────────────
// Created eagerly so butterchurn can be initialised; resumed on first gesture.
// A SyntheticSignal generates a pink-ish "ambient music" spectrum that drives
// the milkdrop preset before any real audio is shared — so the visualisation
// is alive on load rather than flatlining.
const audioCtx = new AudioContext();
const synth = new SyntheticSignal(audioCtx);

const resumeAudio = (): void => {
  if (audioCtx.state === "suspended") void audioCtx.resume();
};
window.addEventListener("pointerdown", resumeAudio, { once: true });
window.addEventListener("keydown", resumeAudio, { once: true });
window.addEventListener("pointermove", resumeAudio, { once: true });

// ── background: milkdrop (random preset) + cursor overlay ──
// The skill readout shows "compiling…" until the first frame paints.
const skillElEarly = document.getElementById("skill");
if (skillElEarly) {
  skillElEarly.textContent = "compiling…";
  skillElEarly.classList.add("is-loading");
}
// Cold-open default — pick at random from a curated pool of atelier-mode
// presets so the landing surprises rather than always starts on the
// same visualizer. Seeded from the current second so a quick refresh
// keeps the same preset (less jarring) but every visit feels fresh.
// The catalog-router takes over the moment they type a prompt.
const COLD_OPEN_POOL = [
  "Geiss - Reaction Diffusion 2",
  "Geiss - Cauldron - painterly 2 (saturation remix)",
  "Flexi - alien fish pond",
  "martin - reflections on black tiles",
  "martin [shadow harlequins shape code] - fata morgana",
  "suksma - uninitialized variabowl (hydroponic chronic)",
  "Zylot - Paint Spill (Music Reactive Paint Mix)",
  "Aderrasi - Songflower (Moss Posy)",
  "flexi + amandio c - organic [random mashup]",
  "martin - frosty caves 2",
];
const COLD_OPEN_PRESET = COLD_OPEN_POOL[
  Math.floor(Date.now() / 1000) % COLD_OPEN_POOL.length
];

const milkdrop = createMilkdropBackground(
  audioCtx,
  $<HTMLCanvasElement>("#milkdrop"),
  synth.getOutput(),
  () => {
    // First milkdrop frame painted — clear the loading state.
    skillElEarly?.classList.remove("is-loading");
    updateSkillDisplay(milkdrop.presetName);
  },
  { initialPresetName: COLD_OPEN_PRESET },
);
const shadertoy = createShadertoyBackground(
  audioCtx,
  $<HTMLCanvasElement>("#shadertoy"),
  synth.getOutput(),
);
const field = new CursorField($<HTMLCanvasElement>("#field"));

// Track which background canvas is active. Initially milkdrop is showing.
const milkdropCanvas = $<HTMLCanvasElement>("#milkdrop");
const shadertoyCanvas = $<HTMLCanvasElement>("#shadertoy");
function setActiveBackend(which: "milkdrop" | "shadertoy"): void {
  if (which === "milkdrop") {
    milkdropCanvas.classList.remove("bg-canvas--hidden");
    milkdropCanvas.classList.add("bg-canvas--active");
    shadertoyCanvas.classList.add("bg-canvas--hidden");
    shadertoyCanvas.classList.remove("bg-canvas--active");
  } else {
    shadertoyCanvas.classList.remove("bg-canvas--hidden");
    shadertoyCanvas.classList.add("bg-canvas--active");
    milkdropCanvas.classList.add("bg-canvas--hidden");
    milkdropCanvas.classList.remove("bg-canvas--active");
  }
}
// Assert initial state — milkdrop is the cold-open backend.
setActiveBackend("milkdrop");

const runtime = new GraphRuntime({ milkdrop, shadertoy, setActiveBackend });

// graph-flow viz — the live prism.graph chain inside the STATE panel.
// Renders a synthetic cold-open chain immediately so the chain is on
// screen from first paint; swaps to the real graph after each generate.
const graphFlow = new GraphFlow();
graphFlow.showChain(["signal.audio", "lf.milkdrop", "sink.display"], "cold-open");
const ambient = new AmbientSignals();

// ── art mode: auto-fading chrome ────────────────────────────
// Any input wakes the chrome; 4s idle fades it out. `?art=1` boots
// straight into faded mode for shareable, immersive-from-load links.
const artModeFromUrl = new URLSearchParams(window.location.search).get("art") === "1";
new ChromeIdle({ idleMs: 4_000, cursorHideExtraMs: 2_000, startFaded: artModeFromUrl });

// Pump the synth's energy into cursor-field so its halo also breathes with
// the same "music" milkdrop is reacting to. Stopped once real audio kicks in.
let synthDrivesCursor = true;

// Centralised input pulses (click/dblclick), consume-on-read each frame.
// Pulses are control variables — see input-pulses.ts.
const inputPulses = new InputPulses();

const CYAN = "61, 255, 229";
const ORANGE = "255, 120, 71";

function ambientLoop(): void {
  if (synthDrivesCursor) field.setAudioEnergy(synth.readEnergy());

  // Distribute pulses to all visualizers that want to react.
  const pulses = inputPulses.consume();
  if (pulses.click.fired) {
    // Cursor field: cyan shockwave at click location
    field.emitRing(pulses.click.x, pulses.click.y, 1.0, CYAN);
  }
  if (pulses.dblclick.fired) {
    // Cursor field: bigger, orange double-pulse (two rings + halo flash)
    field.emitRing(pulses.dblclick.x, pulses.dblclick.y, 1.5, ORANGE);
    field.emitRing(pulses.dblclick.x, pulses.dblclick.y, 0.9, CYAN);
    // Synth: full-intensity bass kick — milkdrop sees a beat on every dblclick
    if (synthDrivesCursor) synth.pulseBeat(1.0);
  }

  requestAnimationFrame(ambientLoop);
}
requestAnimationFrame(ambientLoop);

// ── telemetry ──────────────────────────────────────────────
const fpsChip = $("#fps-chip");
const gpuChip = $("#gpu-chip");
new Telemetry({
  els: {
    fps: $("#fps"),
    gpu: $("#gpu"),
    session: $("#session"),
  },
  onUpdate: ({ fps, gpu01 }) => {
    fpsChip.textContent = fps.toFixed(1);
    gpuChip.textContent = `${Math.round(gpu01 * 100)}%`;
  },
});

// ── panel collapse / chip pairs ────────────────────────────
function wireCollapse(panel: HTMLElement, chip: HTMLElement, collapseBtn: HTMLElement): void {
  const set = (collapsed: boolean) => {
    if (collapsed) {
      panel.setAttribute("data-collapsed", "");
      chip.setAttribute("data-visible", "");
    } else {
      panel.removeAttribute("data-collapsed");
      chip.removeAttribute("data-visible");
    }
  };
  collapseBtn.addEventListener("click", () => set(true));
  chip.addEventListener("click", () => set(false));
}

wireCollapse($("#state-panel"), $("#state-chip"), $("#state-collapse"));
wireCollapse($("#sources-panel"), $("#sources-chip"), $("#sources-collapse"));

// ── dim toggle (cycles full → dim → very dim → full) ──────
const dimToggle = $<HTMLButtonElement>("#dim-toggle");
let dimLevel = 0;
dimToggle.addEventListener("click", () => {
  dimLevel = (dimLevel + 1) % 3;
  if (dimLevel === 0) document.body.removeAttribute("data-dim");
  else document.body.setAttribute("data-dim", String(dimLevel));
});

// ── VU bars ────────────────────────────────────────────────
const cursorVu = new Vu($<HTMLCanvasElement>("#vu-cursor"), "cyan");
const audioVu = new Vu($<HTMLCanvasElement>("#vu-audio"), "cyan");
const watchVu = new Vu($<HTMLCanvasElement>("#vu-watch"), "orange");

// Drive cursor VU + readout from field velocity
const cursorRateEl = $("#cursor-rate");
field.onCursorVelocity = (speedPxPerSec) => {
  // 500 px/s = full bar — feels right at normal trackpad speeds
  cursorVu.push(Math.min(1, speedPxPerSec / 500));
  cursorRateEl.textContent = `${speedPxPerSec >= 1 ? Math.round(speedPxPerSec) : "—"} px/s`;

  // While the synthetic driver is still in charge of milkdrop, let the
  // cursor modulate it: position controls bass/treble balance, velocity
  // triggers a beat envelope. This is what makes milkdrop visibly react
  // to mouse movement before real audio is shared.
  if (synthDrivesCursor) {
    const c = field.cursorPosition;
    if (c.x > -1000) {
      const x01 = c.x / window.innerWidth;
      const y01 = c.y / window.innerHeight;
      const v01 = Math.min(1, speedPxPerSec / 1200);
      synth.setCursorModulation(x01, y01, v01);
    }
  }
};

// Cursor row starts active.
const cursorRow = document.querySelector('[data-signal="cursor"]') as HTMLElement;
cursorRow?.setAttribute("data-active", "");

function refreshSignalCount(): void {
  const active = document.querySelectorAll<HTMLElement>("[data-signal][data-active]").length;
  $("#signal-count").textContent = `${active} live`;
  $("#sources-count").textContent = `${active}/5`;
  $("#sources-chip-count").textContent = `${active} live`;
}
refreshSignalCount();

// ── SKILL readout + play/pause rotation ───────────────────
const skillPlayBtn = $<HTMLButtonElement>("#skill-play");
skillPlayBtn.addEventListener("click", () => {
  if (skillPlayBtn.hasAttribute("data-playing")) stopRotation();
  else startRotation();
});

// ── image sources + slideshow ──────────────────────────────
// Slot 0 starts unbound. The user picks a source via the GALLERY row in
// SOURCES — could be the audio tab (when available) or a NASA feed.
const imageSlots = new ImageSlots(1, 1280, 720);
const tabVideoSource = new TabVideoSource();
const nasaSource = new NasaImagesSource();
// Begin pre-loading the NASA images so the source is ready when picked.
void nasaSource.ensureLoaded();

const slideshow = new Slideshow(
  imageSlots,
  0,
  $<HTMLCanvasElement>("#slideshow"),
  $("#slideshow-progress"),
);


// ── slideshow card: drag / resize / collapse ──────────────
const slideshowCard = $("#slideshow-card");
const slideshowCardCollapseBtn = $<HTMLButtonElement>("#slideshow-card-collapse");

function syncSlideshowCard(): void {
  const r = slideshow.cardRect;
  slideshowCard.style.left = `${r.x}px`;
  slideshowCard.style.top = `${r.y}px`;
  slideshowCard.style.width = `${r.w}px`;
  slideshowCard.style.height = `${r.h}px`;
  slideshowCard.toggleAttribute("data-collapsed", slideshow.isCollapsed());
}
slideshow.onCardChanged = syncSlideshowCard;
syncSlideshowCard();

// Clamp a candidate rect so the card stays mostly on-screen.
function clampRect(r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const minVisible = 60;
  return {
    x: Math.max(-(r.w - minVisible), Math.min(window.innerWidth - minVisible, r.x)),
    y: Math.max(36, Math.min(window.innerHeight - minVisible, r.y)),
    w: r.w,
    h: r.h,
  };
}

interface DragState {
  startCard: { x: number; y: number; w: number; h: number };
  startPointer: { x: number; y: number };
  handle: string | null;
}
let cardDrag: DragState | null = null;

slideshowCard.addEventListener("pointerdown", (e) => {
  const target = e.target as HTMLElement;
  // Collapse button has its own click handler; let it through.
  if (target.closest(".slideshow-card__collapse")) return;

  if (slideshow.isCollapsed()) {
    // Click anywhere on the thumb expands.
    e.preventDefault();
    slideshow.expandCard();
    return;
  }

  e.preventDefault();
  slideshowCard.setPointerCapture(e.pointerId);
  cardDrag = {
    startCard: { ...slideshow.cardRect },
    startPointer: { x: e.clientX, y: e.clientY },
    handle: target.classList.contains("slideshow-card__handle") ? (target.dataset.handle ?? null) : null,
  };
});

slideshowCard.addEventListener("pointermove", (e) => {
  if (!cardDrag) return;
  e.preventDefault();
  const dx = e.clientX - cardDrag.startPointer.x;
  const dy = e.clientY - cardDrag.startPointer.y;
  const s = cardDrag.startCard;
  const h = cardDrag.handle;

  if (h === null) {
    // Drag the whole card.
    slideshow.setCardRect(clampRect({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }));
    return;
  }

  // Resize from a corner — minimum 80x45.
  let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
  if (h.includes("r")) nw = Math.max(80, s.w + dx);
  if (h.includes("l")) { nw = Math.max(80, s.w - dx); nx = s.x + (s.w - nw); }
  if (h.includes("b")) nh = Math.max(45, s.h + dy);
  if (h.includes("t")) { nh = Math.max(45, s.h - dy); ny = s.y + (s.h - nh); }
  slideshow.setCardRect({ x: nx, y: ny, w: nw, h: nh });
});

const endDrag = (e: PointerEvent): void => {
  if (!cardDrag) return;
  try { slideshowCard.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  cardDrag = null;
};
slideshowCard.addEventListener("pointerup", endDrag);
slideshowCard.addEventListener("pointercancel", endDrag);

slideshowCardCollapseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  slideshow.collapseCard();
});

function showSlideshowCard(): void { slideshowCard.removeAttribute("data-hidden"); }
function hideSlideshowCard(): void { slideshowCard.setAttribute("data-hidden", ""); }

// ── audio capture ──────────────────────────────────────────
const audio = new AudioCapture(audioCtx);
let liveAudioSource: { ctx: AudioContext; node: AudioNode } | null = null;
audio.onSource = (source, ctx) => {
  // Real audio is here — stop the synthetic driver and route the real source
  // into BOTH backends so whichever one is active sees real reactivity.
  synthDrivesCursor = false;
  synth.stop();
  milkdrop.connectAudio(source);
  shadertoy.connectAudio(source);
  // Light up the graph-flow edges so visitors see signal traveling
  // through the chain in real time once audio is feeding the LF node.
  graphFlow.setLive(true);
  // Hold the source + context for the test-signal recorder so it can tap
  // the audio graph for a clean recording (raw MediaStream recording is
  // silent when AudioContext is already consuming the track).
  liveAudioSource = { ctx, node: source };
  const btn = document.getElementById("test-signal-btn");
  btn?.removeAttribute("data-hidden");
  // Auto-start rotation: with music playing, the user wants the visual
  // skills to cycle. First rotation lands within ~9s instead of the usual
  // 22s so the change is felt quickly after audio connects.
  startRotation(AUDIO_FIRST_ROTATION_MS);
};
audio.onVideo = (videoEl) => {
  tabVideoSource.attach(videoEl);
  // The audio-tab source becomes available. The user activates the slideshow
  // by picking it from the gallery modal (or leaves it idle).
  const audioTabBtn = document.getElementById("src-audio-tab") as HTMLButtonElement | null;
  if (audioTabBtn) audioTabBtn.disabled = false;
};
audio.onVideoEnd = () => {
  tabVideoSource.detach();
  const audioTabBtn = document.getElementById("src-audio-tab") as HTMLButtonElement | null;
  if (audioTabBtn) audioTabBtn.disabled = true;
  // If the gallery was bound to audio-tab, the slideshow source becomes
  // unavailable — stop and reset the gallery row.
  if (currentGallerySource === "audio-tab") {
    setGallerySource(null);
  }
};

// ── gallery row + source picker modal ─────────────────────
type GallerySourceId = "audio-tab" | "nasa-deep-space" | null;
let currentGallerySource: GallerySourceId = null;

const galleryRow = $("#gallery-row");
const galleryRate = galleryRow.querySelector(".signal__rate") as HTMLElement;
const galleryModal = $("#gallery-modal");
const galleryCancelBtn = $<HTMLButtonElement>("#gallery-cancel");
const galleryCloseBtn = $<HTMLButtonElement>("#gallery-modal-close");
const galleryDisconnectBtn = $<HTMLButtonElement>("#gallery-disconnect");
const galleryStatus = $("#gallery-modal-status");
const audioTabBtn = $<HTMLButtonElement>("#src-audio-tab");
const nasaBtn = $<HTMLButtonElement>("#src-nasa");

const SOURCE_LABELS: Record<Exclude<GallerySourceId, null>, string> = {
  "audio-tab": "audio tab",
  "nasa-deep-space": "nasa · deep space",
};

// Active backend tracker — drives the auto-binding of the gallery
// image feed into the shader's iChannel1. No pill, no extra click:
// if a shader is playing AND a gallery source is connected, the feed
// is live. Drop the gallery or switch backends to milkdrop and it
// unbinds. (Canva, not Photoshop.)
let activeBackend: "milkdrop" | "shadertoy" = "milkdrop";

// Dedicated 1280×720 2D canvas that mirrors the slideshow card's
// rendered output (transitions and all) into a shader-friendly buffer.
// Per-frame blit happens in pumpShaderFeed below. The shader binds to
// this canvas, never to the live slideshow canvas (which is window-
// sized + mostly transparent and produced "small fragment, rest
// black" tiling when sampled directly).
const slideshowCanvas = $<HTMLCanvasElement>("#slideshow");
const shaderFeedCanvas = document.createElement("canvas");
shaderFeedCanvas.width = 1280;
shaderFeedCanvas.height = 720;
const shaderFeedCtx = shaderFeedCanvas.getContext("2d");

function refreshShaderFeed(): void {
  const shouldFeed = activeBackend === "shadertoy" && currentGallerySource !== null;
  shadertoy.setLiveSource(shouldFeed ? shaderFeedCanvas : null);
}

// Every frame, copy the slideshow's card region into the feed canvas
// at full resolution. Preserves whatever transition / melt animation
// the slideshow is rendering, so the shader sees a living image.
// Early-out when the feed isn't active so we don't spend cycles.
function pumpShaderFeed(): void {
  if (
    shaderFeedCtx &&
    activeBackend === "shadertoy" &&
    currentGallerySource !== null
  ) {
    const cr = slideshow.cardRect;
    if (cr.w > 0 && cr.h > 0) {
      const dpr = window.devicePixelRatio || 1;
      try {
        shaderFeedCtx.drawImage(
          slideshowCanvas,
          cr.x * dpr, cr.y * dpr, cr.w * dpr, cr.h * dpr,
          0, 0, shaderFeedCanvas.width, shaderFeedCanvas.height,
        );
      } catch {
        // drawImage can throw on a tainted-cross-origin source — bail.
      }
    }
  }
  requestAnimationFrame(pumpShaderFeed);
}
requestAnimationFrame(pumpShaderFeed);

function setGallerySource(src: GallerySourceId): void {
  currentGallerySource = src;
  if (src === null) {
    imageSlots.bind(0, null);
    slideshow.stop();
    hideSlideshowCard();
    galleryRow.removeAttribute("data-active");
    galleryRate.textContent = "connect";
    refreshSignalCount();
    refreshSourceSelection();
    refreshShaderFeed();
    return;
  }
  if (src === "audio-tab") {
    imageSlots.bind(0, tabVideoSource);
  } else if (src === "nasa-deep-space") {
    imageSlots.bind(0, nasaSource);
  }
  galleryRow.setAttribute("data-active", "");
  galleryRate.textContent = SOURCE_LABELS[src];
  slideshow.start();
  showSlideshowCard();
  refreshShaderFeed();
  // Auto-collapse the prompt panel so the slideshow visualization has the
  // viewport for itself. No-op if already docked.
  void setPromptCollapsed(true);
  refreshSignalCount();
  refreshSourceSelection();
}

function refreshSourceSelection(): void {
  audioTabBtn.toggleAttribute("data-selected", currentGallerySource === "audio-tab");
  nasaBtn.toggleAttribute("data-selected", currentGallerySource === "nasa-deep-space");
  galleryDisconnectBtn.toggleAttribute("data-hidden", currentGallerySource === null);
  if (currentGallerySource) {
    galleryStatus.textContent = `live · ${SOURCE_LABELS[currentGallerySource]}`;
    galleryStatus.setAttribute("data-state", "live");
  } else {
    galleryStatus.textContent = "";
    galleryStatus.removeAttribute("data-state");
  }
}

function showGalleryModal(): void {
  refreshSourceSelection();
  galleryModal.removeAttribute("data-hidden");
  galleryModal.setAttribute("aria-hidden", "false");
}
function hideGalleryModal(): void {
  galleryModal.setAttribute("data-hidden", "");
  galleryModal.setAttribute("aria-hidden", "true");
}

galleryRow.addEventListener("click", showGalleryModal);
galleryRow.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    showGalleryModal();
  }
});
galleryCancelBtn.addEventListener("click", hideGalleryModal);
galleryCloseBtn.addEventListener("click", hideGalleryModal);
galleryModal.addEventListener("click", (e) => {
  if (e.target === galleryModal) hideGalleryModal();
});
audioTabBtn.addEventListener("click", () => {
  if (audioTabBtn.disabled) return;
  setGallerySource("audio-tab");
  setTimeout(hideGalleryModal, 500);
});
nasaBtn.addEventListener("click", () => {
  setGallerySource("nasa-deep-space");
  setTimeout(hideGalleryModal, 500);
});
galleryDisconnectBtn.addEventListener("click", () => {
  setGallerySource(null);
  hideGalleryModal();
});
const audioRow = $("#audio-row");
const audioRate = audioRow.querySelector(".signal__rate") as HTMLElement;
const micRow = $("#mic-row");
const micRate = micRow.querySelector(".signal__rate") as HTMLElement;
const micVu = new Vu($<HTMLCanvasElement>("#vu-mic"), "cyan");
const audioEnergyEl = $("#audio-energy");
/** Which audio source is currently driving the analyzer. Mic and tab
 *  are mutually exclusive — they'd compete for the same AudioContext
 *  source. Tracked here so the row UIs can reflect the active mode. */
let audioMode: "tab" | "mic" | null = null;
const spectrum = new Spectrum($<HTMLCanvasElement>("#spectrum-canvas"));

audio.onEnergy = (f: AudioFeatures) => {
  field.setAudioEnergy(f.energy);
  // Push to whichever VU bar matches the live mode so the meter
  // animates on the row the user actually clicked.
  if (audioMode === "mic") micVu.push(f.energy);
  else audioVu.push(f.energy);
  spectrum.update(f.bars);
  audioEnergyEl.textContent = f.energy.toFixed(2);
};

function rowOf(mode: "tab" | "mic"): { row: HTMLElement; rate: HTMLElement } {
  return mode === "tab" ? { row: audioRow, rate: audioRate } : { row: micRow, rate: micRate };
}

function clearActiveAudioRows(): void {
  for (const r of [audioRow, micRow]) {
    r.removeAttribute("data-active");
    r.removeAttribute("data-armed");
  }
  audioRate.textContent = "connect";
  micRate.textContent = "connect";
  document.body.classList.remove("audio-live");
  field.setAudioEnergy(0);
  audioMode = null;
}

async function armAudio(mode: "tab" | "mic" = "tab"): Promise<void> {
  // Same row clicked while live → toggle off.
  if (audio.isActive && audioMode === mode) {
    audio.stop();
    clearActiveAudioRows();
    refreshSignalCount();
    return;
  }
  // Other audio source live → swap to the requested mode.
  if (audio.isActive) {
    audio.stop();
    clearActiveAudioRows();
  }
  const { row, rate } = rowOf(mode);
  row.setAttribute("data-armed", "");
  rate.textContent = mode === "tab" ? "sharing…" : "listening…";
  const result = await (mode === "mic" ? audio.startMic() : audio.startTab());
  row.removeAttribute("data-armed");
  if (result.ok) {
    audioMode = mode;
    document.body.classList.add("audio-live");
    row.setAttribute("data-active", "");
    rate.textContent = "live";
    refreshSignalCount();
  } else {
    if (result.reason === "no_audio_track") {
      rate.textContent = "no audio";
      setTimeout(() => {
        if (!audio.isActive) rate.textContent = "connect";
      }, 2400);
    } else {
      rate.textContent = "connect";
    }
  }
}

// Click handlers — tab vs mic just pass the mode through.
audioRow.addEventListener("click", () => { void armAudio("tab"); });
micRow.addEventListener("click", () => { void armAudio("mic"); });

// Persistent audio pin — same handler as the SOURCES row, but lives
// outside the fade-on-idle layer so it's the always-reachable lifeline.
const audioPinBtn = document.getElementById("audio-pin") as HTMLButtonElement | null;
audioPinBtn?.addEventListener("click", () => { void armAudio("tab"); });

// Test-signal recorder — wire the SOURCES "save 30s as test signal" pill.
const testSignalBtn = document.getElementById("test-signal-btn") as HTMLButtonElement | null;
const testSignalLabel = testSignalBtn?.querySelector<HTMLElement>(".test-signal-btn__label");
const testSignalIcon = testSignalBtn?.querySelector<HTMLElement>(".test-signal-btn__icon");
const recorder = new TestSignalRecorder();
recorder.onStatus = (s, payload) => {
  if (!testSignalBtn || !testSignalLabel || !testSignalIcon) return;
  switch (s) {
    case "recording":
      testSignalBtn.setAttribute("data-recording", "");
      testSignalBtn.removeAttribute("data-saved");
      testSignalIcon.textContent = "●";
      testSignalLabel.textContent = "recording 30s…";
      testSignalBtn.disabled = true;
      break;
    case "encoding":
      testSignalLabel.textContent = "encoding…";
      break;
    case "saved": {
      testSignalBtn.removeAttribute("data-recording");
      testSignalBtn.setAttribute("data-saved", "");
      testSignalBtn.disabled = false;
      testSignalIcon.textContent = "✓";
      const kb = ((payload?.sizeBytes ?? 0) / 1024).toFixed(0);
      testSignalLabel.textContent = `saved ${kb}KB — drop in public/audio/test-signal.webm`;
      // Auto-revert the label after 12s so a follow-up record can happen.
      setTimeout(() => {
        if (testSignalBtn.hasAttribute("data-saved")) {
          testSignalIcon.textContent = "💾";
          testSignalLabel.textContent = "re-record 30s as test signal";
        }
      }, 12_000);
      break;
    }
    case "error":
      testSignalBtn.removeAttribute("data-recording");
      testSignalBtn.disabled = false;
      testSignalIcon.textContent = "⚠";
      testSignalLabel.textContent = payload?.error ?? "record failed";
      break;
    case "idle":
      break;
  }
};
testSignalBtn?.addEventListener("click", () => {
  if (!liveAudioSource) {
    console.warn("[test-signal] no live audio source");
    return;
  }
  void recorder.record(liveAudioSource.ctx, liveAudioSource.node);
});
audioRow.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    void armAudio();
  }
});

// Hover hint — gently brighten the field to preview what audio unlocks.
audioRow.addEventListener("pointerenter", () => {
  if (!audio.isActive) field.setAudioEnergy(0.18);
});
audioRow.addEventListener("pointerleave", () => {
  if (!audio.isActive) field.setAudioEnergy(0);
});

// ── prompt input ────────────────────────────────────────────
const promptInput = $<HTMLTextAreaElement>("#prompt-input");
const generateBtn = $<HTMLButtonElement>("#generate-btn");
const promptPanel = $("#prompt-panel");
const promptCollapseBtn = $<HTMLButtonElement>("#prompt-collapse");
const promptRestoreBtn = $<HTMLButtonElement>("#prompt-restore");

let generating = false;
const generateBtnLabel = generateBtn.querySelector<HTMLElement>(".label");
const generateBtnIcon = generateBtn.querySelector<HTMLElement>(".btn__icon");
async function tryGenerate(): Promise<void> {
  if (generating) return;
  const text = promptInput.value.trim();
  if (!text) {
    promptInput.focus();
    return;
  }
  generating = true;
  generateBtn.classList.add("flash");
  generateBtn.disabled = true;
  promptPanel.setAttribute("data-generating", "");
  // Swap the button content while thinking so the action is obviously
  // in-flight (vs the panel just sitting there for a second).
  if (generateBtnLabel) generateBtnLabel.textContent = "thinking";
  if (generateBtnIcon) generateBtnIcon.textContent = "◐";
  // Headline UX: dock the prompt to the bottom-bar immediately so the
  // canvas + thinking popup own the center of the screen. Fire-and-
  // forget the dock animation; it runs in parallel with the API call.
  void setPromptCollapsed(true);
  showThinking(text);
  // Stop auto-rotation while a user-driven graph is loading — otherwise
  // the next rotate tick clobbers the chosen preset within seconds.
  stopRotation();
  const skillEl = document.getElementById("skill");
  skillEl?.classList.add("is-loading");
  if (skillEl) skillEl.textContent = "thinking…";
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        currentGraph: runtime.current,
        metadata: ambient.sample(),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `generate ${res.status}`);
    }
    const data = (await res.json()) as { graph: PrismGraph };
    const result = runtime.apply(data.graph);
    if (!result.ok) {
      throw new Error(result.error ?? "graph runtime failed");
    }
    activeBackend = result.backend ?? activeBackend;
    refreshShaderFeed();
    graphFlow.render(data.graph);
    updateSkillDisplay(data.graph.intent, true);
    showResult(data.graph.intent);
  } catch (err) {
    const msg = (err as Error).message || "generate failed";
    console.warn("prism · generate failed", err);
    // Surface failures in the SKILL readout so silent 404s / API-key
    // misconfigurations don't look like a no-op to the visitor.
    updateSkillDisplay(`error · ${msg}`);
    setTimeout(() => updateSkillDisplay(milkdrop.presetName), 3200);
  } finally {
    skillEl?.classList.remove("is-loading");
    hideThinking();
    setTimeout(() => generateBtn.classList.remove("flash"), 400);
    generateBtn.disabled = false;
    promptPanel.removeAttribute("data-generating");
    if (generateBtnLabel) generateBtnLabel.textContent = "generate";
    if (generateBtnIcon) generateBtnIcon.textContent = "▶";
    generating = false;
  }
}

generateBtn.addEventListener("click", () => { void tryGenerate(); });

promptInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const isMeta = e.metaKey || e.ctrlKey;
  const isDocked = promptPanel.hasAttribute("data-collapsed");
  // Submit on ⌘↵ always; submit on plain Enter when docked (single-line bar);
  // otherwise allow Enter to insert a newline in the centered multi-line panel.
  if (isMeta || (isDocked && !e.shiftKey)) {
    e.preventDefault();
    void tryGenerate();
  }
});

// Dock / restore the prompt — animated fade-out, snap layout, fade-in.
// The layout switch (centered ↔ docked) involves so many simultaneously
// changing properties (position, transform, flex-direction, dimensions)
// that animating them directly is jank-prone. Instead we fade the panel
// to opacity 0, change the layout in one frame, then fade back in.
let promptTransitioning = false;
async function setPromptCollapsed(collapsed: boolean): Promise<void> {
  if (promptTransitioning) return;
  if (collapsed === promptPanel.hasAttribute("data-collapsed")) return;
  promptTransitioning = true;
  // Release the entrance animation's forwards-locked opacity so inline
  // opacity transitions can take effect.
  promptPanel.style.animation = "none";
  promptPanel.style.transition = "opacity 140ms cubic-bezier(0.2, 0.7, 0.2, 1)";
  promptPanel.style.opacity = "0";
  await new Promise<void>((r) => setTimeout(r, 150));
  if (collapsed) promptPanel.setAttribute("data-collapsed", "");
  else promptPanel.removeAttribute("data-collapsed");
  // Wait one frame so the browser commits the layout change with opacity:0,
  // then fade back in. This guarantees the size/position swap is invisible.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  promptPanel.style.opacity = "1";
  if (!collapsed) setTimeout(() => promptInput.focus(), 150);
  await new Promise<void>((r) => setTimeout(r, 160));
  promptTransitioning = false;
}

promptCollapseBtn.addEventListener("click", () => { void setPromptCollapsed(true); });
promptRestoreBtn.addEventListener("click", () => { void setPromptCollapsed(false); });

// ── suggestion chips ──────────────────────────────────────
// "Describe a visualization" is a blank-canvas problem — most visitors
// freeze. These chips put VJ-community vocabulary in their face so the
// loop is one click away. Mix of vibe / theme / form keywords. Picking
// 8 random ones per page load keeps the surface fresh.
const CHIP_PROMPTS: ReadonlyArray<string> = [
  "calming cosmic nebula",
  "fractal kaleidoscope",
  "dreamy dark mirage",
  "wormhole tunnel at light speed",
  "plants growing slowly",
  "stormy sea at dusk",
  "geometric neon shapes pulsing",
  "warm painterly fire",
  "fluid paint spilling with bass",
  "industrial chains breaking",
  "frosty crystal cave",
  "a single luminous orb",
  "sunflower opening",
  "skylight cathedral",
];

const promptChips = document.getElementById("prompt-chips");
if (promptChips) {
  const pool = [...CHIP_PROMPTS];
  // Fisher-Yates shuffle for a fresh ordering each load.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const text of pool.slice(0, 8)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt-chip";
    btn.setAttribute("role", "listitem");
    btn.textContent = text;
    btn.addEventListener("click", () => {
      promptInput.value = text;
      void tryGenerate();
    });
    promptChips.appendChild(btn);
  }
}

// Onboarding nudge — rotate the prompt placeholder every few seconds
// through example vocabulary so first-time visitors discover what to
// type without any new UI surface. Stops mutating when the field is
// focused or non-empty so it never disrupts a user mid-thought.
let placeholderNudgeTimer: number | null = null;
function startPlaceholderNudge(): void {
  if (placeholderNudgeTimer != null) return;
  const tick = (): void => {
    if (promptInput.value === "" && document.activeElement !== promptInput) {
      const pick = CHIP_PROMPTS[Math.floor(Math.random() * CHIP_PROMPTS.length)];
      promptInput.placeholder = `try: ${pick}`;
    }
    placeholderNudgeTimer = window.setTimeout(tick, 5500);
  };
  // Hold the original placeholder for 7s before first rotation so
  // newcomers can read it.
  placeholderNudgeTimer = window.setTimeout(tick, 7000);
}
startPlaceholderNudge();

// Global ⌘K / ⌘L → focus prompt
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    promptInput.focus();
  }
});

// ── Pulsoid heart-rate ─────────────────────────────────────
const pulsoid = new PulsoidStream();
const watchRow = $("#watch-row");
const watchRate = watchRow.querySelector(".signal__rate") as HTMLElement;
const watchModal = $("#watch-modal");
const tokenInput = $<HTMLInputElement>("#watch-token-input");
const modalStatus = $("#watch-modal-status");
const connectBtn = $<HTMLButtonElement>("#watch-connect");
const cancelBtn = $<HTMLButtonElement>("#watch-cancel");
const closeBtn = $<HTMLButtonElement>("#watch-modal-close");
const disconnectBtn = $<HTMLButtonElement>("#watch-disconnect");
const simulateBtn = $<HTMLButtonElement>("#watch-simulate");

function showWatchModal(): void {
  const existing = PulsoidStream.loadToken();
  if (existing) {
    tokenInput.value = existing;
    disconnectBtn.toggleAttribute("data-hidden", !pulsoid.isLive);
  } else {
    tokenInput.value = "";
    disconnectBtn.setAttribute("data-hidden", "");
  }
  modalStatus.textContent = pulsoid.isLive ? `live · ${pulsoid.currentBpm} bpm` : "";
  modalStatus.removeAttribute("data-state");
  if (pulsoid.isLive) modalStatus.setAttribute("data-state", "live");
  watchModal.removeAttribute("data-hidden");
  watchModal.setAttribute("aria-hidden", "false");
  setTimeout(() => tokenInput.focus(), 80);
}
function hideWatchModal(): void {
  watchModal.setAttribute("data-hidden", "");
  watchModal.setAttribute("aria-hidden", "true");
}

watchRow.addEventListener("click", showWatchModal);
watchRow.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    showWatchModal();
  }
});
cancelBtn.addEventListener("click", hideWatchModal);
closeBtn.addEventListener("click", hideWatchModal);
watchModal.addEventListener("click", (e) => {
  if (e.target === watchModal) hideWatchModal();
});

connectBtn.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  if (!token) {
    modalStatus.textContent = "paste a token first";
    modalStatus.setAttribute("data-state", "error");
    tokenInput.focus();
    return;
  }
  PulsoidStream.saveToken(token);
  pulsoid.connect(token);
});

disconnectBtn.addEventListener("click", () => {
  pulsoid.disconnect();
  PulsoidStream.clearToken();
  hideWatchModal();
});

simulateBtn.addEventListener("click", () => {
  pulsoid.simulate(72);
});

pulsoid.onStatus = (status, msg) => {
  modalStatus.removeAttribute("data-state");
  switch (status) {
    case "connecting":
      modalStatus.textContent = "connecting…";
      watchRate.textContent = "reconnecting";
      break;
    case "live": {
      const tag = pulsoid.isSimulated ? "demo" : "live";
      modalStatus.textContent = `${tag} · ${pulsoid.currentBpm || "—"} bpm`;
      modalStatus.setAttribute("data-state", "live");
      watchRow.setAttribute("data-active", "");
      document.body.classList.add("watch-live");
      refreshSignalCount();
      // auto-hide modal after a moment so the user sees the live state
      setTimeout(hideWatchModal, 700);
      break;
    }
    case "error":
      modalStatus.textContent = msg ?? "error";
      modalStatus.setAttribute("data-state", "error");
      watchRow.removeAttribute("data-active");
      document.body.classList.remove("watch-live");
      watchRate.textContent = "error";
      refreshSignalCount();
      break;
    case "offline":
      modalStatus.textContent = "";
      watchRow.removeAttribute("data-active");
      document.body.classList.remove("watch-live");
      watchRate.textContent = "connect";
      refreshSignalCount();
      break;
    case "idle":
      break;
  }
};

pulsoid.onHeartRate = (bpm) => {
  const tag = pulsoid.isSimulated ? " · sim" : "";
  watchRate.textContent = `${bpm} bpm${tag}`;
  document.body.style.setProperty("--bpm", String(bpm));
};

pulsoid.onBeat = () => {
  // VU pulse
  watchVu.push(1);
  // Orange shockwave from the cursor — slightly bigger now since the
  // heartbeat is the user's own signal and deserves more presence.
  field.emitRingAtCursor(0.85, ORANGE);
  // Inject a bass-kick into the synthetic signal — milkdrop sees the
  // spectrum spike and reacts as if a kick drum just landed. The
  // heartbeat becomes the bass beat of the visualization.
  if (synthDrivesCursor) synth.pulseBeat(0.95);
};

// Auto-reconnect on load if we already have a saved token.
const savedToken = PulsoidStream.loadToken();
if (savedToken) pulsoid.connect(savedToken);

// ── teardown on hot-reload (Vite) ───────────────────────────
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    milkdrop.destroy();
    field.destroy();
    audio.stop();
    synth.stop();
    inputPulses.destroy();
    void audioCtx.close();
  });
}
