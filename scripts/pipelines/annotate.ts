// annotate.ts — given a captured video file, ask Gemini to describe it
// in a structured schema. Source-agnostic: works for any visualization
// video regardless of how it was produced (milkdrop, shadertoy, ISF, …).

import { GoogleGenAI, Type } from "@google/genai";
import { promises as fs } from "node:fs";
import type { Annotation } from "./types";

const MODEL = "gemini-2.5-pro";

/** Schema describing the JSON shape Gemini must return. Locks each field. */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["vibe", "motion", "palette_anchor", "audio_affinity", "blurb"],
  properties: {
    vibe: {
      type: Type.ARRAY,
      description: "1-4 short evocative tags describing the look (e.g. 'fluid', 'cosmic', 'aggressive').",
      items: { type: Type.STRING },
    },
    motion: {
      type: Type.NUMBER,
      description: "Motion intensity 0..1. 0 = nearly static, 1 = chaotic / explosive.",
    },
    palette_anchor: {
      type: Type.ARRAY,
      description: "2-4 dominant colors as hex codes (e.g. '#3a8aff').",
      items: { type: Type.STRING },
    },
    audio_affinity: {
      type: Type.OBJECT,
      required: ["bass", "mid", "treble"],
      properties: {
        bass: { type: Type.NUMBER },
        mid: { type: Type.NUMBER },
        treble: { type: Type.NUMBER },
      },
    },
    blurb: {
      type: Type.STRING,
      description: "Single concise sentence describing the visualization.",
    },
    brand_safe: {
      type: Type.BOOLEAN,
      description: "False if the look is dominated by purple/violet (Prism's no-purple brand rule).",
    },
  },
} as const;

function buildPrompt(ctx: { sourceType: string; presetId: string; author?: string }): string {
  return [
    `You are analyzing a short ${ctx.sourceType} visualization to populate a catalog.`,
    `Preset: "${ctx.presetId}"${ctx.author ? ` by ${ctx.author}` : ""}.`,
    ``,
    `Watch the video carefully. Output JSON describing:`,
    `- vibe: 1-4 short, evocative tags (no fluff words)`,
    `- motion: how much it moves, 0 (static) to 1 (chaotic)`,
    `- palette_anchor: 2-4 actual hex colors dominating the frame`,
    `- audio_affinity: which frequency bands the visualization most strongly reacts to`,
    `- blurb: one sentence a stranger would understand`,
    `- brand_safe: false if the look leans heavily purple/violet, true otherwise`,
    ``,
    `Be specific. Avoid generic terms like "beautiful" or "cool".`,
  ].join("\n");
}

export async function annotateVideo(
  videoPath: string,
  ctx: { sourceType: string; presetId: string; author?: string },
  opts: { apiKey?: string } = {},
): Promise<Annotation> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("annotate: GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey });

  // Upload the video to Gemini's File API. Required for >20MB files; using
  // it consistently regardless of size keeps the path uniform.
  const fileBuffer = await fs.readFile(videoPath);
  const blob = new Blob([fileBuffer], { type: "video/webm" });
  const uploaded = await ai.files.upload({
    file: blob,
    config: { mimeType: "video/webm" },
  });
  if (!uploaded.uri) throw new Error("annotate: upload returned no URI");

  // Wait for processing (videos take a moment to be indexed).
  let file = uploaded;
  for (let i = 0; i < 60; i++) {
    if (file.state === "ACTIVE") break;
    if (file.state === "FAILED") throw new Error("annotate: file upload failed");
    await new Promise((r) => setTimeout(r, 1000));
    file = await ai.files.get({ name: uploaded.name ?? "" });
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: "video/webm" } },
          { text: buildPrompt(ctx) },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = result.text;
  if (!text) throw new Error("annotate: empty response from model");
  return JSON.parse(text) as Annotation;
}
