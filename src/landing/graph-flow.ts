// graph-flow.ts — the "AWESOME moment" of the landing page.
//
// Renders the live PrismGraph as a small pill-chain inside the STATE
// panel. Visitors see the prompt→graph→runtime story made physical:
//
//   ◉ audio → ◍ shadertoy → ▣ display
//
// The LF (light-field generator) node is the cyan accent; everything
// else fades back. When audio is live, a tiny cyan dot streams along
// each edge, making "signal → light field → sink" feel alive.
//
// Accepts either:
//   render(graph: PrismGraph) — from the runtime, after a successful apply
//   showChain(types)          — synthetic chain for cold-open before any
//                                prompt has resolved to a real graph

import type { NodeType, PrismGraph } from "@tensordoc/prism";

const LABELS: Partial<Record<NodeType, string>> = {
  "signal.audio": "audio",
  "signal.cursor": "cursor",
  "signal.heartbeat": "heart",
  "signal.synth": "synth",
  "lf.milkdrop": "milkdrop",
  "lf.shadertoy": "shadertoy",
  "lf.isf": "isf",
  "sink.display": "display",
  "sink.recorder": "recorder",
  "op.blend": "blend",
  "op.displace": "displace",
  "op.feedback": "feedback",
  "xform.gain": "gain",
  "xform.beat": "beat",
};

const GLYPHS: Partial<Record<NodeType, string>> = {
  "signal.audio": "♪",
  "signal.cursor": "⌖",
  "signal.heartbeat": "♥",
  "signal.synth": "≈",
  "lf.milkdrop": "◉",
  "lf.shadertoy": "◍",
  "lf.isf": "◌",
  "sink.display": "▣",
  "sink.recorder": "●",
};

const ROLE_ORDER = ["signal", "xform", "lf", "op", "sink"] as const;

function roleOf(type: NodeType): (typeof ROLE_ORDER)[number] {
  return type.split(".")[0] as (typeof ROLE_ORDER)[number];
}

export class GraphFlow {
  private readonly host: HTMLElement;
  private readonly chain: HTMLElement;
  private readonly idEl: HTMLElement;

  constructor() {
    const host = document.getElementById("state-graph");
    if (!host) throw new Error("graph-flow: #state-graph not found");
    this.host = host;
    this.chain = host.querySelector(".state-graph__chain") as HTMLElement;
    this.idEl = host.querySelector("#state-graph-id") as HTMLElement;
  }

  /** Render a real PrismGraph from the runtime. */
  render(graph: PrismGraph): void {
    const ordered = Object.entries(graph.nodes).sort(
      ([, a], [, b]) => ROLE_ORDER.indexOf(roleOf(a.type)) - ROLE_ORDER.indexOf(roleOf(b.type)),
    );
    const types = ordered.map(([, n]) => n.type);
    this.draw(types, graph.id);
  }

  /** Show a synthetic chain (used for cold-open before any prompt). */
  showChain(types: NodeType[], label?: string): void {
    this.draw(types, label ?? "cold-open");
  }

  /** Toggle the "signal flowing" edge animation. Call true when real
   *  audio is connected; false when synthetic / silent. */
  setLive(live: boolean): void {
    if (live) this.host.setAttribute("data-live", "");
    else this.host.removeAttribute("data-live");
  }

  clear(): void {
    this.chain.innerHTML = "";
    this.idEl.textContent = "—";
    this.host.setAttribute("data-empty", "");
  }

  private draw(types: NodeType[], id: string): void {
    if (types.length === 0) {
      this.clear();
      return;
    }
    this.host.removeAttribute("data-empty");
    this.idEl.textContent = id.length > 14 ? id.slice(0, 13) + "…" : id;
    this.chain.innerHTML = "";
    for (let i = 0; i < types.length; i++) {
      if (i > 0) this.chain.appendChild(this.makeEdge());
      this.chain.appendChild(this.makeNode(types[i]));
    }
  }

  private makeNode(type: NodeType): HTMLElement {
    const el = document.createElement("span");
    el.className = "state-graph__node";
    const role = roleOf(type);
    el.setAttribute("data-role", role);
    if (role === "lf") el.setAttribute("data-active", "");

    const dot = document.createElement("span");
    dot.className = "state-graph__dot";
    el.appendChild(dot);

    const glyph = GLYPHS[type];
    if (glyph) {
      const g = document.createElement("span");
      g.className = "state-graph__glyph";
      g.textContent = glyph;
      el.appendChild(g);
    }

    const label = document.createElement("span");
    label.className = "state-graph__label";
    label.textContent = LABELS[type] ?? type;
    el.appendChild(label);

    return el;
  }

  private makeEdge(): HTMLElement {
    const el = document.createElement("span");
    el.className = "state-graph__edge";
    return el;
  }
}
