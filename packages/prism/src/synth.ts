// synthetic-signal.ts — silent "fractal" audio driver.
// Generates a pink-noise-like spectrum (octave-spaced oscillators, amplitude
// ∝ 1/√f) plus periodic beat envelopes and slow frequency mutations. The
// signal is read by butterchurn's analyser to keep the Milkdrop preset
// animated while no real audio is shared. Output never reaches ctx.destination,
// so nothing is audible.

type Band = "bass" | "mid" | "treble";
type Voice = {
  base: number;
  baseGain: number;
  band: Band;
  osc: OscillatorNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  gain: GainNode;
};

export class SyntheticSignal {
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly voices: Voice[] = [];
  private readonly analyser: AnalyserNode;
  private readonly fft: Uint8Array;
  private beatTimer: number | null = null;
  private mutationTimer: number | null = null;
  private stopped = false;
  private lastCursorBeatAt = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.65;

    // Octave-spaced voices producing a 1/√f spectrum — convincingly "musical"
    // to the analyser without being recognisable as anything in particular.
    //   freqHz, type, baseGain, lfoHz, lfoDepth
    const seeds: Array<[number, OscillatorType, number, number, number]> = [
      [ 50,   "sine",      0.55, 0.06,  18 ],
      [ 110,  "sine",      0.40, 0.09,  24 ],
      [ 230,  "triangle",  0.28, 0.12,  60 ],
      [ 460,  "sawtooth",  0.18, 0.17, 140 ],
      [ 950,  "triangle",  0.12, 0.21, 280 ],
      [ 1900, "sine",      0.08, 0.27, 520 ],
      [ 3900, "triangle",  0.05, 0.33, 1100 ],
    ];
    for (const [f, type, g, lfoHz, lfoD] of seeds) this.addVoice(f, type, g, lfoHz, lfoD);

    // Internal analyser so callers can read our energy without colliding with
    // butterchurn's own analyser.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.78;
    this.output.connect(this.analyser);
    this.fft = new Uint8Array(this.analyser.frequencyBinCount);

    this.scheduleBeats();
    this.scheduleMutations();
  }

  /** The node to feed into a consumer (e.g. butterchurn.connectAudio). */
  getOutput(): AudioNode {
    return this.output;
  }

  /** Returns a smoothed 0..1 energy reading from our own analyser. */
  readEnergy(): number {
    if (this.stopped) return 0;
    this.analyser.getByteFrequencyData(this.fft as unknown as Uint8Array<ArrayBuffer>);
    let s = 0;
    for (let i = 0; i < this.fft.length; i++) s += this.fft[i];
    return s / 255 / this.fft.length;
  }

  /** Log-binned spectrum bars (0..1 each) for display widgets. The
   *  default 16 is compact enough to broadcast over a thin channel
   *  (e.g., a multi-user relay) while preserving enough resolution
   *  to read as a real spectrum. */
  readBars(count = 16): number[] {
    if (this.stopped) return new Array<number>(count).fill(0);
    this.analyser.getByteFrequencyData(this.fft as unknown as Uint8Array<ArrayBuffer>);
    const n = this.fft.length;
    const minBin = 2; // skip DC + sub-bass artifacts
    const out: number[] = new Array<number>(count).fill(0);
    for (let b = 0; b < count; b++) {
      const t0 = b / count;
      const t1 = (b + 1) / count;
      const lo = Math.max(minBin, Math.floor(minBin + (n - minBin) * (t0 * t0)));
      const hi = Math.max(lo + 1, Math.floor(minBin + (n - minBin) * (t1 * t1)));
      let s = 0;
      let cnt = 0;
      for (let i = lo; i < hi && i < n; i++) { s += this.fft[i]; cnt++; }
      out[b] = cnt > 0 ? (s / cnt) / 255 : 0;
    }
    return out;
  }

  /** Returns smoothed bass/mid/treble bands (0..1 each). */
  readBands(): { bass: number; mid: number; treble: number } {
    if (this.stopped) return { bass: 0, mid: 0, treble: 0 };
    this.analyser.getByteFrequencyData(this.fft as unknown as Uint8Array<ArrayBuffer>);
    const n = this.fft.length;
    const bassEnd = Math.floor(n * 0.10);
    const midEnd = Math.floor(n * 0.45);
    let b = 0, m = 0, t = 0;
    for (let i = 0; i < n; i++) {
      const v = this.fft[i] / 255;
      if (i < bassEnd) b += v;
      else if (i < midEnd) m += v;
      else t += v;
    }
    return {
      bass: b / Math.max(1, bassEnd),
      mid: m / Math.max(1, midEnd - bassEnd),
      treble: t / Math.max(1, n - midEnd),
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.beatTimer != null) clearTimeout(this.beatTimer);
    if (this.mutationTimer != null) clearTimeout(this.mutationTimer);
    for (const v of this.voices) {
      try { v.osc.stop(); v.lfo.stop(); } catch { /* ignore */ }
      try { v.osc.disconnect(); v.lfo.disconnect(); v.lfoGain.disconnect(); v.gain.disconnect(); }
      catch { /* ignore */ }
    }
    try { this.output.disconnect(); } catch { /* ignore */ }
    try { this.analyser.disconnect(); } catch { /* ignore */ }
  }

  private addVoice(
    freq: number,
    type: OscillatorType,
    gain: number,
    lfoHz: number,
    lfoDepth: number,
  ): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    osc.type = type;
    const g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g).connect(this.output);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoHz;
    lfo.type = "sine";
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = lfoDepth;
    lfo.connect(lfoGain).connect(osc.frequency);

    lfo.start();
    osc.start();
    const band: Band = freq < 200 ? "bass" : freq < 1100 ? "mid" : "treble";
    this.voices.push({ base: freq, baseGain: gain, band, osc, lfo, lfoGain, gain: g });
  }

  /**
   * Modulate the synth from the cursor. Position controls the bass/treble
   * balance (top-right = bright/airy; bottom-left = bassy/warm); velocity
   * triggers a beat envelope on the master gain. The cursor becomes the
   * instrument driving the milkdrop preset.
   *
   *   @param x01      cursor X normalised to 0..1 (left .. right)
   *   @param y01      cursor Y normalised to 0..1 (top .. bottom)
   *   @param vel01    cursor speed normalised to 0..1
   */
  setCursorModulation(x01: number, y01: number, vel01: number): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const ramp = 0.12;
    const x = Math.max(0, Math.min(1, x01));
    const y = Math.max(0, Math.min(1, y01));
    const v = Math.max(0, Math.min(1, vel01));

    // bass: bottom of screen = louder
    const bassMul = 0.55 + (1 - y) * 0.90 + v * 0.15;
    // treble: right of screen = brighter
    const trebleMul = 0.55 + x * 0.90 + v * 0.20;
    // mid: rises with velocity (gives "presence" to motion)
    const midMul = 0.7 + v * 0.7;

    for (const voice of this.voices) {
      const target =
        voice.band === "bass" ? voice.baseGain * bassMul :
        voice.band === "treble" ? voice.baseGain * trebleMul :
        voice.baseGain * midMul;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(target, now + ramp);
    }

    // Velocity-burst → master gain envelope (rate-limited so a steady fast
    // glide doesn't constantly hammer the analyser).
    if (v > 0.45 && now - this.lastCursorBeatAt > 0.22) {
      const peak = 0.95 + v * 0.45;
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(peak, now + 0.035);
      this.output.gain.exponentialRampToValueAtTime(0.52, now + 0.22);
      this.lastCursorBeatAt = now;
    }
  }

  /**
   * Fire a bass-kick envelope — for hooking up heartbeats, MIDI clicks, or
   * any external rhythmic trigger. Sharp attack + bass voice swell so the
   * spectrum butterchurn sees registers as a clean bass beat.
   *
   *   @param intensity  0..1, scales the peak
   */
  pulseBeat(intensity = 0.8): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const i = Math.max(0, Math.min(1, intensity));

    // Master gain — sharp attack, exponential decay (kick-drum shape)
    const masterPeak = 0.95 + i * 0.55;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(masterPeak, now + 0.035);
    this.output.gain.exponentialRampToValueAtTime(0.42, now + 0.26);

    // Bass voices get an extra swell so the kick lands in the low band
    // (which is where butterchurn's preset reactivity usually lives).
    for (const voice of this.voices) {
      if (voice.band !== "bass") continue;
      const peak = voice.baseGain * (1.6 + i * 1.4);
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(peak, now + 0.025);
      voice.gain.gain.exponentialRampToValueAtTime(
        Math.max(0.01, voice.baseGain), now + 0.34,
      );
    }
  }

  /** Periodic "beat" — short amplitude burst on the master gain. */
  private scheduleBeats(): void {
    const tick = (): void => {
      if (this.stopped) return;
      const now = this.ctx.currentTime;
      const peak = 0.95 + Math.random() * 0.35;
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(peak, now + 0.04);
      this.output.gain.exponentialRampToValueAtTime(0.45, now + 0.28);
      // BPM-ish range 60–110, jittered
      const nextMs = 600 + Math.random() * 1000;
      this.beatTimer = window.setTimeout(tick, nextMs);
    };
    this.beatTimer = window.setTimeout(tick, 900);
  }

  /** Every ~20–35 s, smoothly mutate one voice's base frequency over 8 s. */
  private scheduleMutations(): void {
    const tick = (): void => {
      if (this.stopped) return;
      const v = this.voices[Math.floor(Math.random() * this.voices.length)];
      const now = this.ctx.currentTime;
      const ratio = 0.65 + Math.random() * 0.7; // 0.65× .. 1.35×
      const target = Math.max(20, Math.min(6000, v.base * ratio));
      v.osc.frequency.cancelScheduledValues(now);
      v.osc.frequency.setValueAtTime(v.osc.frequency.value, now);
      v.osc.frequency.linearRampToValueAtTime(target, now + 7.5);
      v.base = target;
      this.mutationTimer = window.setTimeout(tick, 18000 + Math.random() * 16000);
    };
    this.mutationTimer = window.setTimeout(tick, 6000);
  }
}
