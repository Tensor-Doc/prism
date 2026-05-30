// Vercel Edge function: prompt → PrismGraph.
//
//   POST /api/generate
//   body: { prompt: string, currentGraph?: PrismGraph }
//   200:  { graph: PrismGraph }
//   4xx:  { error: string }
//
// Calls Gemini with the seed catalog as part of the system instruction.
// Gemini picks a preset_id from the catalog + writes a one-sentence intent
// describing what the user will see. We wrap that into a PrismGraph
// server-side, which keeps the AI's job tiny (and the schema unbreakable)
// while letting us evolve the graph shape independently of the AI prompt.

import { GoogleGenAI, Type } from "@google/genai";

import catalogJson from "../catalog/catalog.json";

// NOTE: Vercel's edge-function bundler is finicky about cross-folder TS
// imports. We duplicate the SCHEMA_VERSION constant + a minimal PrismGraph
// type here rather than importing from ../src/landing/graph/types. The
// canonical schema definition lives in that file; keep them in sync.
const SCHEMA_VERSION = "prism.graph/0.1" as const;

type NodeType = "signal.audio" | "lf.milkdrop" | "sink.display" | string;
interface NodeDef {
  type: NodeType;
  params?: Record<string, unknown>;
  inputs?: Record<string, string>;
}
interface PrismGraph {
  schema: typeof SCHEMA_VERSION;
  id: string;
  intent: string;
  nodes: Record<string, NodeDef>;
  output: string;
}

export const config = { runtime: "edge" };

interface CatalogEntry {
  id: string;
  source_type: string;
  preset_id: string;
  display_name: string;
  vibe: string[];
  motion: number;
  palette_anchor: string[];
  audio_affinity: { bass: number; mid: number; treble: number };
  blurb: string;
  brand_safe?: boolean;
}

const CATALOG = catalogJson as CatalogEntry[];

interface GenerateBody {
  prompt?: unknown;
  currentGraph?: unknown;
  metadata?: unknown;
}

interface SessionMetadata {
  time_of_day?: number;
  day_of_week?: string;
  session_ms?: number;
  viewport?: { w?: number; h?: number };
  prefers_reduced_motion?: boolean;
}

/** Hand-picked subset of the catalog matching the Refik-Anadol-distilled
 *  brand mood: painterly, atmospheric, fluid, contemplative, organic.
 *  The system prompt biases the router toward these unless the visitor's
 *  prompt explicitly asks for something else (chaotic, geometric, fractal). */
const REFIK_SUBSET = new Set<string>([
  "Geiss - Reaction Diffusion 2",
  "Geiss - Cauldron - painterly 2 (saturation remix)",
  "Flexi - alien fish pond",
  "martin - reflections on black tiles",
  "martin [shadow harlequins shape code] - fata morgana",
  "suksma - uninitialized variabowl (hydroponic chronic)",
  "Zylot - Paint Spill (Music Reactive Paint Mix)",
  "Aderrasi - Songflower (Moss Posy)",
  "flexi + amandio c - organic [random mashup]",
  "flexi + amandio c - organic12-3d-2.milk",
  "Eo.S. + Zylot - skylight (Stained Glass Majesty mix)",
  "flexi - mom, why the sky looks different today",
  "martin - frosty caves 2",
  "suksma - Rovastar - Sunflower Passion (Enlightment Mix)_Phat_edit + flexi und martin shaders - circumflex in character classes in regular expression",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "GEMINI_API_KEY not configured" });
  }

  let body: GenerateBody;
  try {
    body = (await req.json()) as GenerateBody;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return json(400, { error: "missing prompt" });
  }

  const currentGraph = isPrismGraph(body.currentGraph) ? body.currentGraph : null;
  const metadata = isSessionMetadata(body.metadata) ? body.metadata : null;
  // @google/genai 2.7.0 (latest as of writing) targets v1beta — that's
  // also the only endpoint that supports systemInstruction +
  // responseSchema, which we rely on. v1 returns 400 for those fields.
  const ai = new GoogleGenAI({ apiKey });

  let pick: { preset_id: string; intent: string };
  try {
    pick = await pickPresetWithGemini(ai, prompt, currentGraph, metadata);
  } catch (err) {
    return json(502, { error: `gemini call failed: ${(err as Error).message}` });
  }

  const matched = matchEntry(pick.preset_id);
  if (!matched) {
    return json(502, {
      error: `model picked unknown preset_id: ${pick.preset_id}`,
    });
  }

  const graph: PrismGraph = {
    schema: SCHEMA_VERSION,
    id: `g_${Math.random().toString(36).slice(2, 10)}`,
    intent: pick.intent,
    nodes: {
      audio_in: { type: "signal.audio", params: {} },
      main: {
        type: "lf.milkdrop",
        params: { preset_name: matched.preset_id, blend_seconds: 2.5 },
        inputs: { audio: "audio_in.signal" },
      },
      out: { type: "sink.display", inputs: { frame: "main.frame" } },
    },
    output: "out",
  };

  return json(200, { graph });
}

async function pickPresetWithGemini(
  ai: GoogleGenAI,
  prompt: string,
  currentGraph: PrismGraph | null,
  metadata: SessionMetadata | null,
): Promise<{ preset_id: string; intent: string }> {
  const systemInstruction = buildSystemInstruction(currentGraph, metadata);

  const userParts = [`Visitor prompt: "${prompt}"`];
  if (currentGraph) {
    const currentPreset = findCurrentPresetName(currentGraph);
    if (currentPreset) {
      userParts.push(
        `They are currently watching preset_id="${currentPreset}". ` +
          `If the prompt reads like a refinement (e.g. "more bass", "warmer", "calmer"), ` +
          `prefer a related preset that adjusts in the requested direction.`,
      );
    }
  }
  userParts.push(
    `Reply with JSON: { "preset_id": "<exact preset_id from the catalog>", ` +
      `"intent": "<one short sentence in Prism's voice describing what they'll see>" }`,
  );

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: userParts.join("\n\n"),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        required: ["preset_id", "intent"],
        properties: {
          preset_id: { type: Type.STRING },
          intent: { type: Type.STRING },
        },
      },
      temperature: 0.7,
    },
  });

  const text = response.text;
  if (!text) throw new Error("empty response from gemini");
  const parsed = JSON.parse(text) as { preset_id?: unknown; intent?: unknown };
  if (typeof parsed.preset_id !== "string" || typeof parsed.intent !== "string") {
    throw new Error("malformed gemini response");
  }
  return { preset_id: parsed.preset_id, intent: parsed.intent };
}

function buildSystemInstruction(
  currentGraph: PrismGraph | null,
  metadata: SessionMetadata | null,
): string {
  const catalogTable = CATALOG.map((e) => {
    const aff = `bass:${e.audio_affinity.bass} mid:${e.audio_affinity.mid} treble:${e.audio_affinity.treble}`;
    const vibe = e.vibe.join(", ");
    const tag = REFIK_SUBSET.has(e.preset_id) ? " [refik]" : "";
    return `- preset_id="${e.preset_id}"${tag} | vibe=[${vibe}] | motion=${e.motion} | ${aff} | "${e.blurb}"`;
  }).join("\n");

  const sections: string[] = [
    "You are Prism's preset router.",
    "",
    "PRISM IS A VISUALIZATION ENGINE. It computes light fields from signals —",
    "an audio stream (or cursor / heartbeat) drives a real-time visual. You",
    "are choosing which preset to render given a natural-language prompt.",
    "",
    "BRAND MOOD (REFIK-ANADOL-DISTILLED):",
    "Prism's default aesthetic is painterly, atmospheric, fluid, organic,",
    "contemplative — closer to a Refik Anadol installation than a 90s rave.",
    "Presets tagged [refik] above are the curated mood. When the prompt is",
    "ambient / unspecified / matches the Refik mood, prefer a [refik] entry.",
    "When the prompt explicitly asks for chaos / fractals / geometric /",
    "psychedelic / beats / industrial, override and pick the best non-Refik",
    "match — don't force a [refik] entry on a chaos prompt.",
    "",
    "INTERPRETATION RULES:",
    "- 'motion' ranges 0..1. Low ≈ contemplative, calm, dreamy. High ≈ energetic, frenetic.",
    "- 'audio_affinity' tells you which frequency band the preset responds to most.",
    '- "dreamy" / "calming" / "ambient" → low motion + soft palettes ([refik] subset).',
    '- "fractal" / "mathematical" / "recursion" → fractal vibe.',
    '- "space" / "cosmic" / "Pink Floyd" / "Grateful Dead" / "psychedelic" → cosmic or psychedelic vibe.',
    '- "liquid" / "fluid" / "paint" / "ink" → fluid vibe; if "responsive" or "reactive" prefer higher audio_affinity.',
    '- "moving shapes" / "geometric" / "with beats" → geometric vibe with high bass affinity.',
    '- "plants" / "growing" / "garden" / "organic" → botanical or organic [refik] entries.',
    '- "landscape" / "sky" / "weather" / "sea" / "cave" → atmospheric [refik] entries.',
    '- "orb" / "sphere" / "balloon" → sphere vibe.',
    "",
  ];

  if (metadata) {
    const tod = typeof metadata.time_of_day === "number" ? metadata.time_of_day : null;
    const hint =
      tod === null
        ? ""
        : tod < 0.25 || tod > 0.83
          ? "It's currently late-night / pre-dawn for the visitor — favor contemplative, low-motion, dim entries on ambient prompts."
          : tod < 0.5
            ? "It's morning for the visitor — favor luminous, growing, fresh entries on ambient prompts."
            : tod < 0.75
              ? "It's afternoon for the visitor — neutral bias."
              : "It's evening for the visitor — favor warm, painterly, atmospheric entries on ambient prompts.";
    sections.push("SESSION METADATA:");
    sections.push(`time_of_day=${tod?.toFixed(2)} | day=${metadata.day_of_week}`);
    if (hint) sections.push(hint);
    sections.push("");
  }

  sections.push(
    currentGraph
      ? "REFINEMENT MODE: the visitor is iterating on what they're currently seeing. Prefer a related preset that shifts in the direction they asked for, not a wildly different one."
      : "FRESH MODE: pick the best match from the catalog.",
    "",
    "OUTPUT: return only JSON with two fields: preset_id (must be an exact",
    "string from the catalog below) and intent (one short sentence in lowercase",
    "Prism voice, e.g. \"calming cosmic fluid that breathes with bass.\").",
    "",
    "CATALOG:",
    catalogTable,
  );
  return sections.join("\n");
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (!value || typeof value !== "object") return false;
  return true; // tolerant — any object shape is fine, fields are optional
}

function matchEntry(presetId: string): CatalogEntry | null {
  const direct = CATALOG.find((e) => e.preset_id === presetId);
  if (direct) return direct;
  const fuzzy = CATALOG.find(
    (e) => e.preset_id.toLowerCase() === presetId.toLowerCase(),
  );
  return fuzzy ?? null;
}

function findCurrentPresetName(g: PrismGraph): string | null {
  for (const node of Object.values(g.nodes)) {
    if (node.type === "lf.milkdrop" && typeof node.params?.preset_name === "string") {
      return node.params.preset_name;
    }
  }
  return null;
}

function isPrismGraph(value: unknown): value is PrismGraph {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  return (
    g.schema === SCHEMA_VERSION &&
    typeof g.id === "string" &&
    typeof g.intent === "string" &&
    typeof g.nodes === "object" &&
    g.nodes !== null &&
    typeof g.output === "string"
  );
}
