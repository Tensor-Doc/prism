// tab-video.ts — image source backed by a hidden <video> element receiving
// the shared tab's video track. The video element does its own decoding;
// we only call drawImage when a fresh sample is requested.

import type { ImageSource } from "./types";

export class TabVideoSource implements ImageSource {
  readonly id = "tab-video";
  readonly type = "tab-video" as const;

  private videoEl: HTMLVideoElement | null = null;

  attach(video: HTMLVideoElement): void {
    this.videoEl = video;
  }

  detach(): void {
    this.videoEl = null;
  }

  isReady(): boolean {
    return (
      !!this.videoEl &&
      this.videoEl.readyState >= 2 && // HAVE_CURRENT_DATA
      this.videoEl.videoWidth > 0 &&
      this.videoEl.videoHeight > 0
    );
  }

  async sample(target: HTMLCanvasElement | OffscreenCanvas): Promise<boolean> {
    if (!this.isReady() || !this.videoEl) return false;
    const ctx = target.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return false;

    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    const tw = target.width;
    const th = target.height;

    // Fit "cover" — fill the target, center-crop the video.
    const vs = vw / vh;
    const ts = tw / th;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (vs > ts) {
      sw = vh * ts;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / ts;
      sy = (vh - sh) / 2;
    }
    ctx.drawImage(this.videoEl, sx, sy, sw, sh, 0, 0, tw, th);
    return true;
  }

  defaultPeriodMs(): number { return 3000; }
}
