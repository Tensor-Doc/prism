// player.ts — public PrismPlayer class.
//
// Owns a small DOM tree (two stacked <canvas> elements inside `container`),
// an AudioContext, a SyntheticSignal (the default audio driver), the two
// rendering backends, and a GraphRuntime that swaps between them.
//
// Minimal usage:
//
//   const player = new PrismPlayer({ container: el, graph });
//
// The caller can override the audio source any time via connectAudio(),
// swap graphs via load(), or pipe a live texture into iChannel1 via
// setLiveSource(). Backends + runtime + synth + audioCtx are exposed
// readonly so embedders can drive them directly (read presetName, fire
// pulseBeat from an external trigger, etc.) without re-creating the API.

import { createMilkdropBackground, type MilkdropBg } from "./backends/milkdrop";
import { createShadertoyBackground, type ShadertoyBg } from "./backends/shadertoy";
import { HeadlessSlideshow } from "./image-feed";
import { shortIdToGraph } from "./registry";
import { GraphRuntime, type ApplyResult } from "./runtime";
import { SyntheticSignal } from "./synth";
import type { PrismGraph } from "./types";

/** Anything `load()` and the `graph` option accept. A string is treated
 *  as a catalog short_id (6-char base62) and resolved against the
 *  bundled registry. */
export type GraphInput = PrismGraph | string;

/** Anything the `image` option / `connectImage()` accepts. Strings
 *  beyond the "webcam" / "tab" sentinels are treated as static URLs. */
export type ImageSource =
  | "webcam"
  | "tab"
  | string
  | string[]
  | HTMLCanvasElement
  | HTMLVideoElement
  | MediaStream;

export interface PrismPlayerOptions {
  /** Where to mount the visualization canvases. Pass either an element
   *  (preferred from frameworks — React refs, Vue template refs, etc.)
   *  or a DOM id string for hand-written HTML embeds. The player
   *  creates its own canvases inside; it does not touch any children
   *  that already exist there. */
  container: HTMLElement | string;
  /** Optional initial graph. Pass a PrismGraph object directly, or a
   *  6-char short_id string (e.g. "7Hq3pK") to look up an entry from
   *  the bundled catalog. Without it, cold-opens on a curated milkdrop
   *  preset; you can call load() later. */
  graph?: GraphInput;
  /** Audio source. An AudioNode is connected directly; "mic" and "tab"
   *  request the matching media stream via getUserMedia /
   *  getDisplayMedia and connect that. Undefined → the built-in
   *  SyntheticSignal drives both backends. */
  audio?: "mic" | "tab" | MediaStream | AudioNode;
  /** Bring your own AudioContext (useful when the embedder already has
   *  one; web pages can only have a small number of them). */
  audioCtx?: AudioContext;
  /** iChannel1 fallback used by shader backends until something more
   *  specific is bound by the graph or setLiveSource(). */
  defaultImage?: string;
  /** Image feed for shader backends (bound to iChannel1). Accepts:
   *    - A single URL                          → static image
   *    - An array of URLs                      → built-in crossfading slideshow
   *    - "webcam" / "tab"                      → getUserMedia / getDisplayMedia
   *    - a MediaStream / HTMLVideoElement      → live video
   *    - an HTMLCanvasElement                  → live canvas (e.g. your own
   *                                              renderer; the player just
   *                                              re-uploads its contents every
   *                                              frame)
   *  Use this for "I want pictures showing through the shader" without
   *  thinking about iChannel1 or setLiveSource. */
  image?: ImageSource;
  /** Seconds each image is held on-screen before the crossfade to the
   *  next begins. Only used when `image` is a URL array. Defaults to 6. */
  holdSeconds?: number;
  /** Milkdrop preset to load on cold-open. Falls back to a random preset
   *  from the bundled library if the name isn't found. */
  initialPresetName?: string;
  /** Called once the first frame has painted. */
  onReady?: () => void;
  /** Async failures (audio capture rejection, graph load errors that
   *  cannot be surfaced from a synchronous call) land here. */
  onError?: (err: Error) => void;
}

export class PrismPlayer {
  /** AudioContext driving both backends + the default synthetic signal.
   *  Created on construction unless one was passed in `opts.audioCtx`. */
  readonly audioCtx: AudioContext;
  /** Default audio driver: a silent "pink-noise-ish" pad that keeps the
   *  visualization animated when no real audio is connected. Kept alive
   *  for the lifetime of the player — call `player.synth.stop()` if you
   *  want to free it after switching to a real audio source. */
  readonly synth: SyntheticSignal;
  /** Milkdrop (butterchurn) backend handle. Cold-opens on a random
   *  preset (or `initialPresetName` if you passed one). */
  readonly milkdrop: MilkdropBg;
  /** Shadertoy backend handle. Idle until a graph with `lf.shadertoy` is
   *  loaded (or you call `shadertoy.loadFromUrl` directly). */
  readonly shadertoy: ShadertoyBg;
  /** Graph executor — dispatches to the right backend based on the
   *  graph's light-field generator node. */
  readonly runtime: GraphRuntime;
  /** Tracks which backend's canvas is currently visible. */
  activeBackend: "milkdrop" | "shadertoy" = "milkdrop";

  private readonly milkdropCanvas: HTMLCanvasElement;
  private readonly shadertoyCanvas: HTMLCanvasElement;
  private readonly ownsAudioCtx: boolean;
  /** Default hold per image when `image` is a URL list; set in ctor. */
  private readonly defaultHoldSeconds: number;
  /** Owned media resources (MediaStreams we started, <video> elements
   *  we created internally, headless slideshow). Cleaned up by
   *  connectImage() before re-binding and by destroy() on teardown. */
  private currentSlideshow: HeadlessSlideshow | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private currentStream: MediaStream | null = null;
  /** Audio MediaStream the player started itself ("mic" / "tab"). Held
   *  so disconnectAudio() can stop the tracks. Null if the caller
   *  passed in their own stream/node (we never stop tracks we don't own). */
  private currentAudioOwnedStream: MediaStream | null = null;

  constructor(opts: PrismPlayerOptions) {
    const container = resolveContainer(opts.container);

    this.audioCtx = opts.audioCtx ?? new AudioContext();
    this.ownsAudioCtx = opts.audioCtx === undefined;
    this.defaultHoldSeconds = opts.holdSeconds ?? 6;
    this.synth = new SyntheticSignal(this.audioCtx);

    // Two stacked canvases — opacity-crossfaded by setActiveBackend.
    // Match the legacy id/class pair so existing CSS (cold-open animation,
    // bg-canvas--hidden/--active modifiers) still applies on prism.scott.ai.
    this.milkdropCanvas = createCanvas("milkdrop");
    this.shadertoyCanvas = createCanvas("shadertoy");
    this.shadertoyCanvas.classList.add("bg-canvas--hidden");
    container.appendChild(this.milkdropCanvas);
    container.appendChild(this.shadertoyCanvas);

    this.milkdrop = createMilkdropBackground(
      this.audioCtx,
      this.milkdropCanvas,
      this.synth.getOutput(),
      opts.onReady,
      { initialPresetName: opts.initialPresetName },
    );
    this.shadertoy = createShadertoyBackground(
      this.audioCtx,
      this.shadertoyCanvas,
      this.synth.getOutput(),
    );

    if (opts.defaultImage) {
      void this.shadertoy.bindImage(opts.defaultImage).catch((err: Error) => {
        opts.onError?.(err);
      });
    }

    this.runtime = new GraphRuntime({
      milkdrop: this.milkdrop,
      shadertoy: this.shadertoy,
      setActiveBackend: (which) => this.setActiveBackend(which),
    });

    if (opts.graph !== undefined) {
      const result = this.load(opts.graph);
      if (!result.ok && opts.onError) {
        opts.onError(new Error(result.error ?? "graph apply failed"));
      }
    }

    if (opts.audio !== undefined) {
      void this.connectAudio(opts.audio).catch((err: Error) => opts.onError?.(err));
    }

    if (opts.image !== undefined) {
      void this.connectImage(opts.image).catch((err: Error) => opts.onError?.(err));
    }
  }

  /** Swap to a new graph. Accepts either a full PrismGraph object or a
   *  6-char short_id string from the bundled registry. Returns the
   *  ApplyResult the runtime emits so the caller can react to backend
   *  switches / errors. An unknown short_id returns
   *  `{ ok: false, error: "unknown short_id ..." }` without touching
   *  the running visualization. */
  load(graph: GraphInput, blendSeconds?: number): ApplyResult {
    if (typeof graph === "string") {
      const resolved = shortIdToGraph(graph);
      if (!resolved) {
        return { ok: false, error: `unknown short_id: ${graph}` };
      }
      return this.runtime.apply(resolved, blendSeconds);
    }
    return this.runtime.apply(graph, blendSeconds);
  }

  /** Connect a new audio source. Accepts:
   *    - "mic"        — getUserMedia({ audio: true })
   *    - "tab"        — getDisplayMedia({ audio: true })
   *    - MediaStream  — wrapped in a MediaStreamAudioSourceNode
   *    - AudioNode    — connected directly
   *  Routes the source to both backends so whichever one is active sees
   *  reactivity. Tracks any MediaStream the player started itself so
   *  disconnectAudio() can stop the tracks (mic indicator off, etc.). */
  async connectAudio(source: "mic" | "tab" | MediaStream | AudioNode): Promise<AudioNode> {
    const { node, owned } = await this.resolveAudioNode(source);
    this.milkdrop.connectAudio(node);
    this.shadertoy.connectAudio(node);
    this.currentAudioOwnedStream = owned;
    return node;
  }

  /** Disconnect the current audio source and revert both backends to
   *  the built-in SyntheticSignal. Stops any MediaStream tracks the
   *  player started itself (mic / tab capture indicator goes off).
   *  Streams or AudioNodes the caller passed in are left untouched —
   *  the caller owns their lifetime. Idempotent. */
  disconnectAudio(): void {
    if (this.currentAudioOwnedStream) {
      for (const track of this.currentAudioOwnedStream.getTracks()) track.stop();
      this.currentAudioOwnedStream = null;
    }
    const fallback = this.synth.getOutput();
    this.milkdrop.connectAudio(fallback);
    this.shadertoy.connectAudio(fallback);
  }

  /** Pipe a live source (e.g. a slideshow's canvas) into iChannel1 — its
   *  contents are re-uploaded each frame. Pass null to disable.
   *  Most embedders should prefer connectImage(), which handles
   *  webcam/tab/slideshow plumbing for you. */
  setLiveSource(source: HTMLCanvasElement | HTMLVideoElement | null): void {
    this.shadertoy.setLiveSource(source);
  }

  /** Connect an image source for the shader's iChannel1. Symmetric to
   *  connectAudio. Replaces any prior image feed; old MediaStream
   *  tracks are stopped and internal slideshow timers are cleared.
   *  See ImageSource for the accepted shapes. */
  async connectImage(source: ImageSource): Promise<void> {
    this.teardownImageFeed();
    if (typeof source === "string") {
      if (source === "webcam") {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.bindStream(stream);
        return;
      }
      if (source === "tab") {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        this.bindStream(stream);
        return;
      }
      // Treat any other string as a static image URL.
      this.setLiveSource(null);
      await this.shadertoy.bindImage(source);
      return;
    }
    if (Array.isArray(source)) {
      const slideshow = new HeadlessSlideshow(source, { holdSeconds: this.defaultHoldSeconds });
      this.currentSlideshow = slideshow;
      this.setLiveSource(slideshow.canvas);
      return;
    }
    if (source instanceof MediaStream) {
      this.bindStream(source);
      return;
    }
    // Canvas or video element passed in directly — wire it as the
    // live source without owning it (caller manages its lifetime).
    this.setLiveSource(source);
  }

  /** Stop the current image feed and unbind from the shader. Releases
   *  resources the player owned: slideshow timer cleared, MediaStream
   *  tracks stopped (webcam light off), internal <video> detached.
   *  Canvas/video elements the caller passed in are left untouched.
   *  After this, the shader reverts to whatever was last bound via
   *  `defaultImage` or `shadertoy.bindImage()` (or the 1×1 placeholder).
   *  Idempotent. */
  disconnectImage(): void {
    this.teardownImageFeed();
  }

  /** Toggle which backend's canvas is visible. Called by GraphRuntime;
   *  callers can flip it manually too (rare). */
  setActiveBackend(which: "milkdrop" | "shadertoy"): void {
    this.activeBackend = which;
    if (which === "milkdrop") {
      this.milkdropCanvas.classList.remove("bg-canvas--hidden");
      this.milkdropCanvas.classList.add("bg-canvas--active");
      this.shadertoyCanvas.classList.add("bg-canvas--hidden");
      this.shadertoyCanvas.classList.remove("bg-canvas--active");
    } else {
      this.shadertoyCanvas.classList.remove("bg-canvas--hidden");
      this.shadertoyCanvas.classList.add("bg-canvas--active");
      this.milkdropCanvas.classList.add("bg-canvas--hidden");
      this.milkdropCanvas.classList.remove("bg-canvas--active");
    }
  }

  /** Stop animation, free GL resources, detach canvases, close the
   *  AudioContext (only if the player created it itself). */
  destroy(): void {
    this.teardownImageFeed();
    if (this.currentAudioOwnedStream) {
      for (const track of this.currentAudioOwnedStream.getTracks()) track.stop();
      this.currentAudioOwnedStream = null;
    }
    this.milkdrop.destroy();
    this.shadertoy.destroy();
    this.synth.stop();
    this.milkdropCanvas.remove();
    this.shadertoyCanvas.remove();
    if (this.ownsAudioCtx) {
      void this.audioCtx.close();
    }
  }

  /** Wrap a MediaStream in an autoplaying <video> and bind that as the
   *  live source. The video element is held internally; teardown is
   *  handled by teardownImageFeed(). */
  private bindStream(stream: MediaStream): void {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    // Auto-play may reject (Safari, autoplay policy); we ignore — the
    // user gesture that opened the stream usually satisfies the policy.
    void video.play().catch(() => undefined);
    this.currentVideo = video;
    this.currentStream = stream;
    this.setLiveSource(video);
  }

  /** Stop the current image feed (slideshow timer, MediaStream tracks,
   *  internal <video>) and unbind from the shader. Idempotent. */
  private teardownImageFeed(): void {
    if (this.currentSlideshow) {
      this.currentSlideshow.destroy();
      this.currentSlideshow = null;
    }
    if (this.currentStream) {
      for (const track of this.currentStream.getTracks()) track.stop();
      this.currentStream = null;
    }
    if (this.currentVideo) {
      this.currentVideo.srcObject = null;
      this.currentVideo = null;
    }
    this.setLiveSource(null);
  }

  private async resolveAudioNode(
    source: "mic" | "tab" | MediaStream | AudioNode,
  ): Promise<{ node: AudioNode; owned: MediaStream | null }> {
    if (source instanceof AudioNode) return { node: source, owned: null };
    let stream: MediaStream;
    let owned = false;
    if (source instanceof MediaStream) {
      stream = source;
    } else if (source === "mic") {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      owned = true;
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
      owned = true;
    }
    return {
      node: this.audioCtx.createMediaStreamSource(stream),
      owned: owned ? stream : null,
    };
  }
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== "string") return container;
  const el = document.getElementById(container);
  if (!el) {
    throw new Error(`PrismPlayer: no element found with id "${container}"`);
  }
  return el;
}

function createCanvas(id: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.id = id;
  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}
