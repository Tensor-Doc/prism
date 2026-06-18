// overlay.ts — Canvas2D renderer for the swarm view.
//   • Vacant agent slots paint as cool, low-saturation stars (the
//     "ambient room").
//   • Human-occupied slots warm into their per-peer hue with full
//     saturation. The transition is a smooth hue lerp inside SwarmClient.
//   • Every peer's star pulses on its heartbeat — the envelope is a
//     short attack + exponential decay anchored on each beat packet.
//   • The center-of-mass crosshair *breathes* — its outer ring's
//     oscillation speed is driven by meta-HRV (pooled beat-train RMSSD).
//     Low meta-HRV (coherent beats) → slow majestic breath. High
//     (scattered) → quick jittery oscillation.
//
// Modeled after CursorField in ../cursor-field.ts — same DPR-aware loop,
// mix-blend-mode: screen via CSS, never blocks pointer events.

import type { SwarmClient } from "./client";

const CYAN_RGB = "61, 255, 229";

export class SwarmOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly client: SwarmClient;
  private readonly dpr = Math.min(2, window.devicePixelRatio || 1);
  private w = 0;
  private h = 0;
  private running = true;
  private rafHandle = 0;
  private active = false;
  /** Accumulated breathing phase for the CoM outer ring, in radians.
   *  Advances per-frame at a speed driven by meta-HRV. */
  private breathPhase = 0;
  private lastFrameAt = performance.now();

  constructor(canvas: HTMLCanvasElement, client: SwarmClient) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas2D unavailable for swarm overlay");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", this.resize, { passive: true });
    this.client = client;
    this.rafHandle = requestAnimationFrame(this.loop);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.ctx.clearRect(0, 0, this.w, this.h);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    window.removeEventListener("resize", this.resize);
  }

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  private loop = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    if (!this.active) return;

    // Advance per-peer hue lerps so the warm-up on takeover is smooth.
    this.client.step(dt);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const peers = this.client.getPeers();

    // ── per-peer trails ───────────────────────────────────────
    for (const peer of peers) {
      const trail = peer.trail;
      if (trail.length >= 2) {
        for (let i = 1; i < trail.length; i++) {
          const a = trail[i - 1];
          const b = trail[i];
          const tNorm = i / trail.length;
          const alphaScale = peer.occupied ? 1 : 0.45;
          const alpha = (0.05 + tNorm * 0.25) * alphaScale;
          const sat = peer.occupied ? 95 : 40;
          const light = peer.occupied ? 70 : 65;
          ctx.beginPath();
          ctx.moveTo(a.x01 * this.w, a.y01 * this.h);
          ctx.lineTo(b.x01 * this.w, b.y01 * this.h);
          ctx.strokeStyle = `hsla(${peer.renderedHue}, ${sat}%, ${light}%, ${alpha})`;
          ctx.lineWidth = 1.25;
          ctx.lineCap = "round";
          ctx.stroke();
        }
      }
    }

    // ── beat shockwaves (under the stars so the stars sit on top) ──
    for (const peer of peers) {
      const x = peer.x01 * this.w;
      const y = peer.y01 * this.h;
      drawShockwave(ctx, x, y, peer.renderedHue, peer.occupied, peer.lastBeatAt, now);
    }

    // ── stars on top ──────────────────────────────────────────
    for (const peer of peers) {
      const x = peer.x01 * this.w;
      const y = peer.y01 * this.h;
      const beatEnv = beatEnvelope(peer.lastBeatAt, peer.bpm, now);
      drawStar(ctx, x, y, peer.renderedHue, peer.occupied, beatEnv);
    }

    // ── center-of-mass crosshair ──────────────────────────────
    if (peers.length >= 2) {
      const com = this.client.centerOfMass();
      // Meta-HRV → breathing speed. RMSSD ~150ms (coherent) gives a
      // slow majestic breath; RMSSD ~800ms (scattered) gives ~3x faster.
      const hrv = this.client.metaHRV();
      let breathHz = 0.25; // default ~4s period when meta-HRV isn't ready
      if (hrv) {
        const norm = clamp01((hrv.rmssd - 100) / 700);
        breathHz = 0.2 + norm * 0.8; // 0.2..1.0 Hz, ie 5s..1s period
      }
      this.breathPhase += dt * breathHz * Math.PI * 2;
      const breath = 0.5 + 0.5 * Math.sin(this.breathPhase);
      drawCom(ctx, com.x01 * this.w, com.y01 * this.h, com.magnitude, breath, hrv != null);
    }
  };
}

/** Per-peer beat envelope: 0..1, peaks at `attack` after the beat then
 *  exponentially decays back to baseline. Zero if we never saw a beat. */
function beatEnvelope(lastBeatAt: number | null, bpm: number | null, now: number): number {
  if (lastBeatAt == null) return 0;
  const sinceMs = now - lastBeatAt;
  if (sinceMs < 0) return 0;
  // Sharp attack (60 ms), then decay over the rest of the beat period
  // (or 700 ms if we don't know the period yet — keeps it pulsing).
  const period = bpm ? 60_000 / bpm : 1000;
  const attack = 60;
  if (sinceMs < attack) return sinceMs / attack;
  const decayWindow = Math.max(200, period - attack);
  const k = Math.exp(-(sinceMs - attack) / (decayWindow * 0.35));
  return k;
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hue: number,
  occupied: boolean,
  beat: number,    // 0..1
): void {
  // Small size delta — occupied stars are clearly the same kind of
  // thing as vacant agents, just slightly larger + saturated, so the
  // room reads as one continuous swarm rather than two visual classes.
  const baseR = occupied ? 9 : 7;
  const pulseScale = occupied ? 0.85 : 0.6;
  const radiusBoost = 1 + beat * pulseScale;
  const alphaBoost = 0.65 + beat * 0.4;
  const sat = occupied ? 90 : 40;
  const haloLight = occupied ? 76 : 65;
  const coreLight = occupied ? 92 : 78;

  const r = baseR * radiusBoost;

  // Halo gradient — slightly brighter on occupied so the warm glow
  // signals "this is a human" without a hard-edged ring.
  const haloR = r * (occupied ? 2.9 : 2.5);
  const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
  halo.addColorStop(0, `hsla(${hue}, ${sat}%, ${haloLight}%, ${0.6 * alphaBoost})`);
  halo.addColorStop(0.5, `hsla(${hue}, ${sat}%, ${haloLight}%, ${0.18 * alphaBoost})`);
  halo.addColorStop(1, `hsla(${hue}, ${sat}%, ${haloLight}%, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, haloR, 0, Math.PI * 2);
  ctx.fill();

  // 4-point spike — only modestly longer for occupied.
  const spikeLen = (occupied ? 6.5 : 4.5) * radiusBoost;
  ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${coreLight}%, ${0.95 * alphaBoost})`;
  ctx.lineWidth = occupied ? 1.3 : 1.0;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - spikeLen, y); ctx.lineTo(x + spikeLen, y);
  ctx.moveTo(x, y - spikeLen); ctx.lineTo(x, y + spikeLen);
  ctx.stroke();

  // Bright core — small delta in size, big delta in saturation.
  ctx.fillStyle = `hsla(${hue}, ${sat}%, ${coreLight}%, 1)`;
  ctx.beginPath();
  ctx.arc(x, y, (occupied ? 2.4 : 1.6) * radiusBoost, 0, Math.PI * 2);
  ctx.fill();
}

/** Expanding ring fired on each beat — like a sonar ping. Lives ~500ms
 *  and fades. Makes individual heartbeats unmistakable even when the
 *  per-frame radius pulse is subtle. */
function drawShockwave(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hue: number,
  occupied: boolean,
  lastBeatAt: number | null,
  now: number,
): void {
  if (lastBeatAt == null) return;
  const since = now - lastBeatAt;
  const duration = occupied ? 550 : 420;
  if (since < 0 || since > duration) return;
  const t = since / duration;
  // Radius expands; alpha fades from 1 → 0 over the lifetime.
  const startR = occupied ? 12 : 6;
  const endR = occupied ? 56 : 28;
  const radius = startR + (endR - startR) * t;
  const peakAlpha = occupied ? 0.75 : 0.40;
  const alpha = peakAlpha * (1 - t) * (1 - t); // quadratic fade — punchy
  const sat = occupied ? 95 : 55;
  const light = occupied ? 78 : 68;
  ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
  ctx.lineWidth = occupied ? 2.0 : 1.4;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawCom(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  magnitude: number,    // collective motion 0..1
  breath: number,       // breathing phase 0..1 (from meta-HRV)
  hrvReady: boolean,    // false until we have enough beats
): void {
  // Outer pulse ring — radius grows with both collective motion AND
  // the meta-HRV breath. The breath is the dominant cue when nothing
  // is moving; motion takes over when the swarm activates.
  const baseR = 14;
  const motionR = baseR + magnitude * 22;
  const breathR = motionR + breath * 10;
  const ringAlpha = hrvReady ? 0.45 : 0.30;
  ctx.strokeStyle = `rgba(${CYAN_RGB}, ${ringAlpha})`;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.arc(x, y, breathR, 0, Math.PI * 2);
  ctx.stroke();

  // Inner ring — steady.
  ctx.strokeStyle = `rgba(${CYAN_RGB}, 0.70)`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, baseR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = `rgba(${CYAN_RGB}, 0.85)`;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(x - baseR - 4, y); ctx.lineTo(x - baseR + 3, y);
  ctx.moveTo(x + baseR - 3, y); ctx.lineTo(x + baseR + 4, y);
  ctx.moveTo(x, y - baseR - 4); ctx.lineTo(x, y - baseR + 3);
  ctx.moveTo(x, y + baseR - 3); ctx.lineTo(x, y + baseR + 4);
  ctx.stroke();

  ctx.fillStyle = `rgba(${CYAN_RGB}, 1)`;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
