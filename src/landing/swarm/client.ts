// client.ts — collects swarm packets into a renderable state.
// Tracks each slot's cursor + heart + occupancy. Owned by the landing
// page; two consumers read from it:
//
//   1. SwarmOverlay — paints the ghost cursors + center-of-mass marker,
//      using `occupied` to pick agent vs. human hue/saturation.
//   2. The render-loop hook in main.ts — pulls centerOfMass() each frame
//      and pushes it into the player's cursor + milkdrop cx/cy.
//
// Also computes meta-HRV (pooled-beat-train variability) on demand for
// the crosshair's breathing animation. See `metaHRV()`.

import type { SwarmPacket, SwarmRole, SwarmTransport } from "./transport";

const PEER_TTL_MS = 4_000;       // an agent slot ticks every 33 ms, so 4 s is "really gone"
const TRAIL_LEN = 12;
const BEAT_HISTORY_MS = 30_000;
const BEAT_HISTORY_MAX = 600;    // hard cap to bound memory

export interface PeerTrailPoint { x01: number; y01: number; t: number }

export interface PeerState {
  id: string;
  x01: number;
  y01: number;
  lastSeen: number;
  trail: PeerTrailPoint[];
  /** Server-provided hue (0..360). Vacant agents use a cool grey hue;
   *  human-occupied slots use a per-peer hash hue. */
  hue: number;
  /** Smoothly-lerped hue actually used for rendering. */
  renderedHue: number;
  occupied: boolean;
  /** Last known heart rate; null until a bpm packet arrives. */
  bpm: number | null;
  /** Most recent beat timestamp (performance.now-relative). */
  lastBeatAt: number | null;
}

export interface CenterOfMass {
  x01: number;
  y01: number;
  magnitude: number;
  direction: number;
  peerCount: number;
}

export interface BandReading { bass: number; mid: number; treb: number }

const EMPTY_AUDIO: number[] = [];

export interface MetaHRV {
  /** Root-mean-square of successive differences across the pooled
   *  beat train, in milliseconds. Low = coherent group; high = scattered. */
  rmssd: number;
  /** Beat count in the window. Below ~6 the value is unreliable. */
  samples: number;
}

export class SwarmClient {
  private readonly transport: SwarmTransport;
  private readonly peers = new Map<string, PeerState>();
  /** Pooled beat timestamps from all peers in the recent past, used
   *  for meta-HRV. Ordered oldest-first; trimmed each gc. */
  private readonly beatTrain: number[] = [];
  private currentAudioBars: number[] = EMPTY_AUDIO;
  private unsub: (() => void) | null = null;
  private gcTimer: number | null = null;
  private running = false;
  private role: SwarmRole = "audience";
  /** Running estimate of (server Date.now() − local Date.now()), in ms.
   *  Lets us convert host-broadcast wall-clock times into local times
   *  even with small clock skew between browsers. */
  private serverOffsetMs = 0;
  private offsetSamples = 0;

  public onAudio: ((audio: number[]) => void) | null = null;
  /** Host has scheduled a preset swap at server wall-clock `at`. */
  public onSchedule: ((s: { at: number; graph: unknown; presetName?: string }) => void) | null = null;
  /** This client's role has changed (or been set for the first time). */
  public onRoleChange: ((role: SwarmRole) => void) | null = null;

  /** Current role as the server sees it. */
  get currentRole(): SwarmRole { return this.role; }

  constructor(transport: SwarmTransport) {
    this.transport = transport;
  }

  start(role: SwarmRole): void {
    if (this.running) return;
    this.running = true;
    this.role = role;
    this.transport.start(role);
    this.unsub = this.transport.onPacket((p) => this.onPacket(p));
    this.gcTimer = window.setInterval(() => this.gc(), 500);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.transport.stop();
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.gcTimer != null) { clearInterval(this.gcTimer); this.gcTimer = null; }
    this.peers.clear();
    this.beatTrain.length = 0;
    this.currentAudioBars = EMPTY_AUDIO;
    this.serverOffsetMs = 0;
    this.offsetSamples = 0;
    this.role = "audience";
  }

  /** Convert a server wall-clock timestamp into the local Date.now()
   *  frame so we can `setTimeout` for the right local moment. */
  localTimeFor(serverWallMs: number): number {
    return serverWallMs - this.serverOffsetMs;
  }

  /** Our best estimate of the server's current wall-clock time. */
  serverNow(): number {
    return Date.now() + this.serverOffsetMs;
  }

  /** Host-only: broadcast a scheduled preset swap. */
  sendSchedule(graph: unknown, atServerMs: number, presetName?: string): void {
    if (!this.running || this.role !== "host") return;
    this.transport.send({
      kind: "schedule", id: "self", at: atServerMs, graph, presetName, t: performance.now(),
    });
  }

  getPeers(): PeerState[] { return Array.from(this.peers.values()); }
  /** Latest spectrum bars from the host (or empty until first packet). */
  getAudioBars(): number[] { return this.currentAudioBars; }

  sendCursor(x01: number, y01: number): void {
    if (!this.running) return;
    // Server stamps `id`, `occupied`, `hue` — we send placeholders the
    // type system requires. Any peer that ever reads our local outbound
    // (mock transport) gets occupied: true since this is human input.
    // Server stamps `id`, `occupied`, `hue` on every cursor — these are
    // placeholders the typesystem requires. (Mock transport echoes them
    // through unchanged, which is fine since the user's own broadcast
    // isn't shown via the swarm overlay anyway — CursorField handles it.)
    this.transport.send({
      kind: "cursor", id: "self", x01, y01, t: performance.now(),
      occupied: true, hue: 180,
    });
  }

  sendAudio(audio: number[]): void {
    if (!this.running || this.role !== "host") return;
    this.transport.send({
      kind: "audio", id: "self", audio, t: performance.now(),
    });
    // Mirror the broadcast locally so the host sees the same data the
    // audience sees — keeps host's spectrum/VU/silent-synth in lockstep
    // with the rest of the room instead of running off the local
    // synth at a different rate.
    this.currentAudioBars = audio;
    if (this.onAudio) this.onAudio(audio);
  }

  /** Broadcast a heartbeat event (now). Used by the HR fallback or by
   *  a real Pulsoid-driven driver. */
  sendBeat(): void {
    if (!this.running) return;
    this.transport.send({ kind: "beat", id: "self", t: performance.now() });
  }

  /** Occasional rate update so receivers can render the pulse envelope
   *  between beats and the meta-HRV can compute. */
  sendBpm(bpm: number): void {
    if (!this.running) return;
    this.transport.send({ kind: "bpm", id: "self", bpm, t: performance.now() });
  }

  centerOfMass(): CenterOfMass {
    const peers = this.getPeers();
    if (peers.length === 0) {
      return { x01: 0.5, y01: 0.5, magnitude: 0, direction: 0, peerCount: 0 };
    }
    let sx = 0, sy = 0, svx = 0, svy = 0;
    for (const p of peers) {
      sx += p.x01;
      sy += p.y01;
      if (p.trail.length >= 2) {
        const a = p.trail[p.trail.length - 2];
        const b = p.trail[p.trail.length - 1];
        const dt = Math.max(0.001, (b.t - a.t) / 1000);
        svx += (b.x01 - a.x01) / dt;
        svy += (b.y01 - a.y01) / dt;
      }
    }
    const n = peers.length;
    const avgVx = svx / n;
    const avgVy = svy / n;
    const speed = Math.hypot(avgVx, avgVy);
    return {
      x01: sx / n,
      y01: sy / n,
      magnitude: Math.min(1, speed / 1.5),
      direction: speed > 0.01 ? Math.atan2(avgVy, avgVx) : 0,
      peerCount: n,
    };
  }

  /** Meta-HRV: pooled-beat-train RMSSD over the recent window. Returns
   *  null until enough beats have landed to make the value meaningful. */
  metaHRV(): MetaHRV | null {
    const beats = this.beatTrain;
    if (beats.length < 6) return null;
    let sumSq = 0;
    let diffs = 0;
    for (let i = 1; i < beats.length; i++) {
      const d = beats[i] - beats[i - 1];
      // Cap at 5s — a long pause between beats (peer just connected)
      // would otherwise blow out the variance unrealistically.
      if (d > 5_000) continue;
      sumSq += d * d;
      diffs++;
    }
    if (diffs < 4) return null;
    const rmssd = Math.sqrt(sumSq / diffs);
    return { rmssd, samples: beats.length };
  }

  /** Stable hue lerp toward each peer's target hue. Call once per
   *  render frame. Cheap. */
  step(dt: number): void {
    // 200 ms hue lerp — same feel as the mode-change band lerp.
    const k = Math.min(1, dt / 0.2);
    for (const peer of this.peers.values()) {
      peer.renderedHue = lerpAngle(peer.renderedHue, peer.hue, k);
    }
  }

  private onPacket(p: SwarmPacket): void {
    // Maintain server clock offset from every WS packet's wall-clock t.
    // The relay stamps Date.now() on cursor/beat/etc.; the mock uses
    // performance.now() which is much smaller, so we only sample
    // "real" wall-clock values (t > 1e10 is safely past 1970).
    if ("t" in p && typeof p.t === "number" && p.t > 1e10) {
      const sample = p.t - Date.now();
      // Smooth fast at first (so the first few packets pull us into the
      // ballpark), then EMA more slowly.
      const alpha = this.offsetSamples < 5 ? 0.5 : 0.05;
      this.serverOffsetMs = this.serverOffsetMs * (1 - alpha) + sample * alpha;
      this.offsetSamples++;
    }

    if (p.kind === "cursor") {
      let peer = this.peers.get(p.id);
      if (!peer) {
        peer = {
          id: p.id,
          x01: p.x01, y01: p.y01,
          lastSeen: p.t,
          trail: [],
          hue: p.hue,
          renderedHue: p.hue,
          occupied: p.occupied,
          bpm: null,
          lastBeatAt: null,
        };
        this.peers.set(p.id, peer);
      }
      peer.x01 = p.x01;
      peer.y01 = p.y01;
      peer.lastSeen = p.t;
      peer.hue = p.hue;
      peer.occupied = p.occupied;
      peer.trail.push({ x01: p.x01, y01: p.y01, t: p.t });
      if (peer.trail.length > TRAIL_LEN) peer.trail.shift();
    } else if (p.kind === "audio") {
      this.currentAudioBars = p.audio;
      if (this.onAudio) this.onAudio(p.audio);
    } else if (p.kind === "beat") {
      // Store the *local* arrival time, not the server-clock timestamp:
      // the overlay loop compares against performance.now() and would
      // see giant negative deltas if we stored p.t from Date.now().
      const localT = performance.now();
      const peer = this.peers.get(p.id);
      if (peer) peer.lastBeatAt = localT;
      this.beatTrain.push(localT);
      if (this.beatTrain.length > BEAT_HISTORY_MAX) this.beatTrain.shift();
    } else if (p.kind === "bpm") {
      const peer = this.peers.get(p.id);
      if (peer) peer.bpm = p.bpm;
    } else if (p.kind === "bye") {
      this.peers.delete(p.id);
    } else if (p.kind === "schedule") {
      if (this.onSchedule) {
        this.onSchedule({ at: p.at, graph: p.graph, presetName: p.presetName });
      }
    } else if (p.kind === "role") {
      this.role = p.role;
      if (this.onRoleChange) this.onRoleChange(p.role);
    }
  }

  private gc(): void {
    const nowPerf = performance.now();
    // Peer TTL — drop ghosts whose lastSeen timestamps are stale. lastSeen
    // is server-clock for WS packets, performance.now() for mock — both
    // tick in real time so a wallclock comparison works for both.
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      // Server-stamped cursor packets carry Date.now() in `t`.
      // Mock packets use performance.now() — Date.now is always > perf.
      // Just check the gap is >TTL in either system's frame.
      const gap = peer.lastSeen > 1e10 ? now - peer.lastSeen : nowPerf - peer.lastSeen;
      if (gap > PEER_TTL_MS) this.peers.delete(id);
    }
    // Trim the beat train to the last BEAT_HISTORY_MS.
    const beats = this.beatTrain;
    while (beats.length > 0 && beats[beats.length - 1] - beats[0] > BEAT_HISTORY_MS) {
      beats.shift();
    }
  }
}

/** Shortest-arc interpolation around the 0..360 hue circle. */
function lerpAngle(a: number, b: number, k: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return (a + d * k + 360) % 360;
}
