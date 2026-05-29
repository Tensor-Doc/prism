// input-pulses.ts — transient input events exposed as "control variables".
//
// Click and double-click are surfaced as pulses (0/1) with position. The
// consume-on-read pattern means each pulse fires exactly once per frame:
//   - input fires → state.click.fired = 1
//   - consumer reads via consume() → returns the snapshot AND clears it
//   - next consume() returns zeros unless another event fired in between
//
// Designed to match the contract Prism's visualization skills will use:
// declared signal inputs of type "pulse" that the runtime broadcasts per
// frame, then resets — same semantics as Milkdrop's q-vars or ISF beats.

export interface PulseEvent {
  fired: number; // 0 or 1
  x: number;     // screen X at the moment of the event (undefined coords return 0)
  y: number;     // screen Y
}

export interface PulseSnapshot {
  click: PulseEvent;
  dblclick: PulseEvent;
}

const ZERO: PulseEvent = { fired: 0, x: 0, y: 0 };

export class InputPulses {
  private state: PulseSnapshot = {
    click: { ...ZERO },
    dblclick: { ...ZERO },
  };

  constructor() {
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    window.addEventListener("dblclick", this.onDblClick, { passive: true });
  }

  /** Read current pulses AND clear them. Call once per frame from the
   *  orchestrator; distribute the result to all visualizers that want it. */
  consume(): PulseSnapshot {
    const out: PulseSnapshot = {
      click: { ...this.state.click },
      dblclick: { ...this.state.dblclick },
    };
    this.state.click.fired = 0;
    this.state.dblclick.fired = 0;
    return out;
  }

  /** Read without clearing — for diagnostic / "is something pending" checks. */
  peek(): Readonly<PulseSnapshot> {
    return this.state;
  }

  destroy(): void {
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("dblclick", this.onDblClick);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.state.click.fired = 1;
    this.state.click.x = e.clientX;
    this.state.click.y = e.clientY;
  };

  private onDblClick = (e: MouseEvent): void => {
    this.state.dblclick.fired = 1;
    this.state.dblclick.x = e.clientX;
    this.state.dblclick.y = e.clientY;
  };
}
