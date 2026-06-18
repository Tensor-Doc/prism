// mode.ts — solo ↔ shared transition.
// Owns the bookkeeping for the swap: tears down listeners on the way
// out, primes the new pipeline on the way in, and runs a 200 ms lerp
// on the band reading so milkdrop doesn't snap from "local audio" to
// "synthesised swarm audio" in a single frame.
//
// State this module owns:
//   • the current AppMode
//   • the SilentAudioSynth instance (audience role only — created on
//     entry, destroyed on exit)
//   • the saved local audio source so we can rebind it on exit

import type { PrismPlayer } from "@tensordoc/prism";
import { SilentAudioSynth, bandsFromBars } from "./audio-bridge";
import type { BandReading, SwarmClient } from "./client";

export type AppMode = "solo" | "shared";

export interface ModeDeps {
  player: PrismPlayer;
  swarm: SwarmClient;
  /** Last-known local audio source (mic/tab) — for solo restore. Null
   *  if the user never shared audio in solo mode. */
  getSavedAudio: () => AudioNode | null;
  /** Tracks whether the body has data-app-mode="shared". */
  setBodyMode: (mode: AppMode) => void;
  /** Notified after each mode change so main.ts can toggle local
   *  cursor-modulation, the audio-pin chip, etc. */
  onChange?: (mode: AppMode) => void;
}

const LERP_MS = 200;

export class ModeController {
  private mode: AppMode = "solo";
  private silentSynth: SilentAudioSynth | null = null;
  private lerpFromBands: BandReading | null = null;
  private lerpStartedAt = 0;
  private unsubAudio: (() => void) | null = null;
  private readonly deps: ModeDeps;

  constructor(deps: ModeDeps) {
    this.deps = deps;
  }

  get current(): AppMode {
    return this.mode;
  }

  async setMode(next: AppMode): Promise<void> {
    if (next === this.mode) return;
    const prev = this.mode;
    this.mode = next;
    this.deps.setBodyMode(next);

    if (prev === "solo" && next === "shared") {
      await this.enterShared();
    } else if (prev === "shared" && next === "solo") {
      await this.enterSolo();
    }

    if (this.deps.onChange) this.deps.onChange(next);
  }

  private async enterShared(): Promise<void> {
    const { player, swarm } = this.deps;

    // Start the transport in audience role. (First-in-session=host is
    // a deferred UI prompt — see plan §3. Stubbed at "audience" so the
    // mock generates audio packets for us to render.)
    swarm.start("audience");

    // Snapshot the current synth band reading so the 200 ms lerp has a
    // sensible starting point even when we're already on the synthetic
    // driver. Silence (0,0,0) would dim milkdrop hard on the swap.
    const startBands = player.synth.readBands();
    this.lerpFromBands = {
      bass: startBands.bass,
      mid: startBands.mid,
      treb: startBands.treble,
    };
    this.lerpStartedAt = performance.now();

    // Build the silent synth + route it to the player. From this point
    // on the player's analyser is reading our oscillator rig instead
    // of mic/tab.
    const synth = new SilentAudioSynth(player.audioCtx);
    this.silentSynth = synth;
    await player.connectAudio(synth.output);

    // Wire incoming audio packets into the synth with a 200 ms lerp.
    // The packet carries a spectrum array; we derive 3 bands locally
    // to drive the silent oscillator rig (milkdrop only reads bass/
    // mid/treb scale anyway).
    this.unsubAudio = subscribeAudio(swarm, (audio) => {
      const incoming = bandsFromBars(audio);
      const blended = this.blend(incoming);
      synth.apply(blended);
    });
  }

  private async enterSolo(): Promise<void> {
    const { player, swarm, getSavedAudio } = this.deps;

    // Unsubscribe + stop transport first so no new audio packets land
    // while we're swapping graphs.
    if (this.unsubAudio) { this.unsubAudio(); this.unsubAudio = null; }
    this.lerpFromBands = null;
    swarm.stop();

    // Restore the player's audio source BEFORE tearing down the silent
    // synth — disconnectAudio/connectAudio walks the prior source's
    // node graph, and calling them after silentSynth.stop() would have
    // disconnected throws "given destination is not connected".
    const saved = getSavedAudio();
    try {
      if (saved) await player.connectAudio(saved);
      else player.disconnectAudio();
    } catch {
      // Prior source's graph was torn down out from under us — fall
      // back to the player's built-in synth driver.
      try { player.disconnectAudio(); } catch { /* ignore */ }
    }

    // Now the silent synth is safe to dismantle.
    if (this.silentSynth) { this.silentSynth.stop(); this.silentSynth = null; }
  }

  private blend(incoming: BandReading): BandReading {
    if (!this.lerpFromBands) return incoming;
    const elapsed = performance.now() - this.lerpStartedAt;
    if (elapsed >= LERP_MS) {
      this.lerpFromBands = null;
      return incoming;
    }
    const t = elapsed / LERP_MS;
    const from = this.lerpFromBands;
    return {
      bass: from.bass * (1 - t) + incoming.bass * t,
      mid: from.mid * (1 - t) + incoming.mid * t,
      treb: from.treb * (1 - t) + incoming.treb * t,
    };
  }
}

function subscribeAudio(
  swarm: SwarmClient,
  cb: (audio: number[]) => void,
): () => void {
  const prev = swarm.onAudio;
  swarm.onAudio = (audio) => {
    if (prev) prev(audio);
    cb(audio);
  };
  return (): void => { swarm.onAudio = prev; };
}
