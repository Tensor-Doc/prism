// runtime.ts — graph executor for prism.graph/0.1.
//
// M1 scope: walk the graph, find the single lf.milkdrop node, and load its
// preset on the milkdrop background. The shape is intentionally
// future-proof — iterate by role, dispatch per role — so M8/M9 can add
// more generator types and a real compositor without rewriting.

import type { MilkdropBg } from "../milkdrop-bg";
import { nodesByRole, type PrismGraph } from "./types";

export interface RuntimeContext {
  milkdrop: MilkdropBg;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** Display name of the preset that was loaded, if any. */
  presetName?: string;
}

export class GraphRuntime {
  private active: PrismGraph | null = null;

  constructor(private readonly ctx: RuntimeContext) {}

  /** Execute a graph. M1 only honours the first lf.milkdrop node. */
  apply(graph: PrismGraph, blendSecondsOverride?: number): ApplyResult {
    const lfNodes = nodesByRole(graph, "lf");
    if (lfNodes.length === 0) {
      return { ok: false, error: "graph has no light-field generator" };
    }
    const milkdropNode = lfNodes.find(([, n]) => n.type === "lf.milkdrop");
    if (!milkdropNode) {
      return {
        ok: false,
        error: `unsupported lf type: ${lfNodes[0][1].type} (M1 only handles lf.milkdrop)`,
      };
    }
    const [, node] = milkdropNode;
    const presetName = node.params?.preset_name;
    if (typeof presetName !== "string") {
      return { ok: false, error: "lf.milkdrop missing preset_name" };
    }
    const blendSeconds =
      blendSecondsOverride ??
      (typeof node.params?.blend_seconds === "number" ? node.params.blend_seconds : 2.5);

    const loaded = this.ctx.milkdrop.loadByName(presetName, blendSeconds);
    if (loaded === null) {
      return { ok: false, error: `preset not found: ${presetName}` };
    }
    this.active = graph;
    return { ok: true, presetName: loaded };
  }

  /** The graph currently executing, if any. */
  get current(): PrismGraph | null {
    return this.active;
  }
}
