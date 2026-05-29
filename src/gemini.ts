// Direct REST API call to Gemini — bypasses the @google/genai SDK so we can
// see exactly what's happening over the wire.

const API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? "";
// Tried in order; first one that returns 200 wins. Newer models are gated on
// some keys, so we fall back through the family.
const MODEL_CANDIDATES = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
];
let cachedModel: string | null = null;

export async function listAvailableModels(): Promise<string[]> {
  if (!API_KEY) throw new Error("VITE_GEMINI_API_KEY not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`,
  );
  if (!res.ok) throw new Error(`listModels HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => (m.name ?? "").replace(/^models\//, ""));
}

// Expose for ad-hoc debugging in browser console.
(globalThis as unknown as { listGeminiModels?: () => Promise<string[]> }).listGeminiModels = listAvailableModels;

const NASA_INSERT_SYSTEM = `
You modify butterchurn / Milkdrop visualizer presets. Your job: edit the
provided preset JSON to incorporate NASA imagery via the following texture
samplers that are already registered in the runtime:

  sampler_nasa_1, sampler_nasa_2, sampler_nasa_3, sampler_nasa_4

Each is a 256x256 image of a Webb/Hubble/APOD nebula or galaxy.

Rules:
1. Output ONLY the modified JSON. No markdown fences, no commentary, no prose.
2. Preserve the preset's structure: baseVals, shapes, waves, init_eqs_str,
   frame_eqs_str, pixel_eqs_str, warp, comp.
3. Modify the warp and comp shader strings to blend or selectively replace
   texture(sampler_main, ...) calls with samples from the NASA samplers.
4. Use the existing q23 variable (0..15, increments on detected beats) to
   cycle through the four NASA samplers — typically via mod(q23, 4.0) and
   step() weights. Each beat advances to the next nebula.
5. Keep the preset's aesthetic: BLEND with mix() at ~0.35-0.6 amounts, do
   not fully replace sampler_main. The original feedback and warp dynamics
   must stay legible.
6. Newlines and tabs inside shader string values MUST be JSON-escaped as
   \\n and \\t. The resulting text must round-trip through JSON.parse.
7. If the preset has no warp or comp shader (some presets omit them), add
   minimal valid GLSL shader_body strings that show one of the NASA images
   warped by the feedback buffer.
8. Do not invent new uniform names. Use only: uv, uv_orig, time, aspect,
   sampler_main, sampler_blur1, sampler_pw_noise_lq, sampler_nasa_1..4,
   q1..q32, scale1, bias1, slow_roam_cos, roam_cos, rand_frame.
`.trim();

export async function aiInsertNasa(presetJson: string, signal?: AbortSignal): Promise<string> {
  if (!API_KEY) {
    throw new Error("VITE_GEMINI_API_KEY not set — restart the dev server after editing .env");
  }

  // Manual timeout via AbortController so the UI never hangs forever.
  const timeoutCtl = new AbortController();
  const timeoutMs = 45_000;
  const timer = setTimeout(() => timeoutCtl.abort(new Error("Gemini timeout")), timeoutMs);
  const externalAbort = () => timeoutCtl.abort(new Error("aborted"));
  signal?.addEventListener("abort", externalAbort);

  const tryModel = async (model: string): Promise<{ ok: true; text: string } | { ok: false; status: number; body: string }> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: presetJson }] }],
      systemInstruction: { parts: [{ text: NASA_INSERT_SYSTEM }] },
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 16384,
      },
    };
    console.log(`[gemini] POST ${model} (preset ${presetJson.length} chars)`);
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutCtl.signal,
    });
    const text = await res.text();
    console.log(`[gemini] ${model} HTTP ${res.status} in ${Math.round(performance.now() - t0)}ms`);
    if (!res.ok) return { ok: false, status: res.status, body: text };
    const data = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    const candidate = data.candidates?.[0];
    const out = candidate?.content?.parts?.[0]?.text;
    if (!out) {
      const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? "unknown";
      return { ok: false, status: 200, body: `empty output (${reason})` };
    }
    return { ok: true, text: out };
  };

  try {
    // If we already discovered a working model, use it directly.
    const order = cachedModel ? [cachedModel, ...MODEL_CANDIDATES.filter((m) => m !== cachedModel)] : MODEL_CANDIDATES;
    let lastFailure = "";
    for (const model of order) {
      const result = await tryModel(model);
      if (result.ok) {
        cachedModel = model;
        return result.text;
      }
      lastFailure = `${model} → ${result.status}: ${result.body.slice(0, 150)}`;
      // Only fall back on 404 (model not available); other errors abort.
      if (result.status !== 404) {
        throw new Error(lastFailure);
      }
    }
    throw new Error(`No working model. Last: ${lastFailure}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", externalAbort);
  }
}
