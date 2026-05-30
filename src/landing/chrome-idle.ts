// chrome-idle.ts — fade the UI chrome after N seconds of no user input so
// the visualization breathes alone on screen. Any pointermove / keydown /
// scroll / touch wakes the chrome instantly. The actual fade is CSS; this
// module just toggles a body attribute the styles target.
//
// `data-chrome-idle` on <body>:
//   absent   → chrome visible, normal interactivity
//   "fading" → chrome opacity:0, pointer-events:none, cursor hidden (after grace)

interface ChromeIdleOptions {
  /** ms of no input before fading begins. */
  idleMs?: number;
  /** ms after fade-out before the OS cursor is hidden too. */
  cursorHideExtraMs?: number;
  /** Skip the initial idle countdown — boot already faded. */
  startFaded?: boolean;
}

export class ChromeIdle {
  private readonly idleMs: number;
  private readonly cursorHideExtraMs: number;
  private fadeTimer: number | null = null;
  private cursorTimer: number | null = null;
  private destroyed = false;

  constructor(opts: ChromeIdleOptions = {}) {
    this.idleMs = opts.idleMs ?? 4_000;
    this.cursorHideExtraMs = opts.cursorHideExtraMs ?? 2_000;
    const events: Array<keyof WindowEventMap> = [
      "pointermove",
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    for (const name of events) {
      window.addEventListener(name, this.wake, { passive: true });
    }
    // The entrance reveal animations have `animation-fill-mode: forwards`,
    // which locks opacity at 1 and beats our fade-on-idle selectors. Once
    // the staggered reveal has completed (~longest delay 640ms + page
    // duration 800ms + small buffer), release the locks so our transition
    // rules can take over. We strip [data-reveal] for the panel chrome and
    // clear inline animations from elements with their own opacity-in
    // keyframes (the prompt panel uses one).
    window.setTimeout(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
        el.removeAttribute("data-reveal");
      }
      const prompt = document.getElementById("prompt-panel");
      if (prompt) prompt.style.animation = "none";
    }, 1_600);
    if (opts.startFaded) {
      this.fade();
    } else {
      this.scheduleFade();
    }
  }

  private wake = (): void => {
    if (this.destroyed) return;
    document.body.removeAttribute("data-chrome-idle");
    document.body.style.cursor = "";
    this.scheduleFade();
  };

  private scheduleFade(): void {
    if (this.fadeTimer != null) clearTimeout(this.fadeTimer);
    if (this.cursorTimer != null) clearTimeout(this.cursorTimer);
    this.fadeTimer = window.setTimeout(() => this.fade(), this.idleMs);
  }

  private fade(): void {
    document.body.setAttribute("data-chrome-idle", "");
    this.cursorTimer = window.setTimeout(() => {
      // Only hide cursor if we're still idle when the timer fires.
      if (document.body.hasAttribute("data-chrome-idle")) {
        document.body.style.cursor = "none";
      }
    }, this.cursorHideExtraMs);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.fadeTimer != null) clearTimeout(this.fadeTimer);
    if (this.cursorTimer != null) clearTimeout(this.cursorTimer);
    document.body.removeAttribute("data-chrome-idle");
    document.body.style.cursor = "";
  }
}
