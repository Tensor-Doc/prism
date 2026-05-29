// pulsoid.ts — real-time heart-rate stream via Pulsoid's WebSocket API.
// One token (user pastes; persisted in localStorage). Emits:
//   - onHeartRate(bpm)       when a new HR message arrives
//   - onBeat()               on a synthesised heartbeat at the current BPM
//   - onStatus(state, msg?)  on lifecycle changes
//
// Pulsoid docs: https://pulsoid.net/developers/api-documentation
// WebSocket URL: wss://dev.pulsoid.net/api/v1/data/real_time?access_token=…
// Message shape: { measured_at, data: { heart_rate: <int>, ... } }

const PULSOID_WS = "wss://dev.pulsoid.net/api/v1/data/real_time";
const TOKEN_KEY = "prism.pulsoid.token";

export type PulsoidStatus = "idle" | "connecting" | "live" | "error" | "offline";

export interface PulsoidMessage {
  measured_at?: number;
  data?: { heart_rate?: number };
}

export class PulsoidStream {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectTimer: number | null = null;
  private beatTimer: number | null = null;
  private simulateTimer: number | null = null;
  private simulating = false;
  private lastBpm = 0;
  private status: PulsoidStatus = "idle";

  public onHeartRate: ((bpm: number) => void) | null = null;
  public onBeat: (() => void) | null = null;
  public onStatus: ((status: PulsoidStatus, msg?: string) => void) | null = null;

  /** True when the stream is producing synthesised beats (no real watch). */
  get isSimulated(): boolean { return this.simulating; }

  static loadToken(): string | null {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  static saveToken(token: string): void {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  }
  static clearToken(): void {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  get isLive(): boolean { return this.status === "live"; }
  get currentBpm(): number { return this.lastBpm; }

  connect(token: string): void {
    this.disconnect();
    this.token = token;
    this.openSocket();
    this.startBeatTimer();
  }

  disconnect(): void {
    if (this.reconnectTimer != null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.beatTimer != null) { clearTimeout(this.beatTimer); this.beatTimer = null; }
    if (this.simulateTimer != null) { clearTimeout(this.simulateTimer); this.simulateTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.lastBpm = 0;
    this.token = null;
    this.simulating = false;
    this.setStatus("offline");
  }

  /**
   * Demo mode — synthesise heartbeats at a fixed BPM. For users without a
   * Pulsoid token who still want to see the heart-driven visualization.
   */
  simulate(bpm = 72): void {
    this.disconnect();
    this.simulating = true;
    this.lastBpm = bpm;
    this.setStatus("live");
    // Emit one initial HR reading so the UI shows the value immediately
    this.onHeartRate?.(bpm);
    const intervalMs = 60000 / Math.max(20, Math.min(220, bpm));
    const tick = (): void => {
      if (!this.simulating) return;
      this.onBeat?.();
      this.simulateTimer = window.setTimeout(tick, intervalMs);
    };
    // First beat after a brief delay so the status change settles first
    this.simulateTimer = window.setTimeout(tick, intervalMs * 0.5);
  }

  private setStatus(s: PulsoidStatus, msg?: string): void {
    this.status = s;
    this.onStatus?.(s, msg);
  }

  private openSocket(): void {
    if (!this.token) return;
    this.setStatus("connecting");
    const url = `${PULSOID_WS}?access_token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setStatus("error", (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.setStatus("live");
    });

    ws.addEventListener("message", (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as PulsoidMessage;
        const bpm = msg.data?.heart_rate;
        if (typeof bpm === "number" && bpm > 0) {
          this.lastBpm = bpm;
          this.onHeartRate?.(bpm);
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.addEventListener("error", () => {
      this.setStatus("error", "connection error");
    });

    ws.addEventListener("close", (e: CloseEvent) => {
      this.ws = null;
      // 1008/4001 etc indicate auth failure — don't retry
      if (e.code === 4001 || e.code === 1008 || e.code === 4003) {
        this.setStatus("error", "invalid token");
        this.token = null;
        return;
      }
      if (this.token) this.scheduleReconnect();
      else this.setStatus("offline");
    });
  }

  private scheduleReconnect(): void {
    if (!this.token) return;
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 4000);
  }

  /** Synthesise beats at the current BPM so visuals pulse smoothly between
   *  Pulsoid update arrivals (typical update rate is 1 Hz). */
  private startBeatTimer(): void {
    const tick = (): void => {
      if (this.lastBpm > 0 && this.status === "live") this.onBeat?.();
      const interval = this.lastBpm > 0 ? Math.max(180, 60000 / this.lastBpm) : 1000;
      this.beatTimer = window.setTimeout(tick, interval);
    };
    this.beatTimer = window.setTimeout(tick, 800);
  }
}
