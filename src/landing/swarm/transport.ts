// transport.ts — abstract carrier for swarm packets.
// The mock transport (mock-transport.ts) is what ships in this pass.
// A real WebSocket relay can implement the same interface without any
// client-side change — only swap the construction site in main.ts.

export type SwarmPacket =
  /** Cursor for a slot. The relay stamps `occupied` and `hue` so the
   *  client can render agent vs. human-occupied stars without knowing
   *  the server's slot table. Vacant agent slots are emitted by the
   *  relay's own tick loop; occupied slots are forwarded human input. */
  | {
      kind: "cursor";
      id: string;
      x01: number;
      y01: number;
      t: number;
      occupied: boolean;
      hue: number;
    }
  /** Host-broadcast audio spectrum. A compact log-binned array (16
   *  bands by convention) so every client can animate the same VU +
   *  spectrum bars that drive milkdrop. */
  | { kind: "audio"; id: string; audio: number[]; t: number }
  /** A heartbeat fired. Carries no payload beyond timing — the
   *  current rate is communicated via separate `bpm` packets so a
   *  receiver can render the pulse envelope between beats. */
  | { kind: "beat"; id: string; t: number }
  /** Updated heart rate for the slot. Occasional, not per-tick. */
  | { kind: "bpm"; id: string; bpm: number; t: number }
  /** A peer has disconnected — drop their ghost cursor immediately
   *  instead of waiting for the TTL gc. Server-emitted only. */
  | { kind: "bye"; id: string; t: number }
  /** Host-broadcast preset swap. `at` is server wall-clock ms; every
   *  receiver schedules the same swap at their local equivalent. The
   *  graph token is anything PrismPlayer.load() accepts (a short_id
   *  string or a full PrismGraph object). */
  | {
      kind: "schedule";
      id: string;
      at: number;
      graph: unknown;
      presetName?: string;
      t: number;
    }
  /** Server tells this specific client its role has changed. Only the
   *  affected client receives a `role` packet. */
  | { kind: "role"; role: SwarmRole; t: number }
  /** Click-as-pull: this peer pulls the swarm's center-of-mass toward
   *  (x01, y01). Each pull contributes a weighted virtual peer to the
   *  CoM and decays exponentially over ~2 s, so the user has to keep
   *  clicking to maintain the bias. */
  | { kind: "pull"; id: string; x01: number; y01: number; t: number };

export type SwarmRole = "host" | "audience";

export interface SwarmTransport {
  /** Begin emitting packets. Role tells the transport whether to expect
   *  an incoming audio stream (audience) or to relay this client's own
   *  audio out (host). */
  start(role: SwarmRole): void;
  /** Stop all timers/sockets. Idempotent. */
  stop(): void;
  /** Send a packet out to the swarm (or, in the mock, swallow it — the
   *  mock peers don't react to this client's broadcast in this pass). */
  send(packet: SwarmPacket): void;
  /** Subscribe to inbound packets. Returns an unsubscribe fn. */
  onPacket(cb: (packet: SwarmPacket) => void): () => void;
}
