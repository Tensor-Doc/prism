// mock-transport.ts — in-process simulated swarm.
// Mirrors the relay's shape: six vacant "agent" slots drifting around
// the canvas, each with its own bpm clock firing fake beats. Lets the
// landing page show a fully-populated, breathing room without any
// network in the loop — used both for offline dev and as a fallback
// when the WebSocket transport isn't configured.
//
// Unlike the relay, mock peers never get "taken over" — there's only
// one local user, and their cursor is rendered by CursorField rather
// than via the swarm overlay, so simulating occupancy here adds no
// value.

import type { SwarmPacket, SwarmRole, SwarmTransport } from "./transport";

const TICK_HZ = 30;
const AGENT_COUNT = 6;
const VACANT_HUES = [205, 215, 225, 195, 235, 200];

interface MockAgent {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  bpm: number;
  lastBeatAt: number;
  hue: number;
}

function makeAgent(i: number): MockAgent {
  return {
    id: `agent-${i + 1}`,
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.004,
    vy: (Math.random() - 0.5) * 0.004,
    phase: Math.random() * Math.PI * 2,
    bpm: 60 + Math.floor(Math.random() * 20),
    lastBeatAt: performance.now() - Math.random() * 1000,
    hue: VACANT_HUES[i % VACANT_HUES.length],
  };
}

export class MockSwarmTransport implements SwarmTransport {
  private timer: number | null = null;
  private readonly agents: MockAgent[] = [];
  private readonly subscribers = new Set<(p: SwarmPacket) => void>();
  private t = 0;

  constructor() {
    for (let i = 0; i < AGENT_COUNT; i++) this.agents.push(makeAgent(i));
  }

  start(_role: SwarmRole): void {
    if (this.timer != null) return;
    const intervalMs = 1000 / TICK_HZ;
    // Send an initial cursor for each agent so the overlay populates
    // immediately rather than waiting up to one tick.
    for (const a of this.agents) this.emitCursor(a);
    this.timer = window.setInterval(() => this.tick(intervalMs / 1000), intervalMs);
  }

  stop(): void {
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
    this.subscribers.clear();
  }

  send(_packet: SwarmPacket): void { /* no-op — fake peers don't react */ }

  onPacket(cb: (p: SwarmPacket) => void): () => void {
    this.subscribers.add(cb);
    return (): void => { this.subscribers.delete(cb); };
  }

  private tick(dt: number): void {
    this.t += dt;
    const now = performance.now();
    for (const a of this.agents) {
      // Drift + occasional flick — same shape as the relay's tick.
      const ax = Math.sin(this.t * 0.7 + a.phase) * 0.0002;
      const ay = Math.cos(this.t * 0.5 + a.phase * 1.3) * 0.0002;
      a.vx = (a.vx + ax) * 0.985;
      a.vy = (a.vy + ay) * 0.985;
      a.x += a.vx;
      a.y += a.vy;
      if (a.x < 0.02 || a.x > 0.98) { a.vx *= -1; a.x = Math.max(0.02, Math.min(0.98, a.x)); }
      if (a.y < 0.02 || a.y > 0.98) { a.vy *= -1; a.y = Math.max(0.02, Math.min(0.98, a.y)); }
      if (Math.random() < 0.005) {
        a.vx += (Math.random() - 0.5) * 0.02;
        a.vy += (Math.random() - 0.5) * 0.02;
      }
      this.emitCursor(a);

      const beatPeriod = 60_000 / a.bpm;
      if (now - a.lastBeatAt >= beatPeriod) {
        a.lastBeatAt = now;
        this.emit({ kind: "beat", id: a.id, t: now });
      }
    }
  }

  private emitCursor(a: MockAgent): void {
    this.emit({
      kind: "cursor",
      id: a.id,
      x01: a.x,
      y01: a.y,
      occupied: false,
      hue: a.hue,
      t: performance.now(),
    });
  }

  private emit(p: SwarmPacket): void {
    for (const sub of this.subscribers) sub(p);
  }
}
