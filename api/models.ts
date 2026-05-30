// Debug endpoint — lists which Gemini models the configured GEMINI_API_KEY
// actually has access to. Useful for diagnosing 404 NOT_FOUND on specific
// model names (some keys only see a subset). Removed in production once
// the model situation is settled.
//
//   GET /api/models   → { models: ["models/gemini-2.5-pro", ...] }

export const config = { runtime: "edge" };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
    `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}&pageSize=200`,
  ];
  const out: Record<string, unknown> = {};
  for (const url of urls) {
    const tag = url.includes("/v1beta/") ? "v1beta" : "v1";
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) {
        out[tag] = { error: body };
        continue;
      }
      const models = (body as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }).models;
      out[tag] = (models ?? [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => m.name);
    } catch (err) {
      out[tag] = { error: (err as Error).message };
    }
  }
  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
