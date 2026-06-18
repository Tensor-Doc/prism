// heart-fallback.ts — local stand-in for a real heart-rate feed.
// When the visitor hasn't connected a watch (Pulsoid etc.), we still
// want their slot in the swarm to pulse — otherwise the meta-HRV math
// ends up driven entirely by the agents. This module fires a steady
// fake beat at a per-session-random 60-80 BPM and broadcasts it onto
// the swarm via SwarmClient.
//
// Each session picks its rate + phase offset once on construction so
// the user gets a stable, believable rhythm — not a randomised stutter.

import type { SwarmClient } from "./client";

export class HeartFallback {
  private readonly client: SwarmClient;
  private readonly bpm: number;
  private readonly beatPeriodMs: number;
  private timer: number | null = null;
  private bpmTimer: number | null = null;
  private running = false;

  /** Fires every time a local beat is sent. Lets the host's UI mark
   *  their own cursor with a pulse — the swarm overlay only renders
   *  *other* peers, so without this hook the visitor never sees their
   *  own heart on screen. */
  public onLocalBeat: (() => void) | null = null;

  constructor(client: SwarmClient) {
    this.client = client;
    this.bpm = 60 + Math.floor(Math.random() * 21); // 60..80
    this.beatPeriodMs = 60_000 / this.bpm;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Random phase offset so the user's first beat doesn't land on the
    // same tick as all the agents — keeps the polyrhythm clean.
    const initialDelay = Math.random() * this.beatPeriodMs;
    this.timer = window.setTimeout(() => this.fire(), initialDelay);
    // Broadcast the BPM every 5 s so receivers can render the envelope
    // even between explicit beat events.
    this.bpmTimer = window.setInterval(() => {
      this.client.sendBpm(this.bpm);
    }, 5_000);
    // Initial BPM so it lands as soon as the slot is occupied.
    window.setTimeout(() => this.client.sendBpm(this.bpm), 200);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null; }
    if (this.bpmTimer != null) { clearInterval(this.bpmTimer); this.bpmTimer = null; }
  }

  private fire(): void {
    if (!this.running) return;
    this.client.sendBeat();
    if (this.onLocalBeat) this.onLocalBeat();
    this.timer = window.setTimeout(() => this.fire(), this.beatPeriodMs);
  }
}
