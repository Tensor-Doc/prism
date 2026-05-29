// cursor-field.ts — cyan cursor compositor overlay.
// Renders on top of the milkdrop background via mix-blend-mode: screen.
// Contributes the brand reactivity: a glowing halo, a decaying trail,
// expanding shockwave rings on click, and small velocity-burst rings.
// No lattice — milkdrop is the motion underneath; we just paint on top.

type TrailPoint = { x: number; y: number; t: number; v: number; dx: number; dy: number };
type Ring = { x: number; y: number; t: number; intensity: number; rgb: string };

const CYAN_RGB = "61, 255, 229";

export class CursorField {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private w = 0;
  private h = 0;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);

  // cursor state
  private cursor = { x: -9999, y: -9999, speed: 0 };
  private cursorTarget = { x: -9999, y: -9999 };
  private cursorVel = { dx: 0, dy: 0 }; // unit-ish velocity direction
  private lastCursor = { x: -9999, y: -9999, t: 0 };
  private trail: TrailPoint[] = [];
  private rings: Ring[] = [];

  // external signal: audio energy 0..1
  private audioBoost = 0;
  private audioBoostTarget = 0;

  private running = true;
  private readonly t0 = performance.now();
  private velocityForRingThreshold = 0;

  public onCursorVelocity?: (speedPxPerSec: number) => void;

  /** Current cursor screen-position; returns negative for off-screen. */
  get cursorPosition(): { x: number; y: number } {
    return { x: this.cursor.x, y: this.cursor.y };
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas2D unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", this.resize, { passive: true });
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerleave", this.onPointerLeave);
    // Click/dblclick are handled centrally by InputPulses + orchestrated from
    // main.ts so multiple visualizers can react to a single pulse.
    requestAnimationFrame(this.loop);
  }

  setAudioEnergy(e: number): void {
    this.audioBoostTarget = Math.max(0, Math.min(1.2, e));
  }

  /** Public: emit a shockwave at arbitrary coords, optionally tinted. */
  emitRing(x: number, y: number, intensity = 1, rgb = CYAN_RGB): void {
    this.rings.push({ x, y, t: performance.now(), intensity, rgb });
  }

  /** Public: emit a ring at the cursor's current screen position. */
  emitRingAtCursor(intensity = 0.7, rgb = CYAN_RGB): void {
    if (this.cursor.x <= -1000) return;
    this.rings.push({ x: this.cursor.x, y: this.cursor.y, t: performance.now(), intensity, rgb });
  }

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.cursorTarget.x = e.clientX;
    this.cursorTarget.y = e.clientY;
    const now = performance.now();
    if (this.lastCursor.t === 0) {
      this.lastCursor = { x: e.clientX, y: e.clientY, t: now };
      this.cursor.x = e.clientX;
      this.cursor.y = e.clientY;
      return;
    }
    const dt = Math.max(8, now - this.lastCursor.t);
    const dx = e.clientX - this.lastCursor.x;
    const dy = e.clientY - this.lastCursor.y;
    const dist = Math.hypot(dx, dy);
    const pxPerSec = (dist / dt) * 1000;
    this.cursor.speed = this.cursor.speed * 0.6 + pxPerSec * 0.4;
    // Smoothed velocity direction — used to elongate the halo and orient trail dabs.
    if (dist > 0.5) {
      const nx = dx / dist;
      const ny = dy / dist;
      this.cursorVel.dx = this.cursorVel.dx * 0.7 + nx * 0.3;
      this.cursorVel.dy = this.cursorVel.dy * 0.7 + ny * 0.3;
    }
    this.lastCursor = { x: e.clientX, y: e.clientY, t: now };
    this.trail.push({
      x: e.clientX, y: e.clientY, t: now, v: this.cursor.speed,
      dx: this.cursorVel.dx, dy: this.cursorVel.dy,
    });
    if (this.trail.length > 96) this.trail.shift();
    if (this.onCursorVelocity) this.onCursorVelocity(this.cursor.speed);

    // Velocity-burst ring: when the cursor accelerates sharply, drop a small
    // shockwave. The threshold is dynamic so steady-fast motion doesn't spam.
    if (this.cursor.speed > 900 && this.cursor.speed - this.velocityForRingThreshold > 250) {
      this.rings.push({ x: e.clientX, y: e.clientY, t: now, intensity: 0.35, rgb: CYAN_RGB });
      this.velocityForRingThreshold = this.cursor.speed;
    } else {
      this.velocityForRingThreshold *= 0.95;
    }
  };

  private onPointerLeave = (): void => {
    this.cursorTarget.x = -9999;
    this.cursorTarget.y = -9999;
  };

  private loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    const t = (now - this.t0) / 1000;

    const onScreen = this.cursorTarget.x > -1000;
    if (onScreen) {
      this.cursor.x += (this.cursorTarget.x - this.cursor.x) * 0.22;
      this.cursor.y += (this.cursorTarget.y - this.cursor.y) * 0.22;
    } else {
      this.cursor.x += (-9999 - this.cursor.x) * 0.04;
      this.cursor.y += (-9999 - this.cursor.y) * 0.04;
    }
    this.cursor.speed *= 0.9;
    // Velocity-direction also decays back toward zero when motion stops.
    this.cursorVel.dx *= 0.92;
    this.cursorVel.dy *= 0.92;

    this.audioBoost += (this.audioBoostTarget - this.audioBoost) * 0.18;

    while (this.trail.length > 0 && now - this.trail[0].t > 600) this.trail.shift();

    this.render(t);
    requestAnimationFrame(this.loop);
  };

  private render(_t: number): void {
    const ctx = this.ctx;
    const { w, h } = this;
    const now = performance.now();

    // Clear with full-frame transparency wipe — no trail accumulation on canvas
    // (the visual trail is built from the trail[] sample buffer instead).
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    // ── shockwave rings ──
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const age = (now - r.t) / 900; // 900ms ring lifetime
      if (age >= 1) {
        this.rings.splice(i, 1);
        continue;
      }
      const radius = 14 + age * 180 * r.intensity;
      const a = (1 - age) * 0.45 * r.intensity;
      // outer ring
      ctx.strokeStyle = `rgba(${r.rgb}, ${a.toFixed(3)})`;
      ctx.lineWidth = 1.5 * (1 - age * 0.4);
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      // soft inner glow on the ring
      const ringGlow = ctx.createRadialGradient(r.x, r.y, radius * 0.85, r.x, r.y, radius * 1.25);
      ringGlow.addColorStop(0, `rgba(${r.rgb}, 0)`);
      ringGlow.addColorStop(0.5, `rgba(${r.rgb}, ${(a * 0.5).toFixed(3)})`);
      ringGlow.addColorStop(1, `rgba(${r.rgb}, 0)`);
      ctx.fillStyle = ringGlow;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius * 1.25, 0, Math.PI * 2);
      ctx.fill();
    }

    const cursorActive = this.cursor.x > -1000;
    if (!cursorActive) {
      ctx.globalCompositeOperation = "source-over";
      return;
    }

    const cx = this.cursor.x;
    const cy = this.cursor.y;

    // ── trail (velocity-stretched soft dabs along recent cursor path) ──
    for (let i = 0; i < this.trail.length; i += 2) {
      const p = this.trail[i];
      const age = (now - p.t) / 600;
      if (age >= 1) continue;
      const k = 1 - age;
      const baseSize = (3 + k * 4 + Math.min(50, p.v * 0.035)) * 3.6;
      const stretch = 1 + Math.min(2.4, p.v * 0.0018); // 1×–3.4× along velocity
      const a = k * 0.42;
      const angle = Math.atan2(p.dy, p.dx);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      // radial gradient is rotation-symmetric; the stretch comes from scaling.
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, baseSize);
      g.addColorStop(0, `rgba(61, 255, 229, ${a.toFixed(3)})`);
      g.addColorStop(1, "rgba(61, 255, 229, 0)");
      ctx.fillStyle = g;
      ctx.scale(stretch, 1 / Math.sqrt(stretch));
      ctx.beginPath();
      ctx.arc(0, 0, baseSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ── cursor halo (elongated in direction of motion) ──
    const audioGlow = this.audioBoost;
    const haloR = 44 + Math.min(140, this.cursor.speed * 0.06) + audioGlow * 40;
    const haloStretch = 1 + Math.min(1.4, this.cursor.speed * 0.0014);
    const angle = Math.atan2(this.cursorVel.dy, this.cursorVel.dx);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    halo.addColorStop(0, "rgba(61, 255, 229, 0.55)");
    halo.addColorStop(0.25, "rgba(61, 255, 229, 0.18)");
    halo.addColorStop(1, "rgba(61, 255, 229, 0)");
    ctx.fillStyle = halo;
    ctx.scale(haloStretch, 1 / Math.sqrt(haloStretch));
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.globalCompositeOperation = "source-over";
  }

  destroy(): void {
    this.running = false;
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerleave", this.onPointerLeave);
  }
}
