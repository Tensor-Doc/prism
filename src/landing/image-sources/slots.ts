// slots.ts — runtime-side image sampler atlas. N independent canvases,
// each potentially bound to a different ImageSource. Skills request
// sample_image(slot, uv) and the runtime guarantees the canvas at that
// slot index has a fresh sample at the source's cadence.

import type { ImageSource } from "./types";

export class ImageSlots {
  private readonly canvases: HTMLCanvasElement[] = [];
  private readonly sources: (ImageSource | null)[] = [];

  constructor(count: number, slotW = 1280, slotH = 720) {
    for (let i = 0; i < count; i++) {
      const c = document.createElement("canvas");
      c.width = slotW;
      c.height = slotH;
      this.canvases.push(c);
      this.sources.push(null);
    }
  }

  bind(slot: number, source: ImageSource | null): void {
    if (slot < 0 || slot >= this.sources.length) return;
    this.sources[slot] = source;
  }

  source(slot: number): ImageSource | null {
    return this.sources[slot] ?? null;
  }

  canvas(slot: number): HTMLCanvasElement {
    return this.canvases[slot];
  }

  count(): number { return this.canvases.length; }

  /** Refresh a single slot from its bound source. */
  async refresh(slot: number): Promise<boolean> {
    const src = this.sources[slot];
    if (!src || !src.isReady()) return false;
    return src.sample(this.canvases[slot]);
  }
}
