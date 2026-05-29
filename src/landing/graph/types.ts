// prism.graph/0.1 — node-graph schema for visualizations.
//
// Every Prism visualization is a JSON document of this shape. Nodes fall
// into five role-tagged categories that mirror the fundamental abstraction:
//
//   signal source → signal xform → light field generator → lf operator → sink
//
// In English: Prism computes light fields from signals.
//
// M1 only exercises the minimal graph (audio → milkdrop → display); the
// schema is intentionally roomy so M8/M9 can add more generators and
// compositor ops without rewriting it.

export const SCHEMA_VERSION = "prism.graph/0.1" as const;

export type NodeRole = "signal" | "xform" | "lf" | "op" | "sink";

export type NodeType =
  // signal sources — produce a streaming signal
  | "signal.audio"
  | "signal.cursor"
  | "signal.heartbeat"
  | "signal.synth"
  // signal transformers — signal → signal
  | "xform.gain"
  | "xform.beat"
  // light field generators — produce a frame from signals
  | "lf.milkdrop"
  | "lf.shadertoy"
  | "lf.isf"
  // light field operators — frame(s) → frame
  | "op.blend"
  | "op.displace"
  | "op.feedback"
  // sinks — terminate the graph
  | "sink.display"
  | "sink.recorder";

export type NodeParam =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Record<string, string | number | boolean>;

/** A single node in the graph. Inputs reference upstream node outputs by
 *  the string "<node_id>.<output_name>". The runtime resolves these. */
export interface NodeDef {
  type: NodeType;
  params?: Record<string, NodeParam>;
  inputs?: Record<string, string>;
}

export interface PrismGraph {
  schema: typeof SCHEMA_VERSION;
  /** Stable id — enables share-by-URL in M6. */
  id: string;
  /** Human-readable summary of what the graph does. Shown in the SKILL
   *  readout; lets the AI explain its choice. */
  intent: string;
  nodes: Record<string, NodeDef>;
  /** Node id of the terminal sink. */
  output: string;
}

/** Extract the role prefix from a node type. */
export function roleOf(type: NodeType): NodeRole {
  return type.split(".")[0] as NodeRole;
}

/** Iterate nodes of a given role. */
export function nodesByRole(graph: PrismGraph, role: NodeRole): Array<[string, NodeDef]> {
  return Object.entries(graph.nodes).filter(([, n]) => roleOf(n.type) === role);
}

/** Build the M1 minimal graph: audio_in → lf.milkdrop(preset) → sink.display. */
export function makeMilkdropGraph(
  presetName: string,
  intent: string,
  blendSeconds = 2.5,
): PrismGraph {
  return {
    schema: SCHEMA_VERSION,
    id: `g_${Math.random().toString(36).slice(2, 10)}`,
    intent,
    nodes: {
      audio_in: { type: "signal.audio", params: {} },
      main: {
        type: "lf.milkdrop",
        params: { preset_name: presetName, blend_seconds: blendSeconds },
        inputs: { audio: "audio_in.signal" },
      },
      out: { type: "sink.display", inputs: { frame: "main.frame" } },
    },
    output: "out",
  };
}
