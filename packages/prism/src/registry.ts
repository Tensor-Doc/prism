// registry.ts — share-token lookup for catalog content.
//
// Every catalog entry on prism.scott.ai has a 6-char base62 token (the
// short_id). Consumers pass one to `player.load(...)` or via the URL
// param `?g=<short_id>` and the player resolves it to a PrismGraph
// offline — no network call. The map is generated from the catalog at
// build-index time; see scripts/prism/commands/build-index.ts.

import registryData from "./registry.generated.json";
import { SCHEMA_VERSION, type NodeDef, type NodeType, type PrismGraph } from "./types";

export interface RegistryEntry {
  name: string;
  source_type: "milkdrop" | "shadertoy" | "isf" | "wgsl";
  source_loader: "url" | "npm-butterchurn-presets";
  source_url?: string;
  source_ref?: string;
  default_image?: string;
}

const registry = registryData as Record<string, RegistryEntry>;

/** Resolve a 6-char short_id to a registry entry. Returns null when
 *  the id isn't known — callers decide whether to fall back, error,
 *  or just keep the synthetic cold-open running. */
export function lookup(shortId: string): RegistryEntry | null {
  return registry[shortId] ?? null;
}

/** All known short_ids. Mostly useful for tests + the rotation pool. */
export function shortIds(): string[] {
  return Object.keys(registry);
}

/** Build a minimal PrismGraph that plays the entry behind `shortId`.
 *  Returns null when the id isn't in the registry. */
export function shortIdToGraph(shortId: string): PrismGraph | null {
  const entry = lookup(shortId);
  if (!entry) return null;
  return entryToGraph(shortId, entry);
}

function entryToGraph(shortId: string, entry: RegistryEntry): PrismGraph {
  const mainParams: Record<string, string> = {};
  let mainType: NodeType;
  if (entry.source_type === "shadertoy") {
    mainType = "lf.shadertoy";
    if (entry.source_url) mainParams.shader_url = entry.source_url;
    if (entry.default_image) mainParams.image_url = entry.default_image;
  } else {
    mainType = "lf.milkdrop";
    if (entry.source_loader === "url" && entry.source_url) {
      mainParams.preset_url = entry.source_url;
    } else if (entry.source_ref) {
      mainParams.preset_name = entry.source_ref;
    }
  }
  const nodes: Record<string, NodeDef> = {
    audio: { type: "signal.audio" },
    main: { type: mainType, params: mainParams, inputs: { audio: "audio.signal" } },
    screen: { type: "sink.display", inputs: { frame: "main.frame" } },
  };
  return {
    schema: SCHEMA_VERSION,
    id: `g:${shortId}`,
    intent: entry.name,
    nodes,
    output: "screen",
  };
}
