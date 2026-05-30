// ambient-signals.ts — session metadata source.
//
// Distinct from the fast live signals (audio, cursor, heartbeat): these are
// slow-changing session-context values that change on minute/hour scales.
// Audio reacts every frame; metadata is sampled every few seconds.
//
// M3 ships only zero-permission, no-API fields. The schema accommodates
// adding weather / geo / battery later without breaking consumers.

export interface SessionMetadata {
  /** Fraction of a 24h day, 0 at midnight, 0.5 at noon, → 1.0 → wraps to 0. */
  time_of_day: number;
  /** 3-letter weekday in lowercase: "mon", "tue", … */
  day_of_week: string;
  /** Milliseconds since the page was loaded. */
  session_ms: number;
  /** Viewport in raw px. */
  viewport: { w: number; h: number };
  /** OS-level reduced-motion preference. */
  prefers_reduced_motion: boolean;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export class AmbientSignals {
  private readonly startedAt = performance.now();
  private cached: SessionMetadata | null = null;
  private lastSampleAt = -Infinity;
  private static readonly REFRESH_MS = 4_000;

  /** Returns the current session metadata. Memoised for ~4s so hot loops
   *  don't pay the Date+matchMedia cost on every frame. */
  sample(): SessionMetadata {
    const now = performance.now();
    if (this.cached && now - this.lastSampleAt < AmbientSignals.REFRESH_MS) {
      // Session time still needs to update — bump that one field cheaply.
      this.cached.session_ms = Math.round(now - this.startedAt);
      return this.cached;
    }
    const d = new Date();
    const fractionalDay =
      (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86_400;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.cached = {
      time_of_day: fractionalDay,
      day_of_week: DAYS[d.getDay()],
      session_ms: Math.round(now - this.startedAt),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      prefers_reduced_motion: reducedMotion,
    };
    this.lastSampleAt = now;
    return this.cached;
  }
}
