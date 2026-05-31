// image-overlay.ts — draggable, resizable, collapsible PiP card.
//
// A pure-UI companion to PrismPlayer. The card has no opinion about
// what's inside it — it just provides a positioned rectangle (the
// `rect` property) that an embedder can sync to a slideshow's render
// region, a video element, or anything else that wants to live in a
// PiP. Drag from the body to move; drag from the 4 corner handles to
// resize; click the × button to collapse to a thumbnail in the upper
// right; click the thumbnail to expand again.
//
// Styling is class-based with a customisable prefix so the host page
// can theme it. Defaults to `prism-overlay` with BEM-style modifiers
// (`__handle`, `__collapse`); prism.run passes `slideshow-card` to
// inherit its existing styles unchanged.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayState {
  rect: Rect;
  collapsed: boolean;
}

export interface ImageOverlayOptions {
  /** Element to mount the card div in. Defaults to document.body. */
  mount?: HTMLElement;
  /** Initial card rect in CSS pixels. Defaults to a centered card sized
   *  to ~58% of viewport width. */
  initialRect?: Rect;
  /** BEM class prefix for the card and its parts. Defaults to
   *  "prism-overlay" — produces classes `.prism-overlay`,
   *  `.prism-overlay__handle`, `.prism-overlay__collapse`. */
  className?: string;
  /** Thumbnail (collapsed) width in CSS pixels. Defaults to 200. */
  thumbWidth?: number;
  /** Min visible margin in pixels — drag is clamped so this much of
   *  the card always stays in the viewport. Defaults to 60. */
  minVisible?: number;
  /** Min top edge (pixels from viewport top), e.g. to clear a status
   *  bar. Defaults to 36. */
  topMargin?: number;
  /** Minimum card dimensions while resizing. Defaults to 80×45 (16:9). */
  minWidth?: number;
  minHeight?: number;
  /** Called whenever the rect or collapsed state changes (drag, resize,
   *  collapse, expand, window resize re-anchor). */
  onChange?: (state: OverlayState) => void;
}

interface DragState {
  startCard: Rect;
  startPointer: { x: number; y: number };
  handle: string | null;
}

export class ImageOverlay {
  readonly element: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly className: string;
  private readonly thumbW: number;
  private readonly thumbH: number;
  private readonly thumbMargin = 16;
  private readonly statusBarH: number;
  private readonly minVisible: number;
  private readonly minWidth: number;
  private readonly minHeight: number;
  private readonly onChange?: (state: OverlayState) => void;

  private _rect: Rect;
  private _collapsed = false;
  private uncollapsedRect: Rect | null = null;
  private drag: DragState | null = null;
  private destroyed = false;

  constructor(opts: ImageOverlayOptions = {}) {
    this.mount = opts.mount ?? document.body;
    this.className = opts.className ?? "prism-overlay";
    this.thumbW = opts.thumbWidth ?? 200;
    this.thumbH = this.thumbW * (9 / 16);
    this.minVisible = opts.minVisible ?? 60;
    this.statusBarH = opts.topMargin ?? 36;
    this.minWidth = opts.minWidth ?? 80;
    this.minHeight = opts.minHeight ?? 45;
    this.onChange = opts.onChange;
    this._rect = opts.initialRect ?? this.defaultRect();

    this.element = this.buildDom();
    this.mount.appendChild(this.element);
    this.applyRectToDom();

    window.addEventListener("resize", this.onWindowResize, { passive: true });
  }

  /** Current card rect (live; do not mutate — call setRect instead). */
  get rect(): Rect {
    return { ...this._rect };
  }

  isCollapsed(): boolean {
    return this._collapsed;
  }

  /** Programmatically set the rect. Silent: does NOT call onChange.
   *  Use this to push externally-managed state into the overlay
   *  without echoing back into your own change handler. The internal
   *  drag/resize handlers emit onChange themselves — that's the only
   *  source of change notifications. */
  setRect(next: Rect): void {
    this._rect = { ...next };
    this.applyRectToDom();
  }

  /** Programmatically collapse. Silent — see setRect. */
  collapse(): void {
    if (this._collapsed) return;
    this.uncollapsedRect = { ...this._rect };
    this._rect = this.thumbRect();
    this._collapsed = true;
    this.element.setAttribute("data-collapsed", "");
    this.applyRectToDom();
  }

  /** Programmatically expand. Silent — see setRect. */
  expand(): void {
    if (!this._collapsed) return;
    this._rect = this.uncollapsedRect ?? this.defaultRect();
    this._collapsed = false;
    this.element.removeAttribute("data-collapsed");
    this.applyRectToDom();
  }

  show(): void {
    this.element.removeAttribute("data-hidden");
  }

  hide(): void {
    this.element.setAttribute("data-hidden", "");
  }

  /** Whether the card is currently visible (DOM attribute is the
   *  source of truth, so this stays accurate if anyone toggles it
   *  externally for testing). */
  isVisible(): boolean {
    return !this.element.hasAttribute("data-hidden");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener("resize", this.onWindowResize);
    this.element.remove();
  }

  // ── internals ──────────────────────────────────────────────

  private buildDom(): HTMLElement {
    const card = document.createElement("div");
    card.className = this.className;
    card.setAttribute("data-hidden", "");

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = `${this.className}__collapse`;
    collapseBtn.title = "Collapse to thumbnail";
    collapseBtn.setAttribute("aria-label", "Collapse");
    const collapseIcon = document.createElement("span");
    collapseIcon.setAttribute("aria-hidden", "true");
    collapseIcon.textContent = "−";
    collapseBtn.appendChild(collapseIcon);
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.collapse();
      this.emit();
    });
    card.appendChild(collapseBtn);

    for (const corner of ["tl", "tr", "bl", "br"] as const) {
      const handle = document.createElement("span");
      handle.className = `${this.className}__handle ${this.className}__handle--${corner}`;
      handle.dataset.handle = corner;
      handle.setAttribute("aria-hidden", "true");
      card.appendChild(handle);
    }

    card.addEventListener("pointerdown", this.onPointerDown);
    card.addEventListener("pointermove", this.onPointerMove);
    card.addEventListener("pointerup", this.onPointerEnd);
    card.addEventListener("pointercancel", this.onPointerEnd);

    return card;
  }

  private applyRectToDom(): void {
    const r = this._rect;
    this.element.style.left = `${r.x}px`;
    this.element.style.top = `${r.y}px`;
    this.element.style.width = `${r.w}px`;
    this.element.style.height = `${r.h}px`;
  }

  private emit(): void {
    this.onChange?.({ rect: { ...this._rect }, collapsed: this._collapsed });
  }

  private defaultRect(): Rect {
    // Centered, ~58% viewport width, 16:9 unless taller fits.
    const W = window.innerWidth;
    const H = window.innerHeight;
    const rw = W * 0.58;
    const rh = Math.min(rw * (9 / 16), H * 0.54);
    return { x: (W - rw) / 2, y: H * 0.16, w: rw, h: rh };
  }

  private thumbRect(): Rect {
    return {
      x: window.innerWidth - this.thumbW - this.thumbMargin,
      y: this.statusBarH + this.thumbMargin,
      w: this.thumbW,
      h: this.thumbH,
    };
  }

  private clampRect(r: Rect): Rect {
    return {
      x: Math.max(-(r.w - this.minVisible), Math.min(window.innerWidth - this.minVisible, r.x)),
      y: Math.max(this.statusBarH, Math.min(window.innerHeight - this.minVisible, r.y)),
      w: r.w,
      h: r.h,
    };
  }

  private readonly onWindowResize = (): void => {
    if (this._collapsed) {
      // Re-anchor the thumb to the new upper-right corner.
      this._rect = this.thumbRect();
      this.applyRectToDom();
      this.emit();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    const target = e.target as HTMLElement;
    if (target.closest(`.${this.className}__collapse`)) return; // collapse btn handles itself

    if (this._collapsed) {
      // Clicking the thumbnail expands.
      e.preventDefault();
      this.expand();
      this.emit();
      return;
    }

    e.preventDefault();
    this.element.setPointerCapture(e.pointerId);
    this.drag = {
      startCard: { ...this._rect },
      startPointer: { x: e.clientX, y: e.clientY },
      handle: target.classList.contains(`${this.className}__handle`)
        ? (target.dataset.handle ?? null)
        : null,
    };
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.preventDefault();
    const dx = e.clientX - this.drag.startPointer.x;
    const dy = e.clientY - this.drag.startPointer.y;
    const s = this.drag.startCard;
    const h = this.drag.handle;

    if (h === null) {
      // Whole-card drag.
      this._rect = this.clampRect({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h });
    } else {
      // Corner resize. l/r/t/b combinations resize from the matching edge.
      let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
      if (h.includes("r")) nw = Math.max(this.minWidth, s.w + dx);
      if (h.includes("l")) { nw = Math.max(this.minWidth, s.w - dx); nx = s.x + (s.w - nw); }
      if (h.includes("b")) nh = Math.max(this.minHeight, s.h + dy);
      if (h.includes("t")) { nh = Math.max(this.minHeight, s.h - dy); ny = s.y + (s.h - nh); }
      this._rect = { x: nx, y: ny, w: nw, h: nh };
    }
    this.applyRectToDom();
    this.emit();
  };

  private readonly onPointerEnd = (e: PointerEvent): void => {
    if (!this.drag) return;
    try {
      this.element.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.drag = null;
  };
}

