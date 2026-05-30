// runtime.ts — graph executor for prism.graph/0.1.
//
// Walks a PrismGraph, finds the light-field generator node, dispatches
// to the appropriate backend (milkdrop / shadertoy / ...). Future M9
// will add op.* nodes (blend / displace) and a real compositor; today
// it's single-backend-at-a-time and swaps as needed.
//
// The runtime owns visibility of the two background canvases — only the
// active backend's canvas is shown, the other is hidden. URL-loaded
// presets (favorites + shadertoys) load asynchronously; runtime.apply
// returns synchronously after kicking off the load and updating state.

import type { MilkdropBg } from "../milkdrop-bg";
import type { ShadertoyBg } from "../shadertoy-bg";
import { nodesByRole, type PrismGraph } from "./types";

export interface RuntimeContext {
  milkdrop: MilkdropBg;
  shadertoy: ShadertoyBg;
  /** Called to toggle which backend's canvas is visible.
   *  Implementations set CSS opacity/display on the two canvases. */
  setActiveBackend: (which: "milkdrop" | "shadertoy") => void;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** Display name of the preset that was loaded, if any. */
  presetName?: string;
  /** Which backend handled this graph. */
  backend?: "milkdrop" | "shadertoy";
}

export class GraphRuntime {
  private active: PrismGraph | null = null;

  constructor(private readonly ctx: RuntimeContext) {}

  apply(graph: PrismGraph, blendSecondsOverride?: number): ApplyResult {
    const lfNodes = nodesByRole(graph, "lf");
    if (lfNodes.length === 0) {
      return { ok: false, error: "graph has no light-field generator" };
    }
    const [, node] = lfNodes[0];

    if (node.type === "lf.milkdrop") {
      const presetName = node.params?.preset_name;
      const presetUrl = node.params?.preset_url;
      const blendSeconds =
        blendSecondsOverride ??
        (typeof node.params?.blend_seconds === "number" ? node.params.blend_seconds : 2.5);
      this.ctx.setActiveBackend("milkdrop");
      // URL takes precedence (favorites). Fall back to name (npm bundle / legacy).
      if (typeof presetUrl === "string") {
        void this.ctx.milkdrop.loadFromUrl(presetUrl, blendSeconds).catch((err: Error) => {
          console.warn("[runtime] milkdrop loadFromUrl failed:", err.message);
        });
        this.active = graph;
        const name = presetUrl.split("/").pop()?.replace(/\.milk$/, "") ?? presetUrl;
        return { ok: true, presetName: name, backend: "milkdrop" };
      }
      if (typeof presetName !== "string") {
        return { ok: false, error: "lf.milkdrop missing preset_name or preset_url" };
      }
      const loaded = this.ctx.milkdrop.loadByName(presetName, blendSeconds);
      if (loaded === null) {
        return { ok: false, error: `preset not found: ${presetName}` };
      }
      this.active = graph;
      return { ok: true, presetName: loaded, backend: "milkdrop" };
    }

    if (node.type === "lf.shadertoy") {
      const url = node.params?.shader_url;
      if (typeof url !== "string") {
        return { ok: false, error: "lf.shadertoy missing shader_url" };
      }
      const imageUrl = node.params?.image_url;
      this.ctx.setActiveBackend("shadertoy");
      void this.ctx.shadertoy.loadFromUrl(url).catch((err: Error) => {
        console.warn("[runtime] shadertoy loadFromUrl failed:", err.message);
      });
      // Bind the entry's default image to iChannel1 if specified. The
      // shader has a 1x1 grey placeholder until this resolves.
      void this.ctx.shadertoy.bindImage(typeof imageUrl === "string" ? imageUrl : null)
        .catch((err: Error) => {
          console.warn("[runtime] shadertoy bindImage failed:", err.message);
        });
      this.active = graph;
      const name = url.split("/").pop()?.replace(/\.glsl$/, "") ?? url;
      return { ok: true, presetName: name, backend: "shadertoy" };
    }

    return { ok: false, error: `unsupported lf type: ${node.type}` };
  }

  get current(): PrismGraph | null {
    return this.active;
  }
}
