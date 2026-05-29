// telemetry.ts — live FPS, simulated GPU load, session timer.
// All values keep moving — the cockpit is never static.

export interface TelemetryEls {
  fps: HTMLElement;
  gpu: HTMLElement;
  session: HTMLElement;
}

export interface TelemetryOptions {
  els: TelemetryEls;
  /** Called on every DOM tick with raw values — drive auxiliary readouts (chip, etc.). */
  onUpdate?: (values: { fps: number; gpu01: number; sessionSec: number }) => void;
}

export class Telemetry {
  private readonly els: TelemetryEls;
  private readonly onUpdate: TelemetryOptions["onUpdate"];
  private readonly t0 = performance.now();
  private lastFrame = performance.now();

  private fps = 60;
  private gpu = 0.12; // 0..1, simulated drift
  private lastDom = 0;

  constructor(opts: TelemetryOptions) {
    this.els = opts.els;
    this.onUpdate = opts.onUpdate;
    requestAnimationFrame(this.loop);
  }

  // external code can push real load (e.g. when generation runs)
  setGpuTarget(t01: number): void {
    this.gpuTarget = Math.max(0, Math.min(1, t01));
  }

  private gpuTarget = 0.12;

  private loop = (): void => {
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;

    if (dt > 0) {
      const instant = 1000 / dt;
      this.fps = this.fps * 0.9 + instant * 0.1;
    }

    const t = (now - this.t0) / 1000;
    // idle GPU drift around target
    const idle =
      this.gpuTarget +
      Math.sin(t * 0.31) * 0.04 +
      Math.sin(t * 0.83 + 1.1) * 0.018 +
      (Math.random() - 0.5) * 0.012;
    this.gpu += (idle - this.gpu) * 0.06;

    if (now - this.lastDom > 140) {
      const sessionSec = Math.floor((now - this.t0) / 1000);
      this.els.fps.textContent = this.fps.toFixed(1);
      this.els.gpu.textContent = `${Math.round(this.gpu * 100)} %`;
      this.els.session.textContent = this.formatTime(sessionSec);
      this.onUpdate?.({ fps: this.fps, gpu01: this.gpu, sessionSec });
      this.lastDom = now;
    }

    requestAnimationFrame(this.loop);
  };

  private formatTime(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
}
