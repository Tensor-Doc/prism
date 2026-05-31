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
import { GraphRuntime, type ApplyResult } from "./runtime";
import { SyntheticSignal } from "./synth";
import type { PrismGraph } from "./types";

export interface PrismPlayerOptions {
  /** Element to mount the visualization canvases in. The player creates
   *  its own canvases inside (it does not touch any children that already
   *  exist there). */
  container: HTMLElement;
  /** Optional initial graph. Without it the player cold-opens on a
   *  curated milkdrop preset; call load() later to swap to your graph. */
  graph?: PrismGraph;
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

  constructor(opts: PrismPlayerOptions) {
    this.audioCtx = opts.audioCtx ?? new AudioContext();
    this.ownsAudioCtx = opts.audioCtx === undefined;
    this.synth = new SyntheticSignal(this.audioCtx);

    // Two stacked canvases — opacity-crossfaded by setActiveBackend.
    // Match the legacy id/class pair so existing CSS (cold-open animation,
    // bg-canvas--hidden/--active modifiers) still applies on prism.run.
    this.milkdropCanvas = createCanvas("milkdrop");
    this.shadertoyCanvas = createCanvas("shadertoy");
    this.shadertoyCanvas.classList.add("bg-canvas--hidden");
    opts.container.appendChild(this.milkdropCanvas);
    opts.container.appendChild(this.shadertoyCanvas);

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

    if (opts.graph) {
      const result = this.runtime.apply(opts.graph);
      if (!result.ok && opts.onError) {
        opts.onError(new Error(result.error ?? "graph apply failed"));
      }
    }

    if (opts.audio !== undefined) {
      void this.connectAudio(opts.audio).catch((err: Error) => opts.onError?.(err));
    }
  }

  /** Swap to a new graph. Returns the same ApplyResult the runtime emits
   *  so the caller can react to backend switches / errors. */
  load(graph: PrismGraph, blendSeconds?: number): ApplyResult {
    const result = this.runtime.apply(graph, blendSeconds);
    return result;
  }

  /** Connect a new audio source. Accepts:
   *    - "mic"        — getUserMedia({ audio: true })
   *    - "tab"        — getDisplayMedia({ audio: true })
   *    - MediaStream  — wrapped in a MediaStreamAudioSourceNode
   *    - AudioNode    — connected directly
   *  Routes the source to both backends so whichever one is active sees
   *  reactivity. The synthetic driver is left running; call
   *  `player.synth.stop()` if you'd like to free it. */
  async connectAudio(source: "mic" | "tab" | MediaStream | AudioNode): Promise<AudioNode> {
    const node = await this.resolveAudioNode(source);
    this.milkdrop.connectAudio(node);
    this.shadertoy.connectAudio(node);
    return node;
  }

  /** Pipe a live source (e.g. a slideshow's canvas) into iChannel1 — its
   *  contents are re-uploaded each frame. Pass null to disable. */
  setLiveSource(source: HTMLCanvasElement | HTMLVideoElement | null): void {
    this.shadertoy.setLiveSource(source);
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
    this.milkdrop.destroy();
    this.shadertoy.destroy();
    this.synth.stop();
    this.milkdropCanvas.remove();
    this.shadertoyCanvas.remove();
    if (this.ownsAudioCtx) {
      void this.audioCtx.close();
    }
  }

  private async resolveAudioNode(
    source: "mic" | "tab" | MediaStream | AudioNode,
  ): Promise<AudioNode> {
    if (source instanceof AudioNode) return source;
    let stream: MediaStream;
    if (source instanceof MediaStream) {
      stream = source;
    } else if (source === "mic") {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
    }
    return this.audioCtx.createMediaStreamSource(stream);
  }
}

function createCanvas(id: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.id = id;
  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  return canvas;
}
