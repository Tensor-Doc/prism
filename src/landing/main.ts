// main.ts — landing page entry point.
// Orchestrates the background field, telemetry, VU bars, audio capture,
// and prompt-input keyboard handling. Touches no studio code on this pass.

import { CursorField } from "./cursor-field";
import { Telemetry } from "./telemetry";
import { Vu } from "./vu";
import { Spectrum } from "./spectrum";
import { AudioCapture, type AudioFeatures } from "./audio";
import { createMilkdropBackground } from "./milkdrop-bg";
import { GraphRuntime } from "./graph/runtime";
import type { PrismGraph } from "./graph/types";
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

// ── rotation helpers (declared first so onReady / onSource can call them) ──
const ROTATE_INTERVAL_MS = 22_000;
const ROTATE_BLEND_S = 3;
const AUDIO_FIRST_ROTATION_MS = 9_000; // first new preset within 9s of audio
let rotateTimer: number | null = null;

function updateSkillDisplay(name: string): void {
  const display = name.length > 26 ? name.slice(0, 24) + "…" : name;
  const el = document.getElementById("skill");
  if (el) {
    el.textContent = display;
    el.title = name;
  }
}

function startRotation(initialMs = ROTATE_INTERVAL_MS): void {
  if (rotateTimer != null) return;
  const tick = (): void => {
    const newName = milkdrop.loadRandom(ROTATE_BLEND_S);
    updateSkillDisplay(newName);
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
const milkdrop = createMilkdropBackground(
  audioCtx,
  $<HTMLCanvasElement>("#milkdrop"),
  synth.getOutput(),
  () => {
    // First milkdrop frame painted — clear the loading state.
    skillElEarly?.classList.remove("is-loading");
    updateSkillDisplay(milkdrop.presetName);
  },
);
const field = new CursorField($<HTMLCanvasElement>("#field"));
const runtime = new GraphRuntime({ milkdrop });

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
audio.onSource = (source) => {
  // Real audio is here — stop the synthetic driver and route the real source
  // into butterchurn so the preset reacts to actual music.
  synthDrivesCursor = false;
  synth.stop();
  milkdrop.connectAudio(source);
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
const audioEnergyEl = $("#audio-energy");
const spectrum = new Spectrum($<HTMLCanvasElement>("#spectrum-canvas"));

audio.onEnergy = (f: AudioFeatures) => {
  field.setAudioEnergy(f.energy);
  audioVu.push(f.energy);
  spectrum.update(f.bars);
  audioEnergyEl.textContent = f.energy.toFixed(2);
};

async function armAudio(): Promise<void> {
  if (audio.isActive) {
    audio.stop();
    audioRow.removeAttribute("data-active");
    audioRow.removeAttribute("data-armed");
    document.body.classList.remove("audio-live");
    audioRate.textContent = "connect";
    field.setAudioEnergy(0);
    refreshSignalCount();
    return;
  }
  audioRow.setAttribute("data-armed", "");
  audioRate.textContent = "sharing…";
  const result = await audio.start();
  audioRow.removeAttribute("data-armed");
  if (result.ok) {
    document.body.classList.add("audio-live");
    audioRow.setAttribute("data-active", "");
    audioRate.textContent = "live";
    refreshSignalCount();
  } else {
    if (result.reason === "no_audio_track") {
      audioRate.textContent = "no audio";
      setTimeout(() => {
        if (!audio.isActive) audioRate.textContent = "connect";
      }, 2400);
    } else {
      audioRate.textContent = "connect";
    }
  }
}

// Click the row (or Enter/Space when focused) to connect audio.
audioRow.addEventListener("click", () => { void armAudio(); });
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
async function tryGenerate(): Promise<void> {
  if (generating) return;
  const text = promptInput.value.trim();
  if (!text) {
    promptInput.focus();
    return;
  }
  generating = true;
  generateBtn.classList.add("flash");
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
    updateSkillDisplay(data.graph.intent);
  } catch (err) {
    const msg = (err as Error).message || "generate failed";
    console.warn("prism · generate failed", err);
    // Surface failures in the SKILL readout so silent 404s / API-key
    // misconfigurations don't look like a no-op to the visitor.
    updateSkillDisplay(`error · ${msg}`);
    setTimeout(() => updateSkillDisplay(milkdrop.presetName), 3200);
  } finally {
    skillEl?.classList.remove("is-loading");
    setTimeout(() => generateBtn.classList.remove("flash"), 400);
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
