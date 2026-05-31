// @tensordoc/prism — CodeSandbox example
// The whole interface is `new PrismPlayer({ container })`. Everything
// else here is optional sugar to show off what you can do at runtime.

import { PrismPlayer } from "@tensordoc/prism";

// Read ?g=<short_id> so the sandbox doubles as a share-URL preview.
const shareToken = new URLSearchParams(location.search).get("g");

const player = new PrismPlayer({
  container: "viz",
  graph: shareToken ?? undefined,
});

// Browsers require a user gesture before AudioContext starts.
const resume = () => {
  if (player.audioCtx.state === "suspended") player.audioCtx.resume();
};
window.addEventListener("pointerdown", resume, { once: true });
window.addEventListener("keydown", resume, { once: true });

// ── Optional: swap audio / image sources at runtime ─────────
// This isn't necessary for the embed pitch — it just demos the API.

document.getElementById("btn-mic").addEventListener("click", () => {
  player.connectAudio("mic").catch((err) =>
    alert("mic denied or unsupported: " + err.message),
  );
});

document.getElementById("btn-tab").addEventListener("click", () => {
  player.connectAudio("tab").catch((err) =>
    alert("tab share denied or unsupported: " + err.message),
  );
});

// Free, no-key image feed for the demo — Lorem Picsum cycles random
// nature/abstract photography. Swap to your own URL list, webcam,
// tab, or any canvas/video element with no API change.
document.getElementById("btn-images").addEventListener("click", () => {
  player.connectImage([
    "https://picsum.photos/seed/aurora/1280/720",
    "https://picsum.photos/seed/cosmos/1280/720",
    "https://picsum.photos/seed/ocean/1280/720",
    "https://picsum.photos/seed/forest/1280/720",
  ]);
});

document.getElementById("btn-random").addEventListener("click", () => {
  player.milkdrop.loadRandom(2.5);
});

// Expose for console exploration:
//   player.connectImage("webcam")
//   player.load("7Hq3pK")
//   etc.
window.player = player;
