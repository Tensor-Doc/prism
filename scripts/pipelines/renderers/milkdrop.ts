// Milkdrop renderer — backed by the curated "Minimal" pack of butterchurn-
// presets (~29 hand-picked classics). Future renderers (Shadertoy, ISF)
// implement the same Renderer interface.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import butterchurnPresetsMinimal from "butterchurn-presets/lib/butterchurnPresetsMinimal.min.js";
import type { Renderer, PresetRef } from "../types";

/** Best-effort author extraction from a butterchurn preset name. Most
 *  names follow "<author> - <title>" or "<author> + <coauth> - <title>". */
function extractAuthor(presetName: string): string | undefined {
  const m = presetName.match(/^([^\-]+?)\s*-\s*/);
  if (!m) return undefined;
  const author = m[1].trim();
  // Skip names that are clearly mashup tags rather than authors.
  if (author.startsWith("$$$") || author === "_Mig_" || author === "Milk Artist At our Best") {
    return author.replace(/^_+|_+$/g, "");
  }
  return author;
}

export class MilkdropRenderer implements Renderer {
  readonly sourceType = "milkdrop" as const;
  private readonly baseUrl: string;

  constructor(baseUrl: string = process.env.PRISM_CAPTURE_BASE_URL ?? "http://localhost:5174") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async listPresets(): Promise<PresetRef[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = butterchurnPresetsMinimal as any;
    const lib = (mod && typeof mod === "object" && "default" in mod ? mod.default : mod) as {
      getPresets: () => Record<string, unknown>;
    };
    const map = lib.getPresets();
    return Object.keys(map).map((name) => ({
      id: name,
      displayName: name,
      author: extractAuthor(name),
    }));
  }

  getRenderUrl(presetId: string): string {
    return `${this.baseUrl}/scripts/pipelines/capture-pages/milkdrop.html?preset=${encodeURIComponent(presetId)}`;
  }
}
