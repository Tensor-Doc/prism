// ws-transport.ts — real WebSocket implementation of SwarmTransport.
// Pairs with api/swarm-relay/server.mjs. Auto-reconnects with capped
// exponential backoff so a relay restart doesn't sever the session.
//
// The relay stamps every outgoing message with the connection's
// server-assigned id, so a packet's `id` field always reflects the
// actual sender — clients can't spoof. We ignore the `kind: "hello"`
// greeting and the `kind: "bye"` peer-departure messages here; the
// SwarmClient handles only cursor + audio packets it knows about.

import type { SwarmPacket, SwarmRole, SwarmTransport } from "./transport";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

interface HelloPacket { kind: "hello"; id: string; hue?: number; role?: SwarmRole }
type ServerPacket = SwarmPacket | HelloPacket;

export class WebSocketTransport implements SwarmTransport {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private subscribers = new Set<(p: SwarmPacket) => void>();
  private outboundQueue: SwarmPacket[] = [];
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;
  private serverId: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  start(_role: SwarmRole): void {
    // Role is host/audience advisory only — the relay doesn't care, and
    // broadcast vs. audience-receive is gated client-side via SwarmClient.
    this.intentionallyClosed = false;
    this.open();
  }

  stop(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, "client-stop"); } catch { /* ignore */ }
      this.ws = null;
    }
    this.subscribers.clear();
    this.outboundQueue.length = 0;
    this.serverId = null;
  }

  send(packet: SwarmPacket): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(packet)); }
      catch { /* drop on the floor — next packet retries */ }
      return;
    }
    // Not connected yet: keep only the latest cursor/audio of each
    // kind so we don't flood when the socket finally opens.
    this.outboundQueue = this.outboundQueue.filter((p) => p.kind !== packet.kind);
    this.outboundQueue.push(packet);
    if (this.outboundQueue.length > 8) this.outboundQueue.shift();
  }

  onPacket(cb: (p: SwarmPacket) => void): () => void {
    this.subscribers.add(cb);
    return (): void => { this.subscribers.delete(cb); };
  }

  /** Server-assigned id for this client. null until the hello arrives. */
  get peerId(): string | null { return this.serverId; }

  private open(): void {
    if (this.intentionallyClosed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.warn("[swarm-ws] construct failed:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener("open", () => {
      this.backoff = INITIAL_BACKOFF_MS;
      // Flush any packets we buffered while disconnected.
      for (const p of this.outboundQueue) {
        try { this.ws?.send(JSON.stringify(p)); } catch { /* ignore */ }
      }
      this.outboundQueue.length = 0;
    });
    this.ws.addEventListener("message", (ev) => {
      let msg: ServerPacket;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
      catch { return; }
      if (msg.kind === "hello") {
        this.serverId = msg.id;
        // Surface the initial role through the same packet stream that
        // handles later role changes — SwarmClient subscribes once.
        if (msg.role) {
          for (const cb of this.subscribers) {
            cb({ kind: "role", role: msg.role, t: Date.now() });
          }
        }
        return;
      }
      if (
        msg.kind === "cursor" || msg.kind === "audio" || msg.kind === "beat" ||
        msg.kind === "bpm"    || msg.kind === "bye"   || msg.kind === "schedule" ||
        msg.kind === "role"
      ) {
        for (const cb of this.subscribers) cb(msg);
      }
    });
    this.ws.addEventListener("close", () => {
      this.ws = null;
      this.serverId = null;
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // Close handler also fires after error; reconnect lives there.
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectTimer != null) return;
    const delay = this.backoff;
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
