// audio-bridge.ts — translates between the swarm's bars array and the
// AudioContext graph that @tensordoc/prism's analyser expects.
//
//   • BroadcastBridge — host side. Throttles outbound at ~30 Hz and
//     pushes a compact 16-band spectrum array onto the swarm. The
//     audience renders these bars directly and also derives
//     bass/mid/treb from them to drive the silent oscillator rig.
//
//   • SilentAudioSynth — audience side. Builds a 3-oscillator rig and
//     exposes the GainNode as the .output AudioNode handed to
//     player.connectAudio(...). Per-band gains ramp from the bars
//     summary so milkdrop reacts as if the host's audio were playing
//     locally. The rig is never connected to ctx.destination → silent
//     to the user.

import type { SwarmClient } from "./client";

const BROADCAST_HZ = 30;

export class BroadcastBridge {
  private readonly client: SwarmClient;
  private lastSentAt = 0;

  constructor(client: SwarmClient) {
    this.client = client;
  }

  /** Throttled push of the host's spectrum bars to the swarm. */
  push(audio: number[]): void {
    const now = performance.now();
    if (now - this.lastSentAt < 1000 / BROADCAST_HZ) return;
    this.lastSentAt = now;
    this.client.sendAudio(audio);
  }
}

interface SynthVoice {
  osc: OscillatorNode;
  gain: GainNode;
  baseGain: number;
}

/** Derive 3 bands (bass/mid/treb) from a multi-bar audio array. The
 *  split is approximate — bars are log-binned so the first ~4 are
 *  bass-ish, the next ~6 are mid, the rest are treble. */
export function bandsFromBars(audio: number[]): { bass: number; mid: number; treb: number } {
  if (audio.length === 0) return { bass: 0, mid: 0, treb: 0 };
  const n = audio.length;
  const bassEnd = Math.max(1, Math.floor(n * 0.25));
  const midEnd  = Math.max(bassEnd + 1, Math.floor(n * 0.65));
  let b = 0, m = 0, t = 0;
  let bc = 0, mc = 0, tc = 0;
  for (let i = 0; i < n; i++) {
    const v = audio[i];
    if (i < bassEnd) { b += v; bc++; }
    else if (i < midEnd) { m += v; mc++; }
    else { t += v; tc++; }
  }
  return {
    bass: bc > 0 ? b / bc : 0,
    mid:  mc > 0 ? m / mc : 0,
    treb: tc > 0 ? t / tc : 0,
  };
}

export class SilentAudioSynth {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly voices: Record<"bass" | "mid" | "treb", SynthVoice>;
  private stopped = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1.0;

    this.voices = {
      bass: makeVoice(ctx, this.master, 80, "sine", 0.5),
      mid: makeVoice(ctx, this.master, 600, "sine", 0.35),
      treb: makeVoice(ctx, this.master, 4000, "sawtooth", 0.2),
    };
  }

  get output(): AudioNode { return this.master; }

  apply(bands: { bass: number; mid: number; treb: number }): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const ramp = 0.033;
    rampVoice(this.voices.bass, bands.bass, now, ramp);
    rampVoice(this.voices.mid, bands.mid, now, ramp);
    rampVoice(this.voices.treb, bands.treb, now, ramp);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const v of Object.values(this.voices)) {
      try { v.osc.stop(); } catch { /* ignore */ }
      try { v.osc.disconnect(); v.gain.disconnect(); } catch { /* ignore */ }
    }
    try { this.master.disconnect(); } catch { /* ignore */ }
  }
}

function makeVoice(
  ctx: AudioContext,
  master: GainNode,
  freq: number,
  type: OscillatorType,
  baseGain: number,
): SynthVoice {
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  osc.type = type;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(master);
  osc.start();
  return { osc, gain, baseGain };
}

function rampVoice(v: SynthVoice, band01: number, now: number, ramp: number): void {
  const target = Math.max(0, Math.min(1, band01)) * v.baseGain;
  v.gain.gain.cancelScheduledValues(now);
  v.gain.gain.setValueAtTime(v.gain.gain.value, now);
  v.gain.gain.linearRampToValueAtTime(target, now + ramp);
}
