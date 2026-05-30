// Test-signal recorder. Captures 30s of the live tab-shared audio into a
// WebM/Opus blob, then downloads it locally so the user can drop it at
// public/audio/test-signal.webm. The capture pipeline picks that file up
// for all subsequent preset annotations — a single deterministic
// "Pink Floyd Money 1:10-1:40" stimulus across all 526 renders.
//
// Why download + manual drop instead of auto-upload?
// - No new Vercel env vars needed for an Edge upload endpoint
// - User keeps explicit control over which 30s clip becomes canonical
// - Re-recording is just "click + drop again"

const DURATION_MS = 30_000;
const MIME = "audio/webm;codecs=opus";
const BITRATE = 128_000;
const FILENAME = "prism-test-signal.webm";

export type RecorderStatus = "idle" | "recording" | "encoding" | "saved" | "error";

export class TestSignalRecorder {
  onStatus: ((s: RecorderStatus, payload?: { error?: string; sizeBytes?: number }) => void) | null = null;
  private recorder: MediaRecorder | null = null;

  /** Returns true if the browser can record this MIME (most evergreen browsers can). */
  static isSupported(): boolean {
    return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(MIME);
  }

  /** Record DURATION_MS of the provided audio-bearing MediaStream → download
   *  as FILENAME. The stream should be the shared tab's audio track (we get
   *  it via the AudioCapture's source.mediaStream).  */
  async record(stream: MediaStream): Promise<void> {
    if (this.recorder && this.recorder.state !== "inactive") {
      throw new Error("already recording");
    }
    if (!TestSignalRecorder.isSupported()) {
      this.onStatus?.("error", { error: "MediaRecorder doesn't support audio/webm;codecs=opus in this browser" });
      return;
    }
    // Audio-only sub-stream — drop the video track if the shared tab had one.
    const audioOnly = new MediaStream(stream.getAudioTracks());
    if (audioOnly.getAudioTracks().length === 0) {
      this.onStatus?.("error", { error: "no audio track in stream" });
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(audioOnly, { mimeType: MIME, audioBitsPerSecond: BITRATE });
    this.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    this.onStatus?.("recording");
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.start();
    window.setTimeout(() => rec.stop(), DURATION_MS);
    await stopped;
    this.recorder = null;
    this.onStatus?.("encoding");
    const blob = new Blob(chunks, { type: "audio/webm" });
    triggerDownload(blob, FILENAME);
    this.onStatus?.("saved", { sizeBytes: blob.size });
  }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click event has propagated.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
