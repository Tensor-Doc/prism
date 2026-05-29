export interface AudioFeatures {
  bass: number;
  mid: number;
  treble: number;
  rms: number;
  peak: number;
  beat: number;
  bin(i: number): number;
  band(lo: number, hi: number): number;
}

export class AudioFeatureExtractor {
  private readonly analyser: AnalyserNode;
  private readonly freqData: Uint8Array<ArrayBuffer>;
  private readonly timeData: Uint8Array<ArrayBuffer>;
  private readonly sampleRate: number;
  private smoothBass = 0;
  private smoothMid = 0;
  private smoothTreble = 0;
  private prevRms = 0;
  private beatCooldownMs = 0;
  private lastBeatAt = -1e9;
  private lastUpdateAt = performance.now();

  constructor(analyser: AnalyserNode) {
    this.analyser = analyser;
    this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    this.sampleRate = analyser.context.sampleRate;
  }

  update(): AudioFeatures {
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    const now = performance.now();
    const dt = now - this.lastUpdateAt;
    this.lastUpdateAt = now;

    const nyquist = this.sampleRate / 2;
    const hzPerBin = nyquist / this.freqData.length;
    const freq = this.freqData;
    const time = this.timeData;

    const band = (lo: number, hi: number): number => {
      const loBin = Math.max(0, Math.floor(lo / hzPerBin));
      const hiBin = Math.min(freq.length, Math.ceil(hi / hzPerBin));
      if (hiBin <= loBin) return 0;
      let sum = 0;
      for (let i = loBin; i < hiBin; i++) sum += freq[i];
      return sum / (hiBin - loBin) / 255;
    };

    // Bass should respond fast so drops land; treble/mid can be smoother.
    const smBass = 0.55;
    const smMid = 0.4;
    const smTreble = 0.35;
    this.smoothBass = this.smoothBass * (1 - smBass) + band(30, 160) * smBass;
    this.smoothMid = this.smoothMid * (1 - smMid) + band(200, 2000) * smMid;
    this.smoothTreble = this.smoothTreble * (1 - smTreble) + band(2000, 12000) * smTreble;

    let sumSquares = 0;
    let peakAbs = 0;
    for (let i = 0; i < time.length; i++) {
      const v = (time[i] - 128) / 128;
      sumSquares += v * v;
      const a = Math.abs(v);
      if (a > peakAbs) peakAbs = a;
    }
    const rms = Math.sqrt(sumSquares / time.length);

    let beatHit = 0;
    if (this.beatCooldownMs > 0) {
      this.beatCooldownMs = Math.max(0, this.beatCooldownMs - dt);
    } else if (rms > 0.06 && rms > this.prevRms * 1.22) {
      beatHit = 1;
      this.beatCooldownMs = 140;
      this.lastBeatAt = now;
    }
    this.prevRms = this.prevRms * 0.7 + rms * 0.3;

    const beatDecay = Math.max(0, 1 - (now - this.lastBeatAt) / 200);

    return {
      bass: this.smoothBass,
      mid: this.smoothMid,
      treble: this.smoothTreble,
      rms,
      peak: peakAbs,
      beat: beatHit > 0 ? 1 : beatDecay,
      bin(i: number): number {
        if (i < 0 || i >= freq.length) return 0;
        return freq[i] / 255;
      },
      band,
    };
  }
}
