export interface AudioCapture {
  ctx: AudioContext;
  analyser: AnalyserNode;
  stop: () => void;
}

export async function startTabCapture(): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  stream.getVideoTracks().forEach((t) => t.stop());

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error(
      'No audio in the captured stream. Pick a tab and check "Share tab audio".',
    );
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const stop = () => {
    audioTracks.forEach((t) => t.stop());
    void ctx.close();
  };

  audioTracks[0].addEventListener("ended", stop);

  return { ctx, analyser, stop };
}
