// conductor.ts — synchronised preset swaps for shared mode.
//
// One client is the host (server-assigned). When the host's local
// rotation timer fires, it broadcasts a `schedule` packet whose `at`
// is ~2.5 s in the (server-clock) future. Every receiving client —
// host and audience — schedules the swap to fire at the same wall-
// clock moment, using SwarmClient's clock offset to convert to local
// time. The host also schedules its own local swap from the broadcast,
// so the host's view stays in step with everyone else even if it
// arrives a few ms after the audience.
//
// Each client precompiles textures the moment it sees the schedule so
// the swap fires on a warm cache.

import type { SwarmClient } from "./client";
import type { PrismPlayer } from "@tensordoc/prism";

const LEAD_TIME_MS = 2_500;

interface PendingSwap {
  graph: unknown;
  presetName?: string;
  timer: number;
}

export class Conductor {
  private readonly client: SwarmClient;
  private readonly player: PrismPlayer;
  private pending: PendingSwap | null = null;
  /** Called whenever a synchronised swap actually fires, so main.ts can
   *  refresh the graph-flow display, skill chip etc. */
  public onSwap: ((arg: { graph: unknown; presetName?: string }) => void) | null = null;

  constructor(client: SwarmClient, player: PrismPlayer) {
    this.client = client;
    this.player = player;
    this.client.onSchedule = (s) => this.acceptSchedule(s);
  }

  /** Host call: broadcast + locally schedule a swap. Returns the server
   *  wall-clock `at` we picked, so callers can chain UI feedback. */
  broadcast(graph: unknown, presetName?: string): number | null {
    if (this.client.currentRole !== "host") return null;
    const atServer = this.client.serverNow() + LEAD_TIME_MS;
    this.client.sendSchedule(graph, atServer, presetName);
    // Host doesn't get its own broadcasts echoed back (relay filters
    // sender), so we have to apply the same schedule locally too.
    this.acceptSchedule({ at: atServer, graph, presetName });
    return atServer;
  }

  /** Cancel any pending swap — used on shared-mode exit. */
  cancelPending(): void {
    if (this.pending) {
      window.clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }

  /** Either-side handler: schedule a local swap at the right local time. */
  private acceptSchedule(s: { at: number; graph: unknown; presetName?: string }): void {
    // A new schedule supersedes any earlier pending one.
    this.cancelPending();

    const localAt = this.client.localTimeFor(s.at);
    const delay = Math.max(0, localAt - Date.now());

    const timer = window.setTimeout(() => {
      this.pending = null;
      const result = this.player.load(s.graph as Parameters<PrismPlayer["load"]>[0], 0.6);
      if (this.onSwap) this.onSwap({ graph: s.graph, presetName: s.presetName ?? result.presetName ?? undefined });
    }, delay);

    this.pending = { graph: s.graph, presetName: s.presetName, timer };
  }
}
