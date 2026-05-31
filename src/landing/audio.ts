// audio.ts — audio capture via getDisplayMedia (tab) or getUserMedia
// (mic) + FFT analysis. Emits smoothed energy + 3-band split. Same
// instance handles both modes; they're mutually exclusive (one source
// at a time). Tab-share also wires the video track to a hidden
// element so the slideshow can sample frames from it.

export interface AudioFeatures {
  energy: number; // 0..1, smoothed
  bass: number;   // 0..1
  mid: number;    // 0..1
  treble: number; // 0..1
  bars: number[]; // 24 log-binned bands 0..1, for spectrum display
}

const BAR_COUNT = 24;

type EnergyCallback = (f: AudioFeatures) => void;

export class AudioCapture {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private fft = new Uint8Array(0);
  private energyEMA = 0;
  private running = false;
  private readonly bars = new Array<number>(BAR_COUNT).fill(0);
  private readonly externalCtx: AudioContext | undefined;

  public onEnergy: EnergyCallback | null = null;
  /** Called once after start() succeeds — for routing the source to other consumers. */
  public onSource: ((source: MediaStreamAudioSourceNode, ctx: AudioContext) => void) | null = null;
  /** Called after a tab is shared and includes a video track. Provides a
   *  hidden, muted, autoplaying <video> element that consumers can sample
   *  on demand (e.g. for the slideshow). */
  public onVideo: ((video: HTMLVideoElement) => void) | null = null;
  /** Called when video stops being available (user stopped share / disconnect). */
  public onVideoEnd: (() => void) | null = null;

  constructor(externalCtx?: AudioContext) {
    this.externalCtx = externalCtx;
  }

  get isActive(): boolean { return this.source !== null; }

  /** Capture audio from a shared tab/window via getDisplayMedia.
   *  Browser requires a video track too; we wire it to a hidden
   *  element so the slideshow can sample frames from it. */
  async startTab(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          // turn off processing — we want raw signal energy
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
        // Keep video at reasonable quality — we sample frames on demand
        // (e.g. for the slideshow). 30fps is plenty since we don't render
        // continuously.
        video: { width: 1280, height: 720, frameRate: 30 },
      });

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        for (const t of stream.getTracks()) t.stop();
        return { ok: false, reason: "no_audio_track" };
      }

      // Wire up the video track to a hidden <video> element so consumers
      // can sample frames from it. Mute + autoplay required so it decodes
      // without user gesture and doesn't double-play audio.
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0) {
        const v = document.createElement("video");
        v.muted = true;
        v.autoplay = true;
        v.playsInline = true;
        v.style.position = "fixed";
        v.style.left = "-10000px";
        v.style.top = "-10000px";
        v.style.width = "1px";
        v.style.height = "1px";
        v.style.pointerEvents = "none";
        v.style.opacity = "0";
        v.srcObject = new MediaStream(videoTracks);
        document.body.appendChild(v);
        try { await v.play(); } catch { /* autoplay may still resolve later */ }
        this.videoEl = v;
        this.onVideo?.(v);
      }

      return this.attachStream(stream);
    } catch (err) {
      console.warn("prism: tab audio capture failed", err);
      return { ok: false, reason: (err as Error).message ?? "unknown" };
    }
  }

  /** Capture audio from the system microphone via getUserMedia. Same
   *  audio-only contract as startTab; no video track. Browser will
   *  prompt for mic permission on first call. */
  async startMic(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Critical for music: keep all the processing OFF or ambient
          // music gets squashed into mush. Browser default tries to
          // optimize for voice and kills the bass.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
        video: false,
      });
      return this.attachStream(stream);
    } catch (err) {
      console.warn("prism: mic capture failed", err);
      return { ok: false, reason: (err as Error).message ?? "unknown" };
    }
  }

  /** Backwards-compat alias for the original tab-only entry point. */
  start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.startTab();
  }

  /** Shared post-acquisition wiring: analyzer, FFT loop, ended-track
   *  cleanup, onSource callback. */
  private attachStream(stream: MediaStream): { ok: true } {
    // Detect user stopping share / disconnecting mic from system chrome.
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => this.stop());
    }

    this.stream = stream;
    this.context = this.externalCtx ?? new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.fft = new Uint8Array(this.analyser.frequencyBinCount);
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.onSource?.(this.source, this.context);

    this.running = true;
    this.loop();
    return { ok: true };
  }

  private loop = (): void => {
    if (!this.running || !this.analyser) return;
    // Cast through unknown to satisfy TS with the modern ArrayBuffer-typed view.
    this.analyser.getByteFrequencyData(this.fft as unknown as Uint8Array<ArrayBuffer>);

    const n = this.fft.length;
    const bassEnd = Math.floor(n * 0.08);
    const midEnd = Math.floor(n * 0.40);
    let bass = 0, mid = 0, treble = 0;
    for (let i = 0; i < n; i++) {
      const v = this.fft[i] / 255;
      if (i < bassEnd) bass += v;
      else if (i < midEnd) mid += v;
      else treble += v;
    }
    bass /= Math.max(1, bassEnd);
    mid /= Math.max(1, midEnd - bassEnd);
    treble /= Math.max(1, n - midEnd);

    const energy = bass * 0.55 + mid * 0.30 + treble * 0.15;
    this.energyEMA = this.energyEMA * 0.7 + energy * 0.3;

    // log-binned spectrum bars for display
    const minBin = 2; // skip DC + sub-bass artifacts
    for (let b = 0; b < BAR_COUNT; b++) {
      const t0 = b / BAR_COUNT;
      const t1 = (b + 1) / BAR_COUNT;
      // exponential bin edges so low end gets more bands
      const lo = Math.max(minBin, Math.floor(minBin + (n - minBin) * (t0 * t0)));
      const hi = Math.max(lo + 1, Math.floor(minBin + (n - minBin) * (t1 * t1)));
      let s = 0;
      for (let i = lo; i < hi && i < n; i++) s += this.fft[i];
      const avg = s / Math.max(1, hi - lo) / 255;
      // smoothing per-bar
      this.bars[b] = this.bars[b] * 0.55 + avg * 0.45;
    }

    this.onEnergy?.({ energy: this.energyEMA, bass, mid, treble, bars: this.bars });

    requestAnimationFrame(this.loop);
  };

  stop(): void {
    this.running = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* ignore */ }
      this.source = null;
    }
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch { /* ignore */ }
      this.videoEl.srcObject = null;
      this.videoEl.remove();
      this.videoEl = null;
      this.onVideoEnd?.();
    }
    // Only close the AudioContext if we created it ourselves; otherwise the
    // owner (e.g. main.ts) keeps using it.
    if (this.context && !this.externalCtx) {
      void this.context.close();
    }
    this.context = null;
    this.analyser = null;
  }
}
