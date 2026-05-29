// Vercel Edge function: image proxy with CORS headers.
//
//   GET /api/image-proxy?url=<encoded upstream URL>
//
// Fetches the upstream image and re-serves it with permissive CORS headers
// so the browser can use it as a WebGL/Canvas2D texture. Restricted to an
// allowlist of NASA / astronomy image hosts so the proxy can't be abused
// as an open relay.
//
// Cached at the Vercel edge for 7 days; in the browser for 1 day.

export const config = { runtime: "edge" };

const ALLOWED_HOSTS = new Set<string>([
  "images-assets.nasa.gov",
  "apod.nasa.gov",
  "www.nasa.gov",
  "images.nasa.gov",
  "stsci-opo.org",
  "cdn.esahubble.org",
  "esahubble.org",
  "cdn.esawebb.org",
  "esawebb.org",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    return new Response("missing ?url parameter", { status: 400, headers: corsHeaders });
  }

  let upstream: URL;
  try {
    upstream = new URL(target);
  } catch {
    return new Response("invalid url", { status: 400, headers: corsHeaders });
  }
  if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
    return new Response("unsupported protocol", { status: 400, headers: corsHeaders });
  }
  if (!ALLOWED_HOSTS.has(upstream.hostname)) {
    return new Response(`host not allowed: ${upstream.hostname}`, {
      status: 403,
      headers: corsHeaders,
    });
  }

  try {
    const upstreamRes = await fetch(upstream.toString(), {
      headers: { "User-Agent": "prism-image-proxy/1.0 (+https://prism-ten-mu.vercel.app)" },
      // Vercel edge runtime — fetch is global Web API
    });

    if (!upstreamRes.ok) {
      return new Response(`upstream ${upstreamRes.status} ${upstreamRes.statusText}`, {
        status: upstreamRes.status,
        headers: corsHeaders,
      });
    }

    const contentType = upstreamRes.headers.get("Content-Type") ?? "image/jpeg";
    // Refuse anything that's not an image — defense in depth.
    if (!contentType.startsWith("image/")) {
      return new Response("upstream did not return an image", {
        status: 502,
        headers: corsHeaders,
      });
    }

    return new Response(upstreamRes.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        // Browser caches for 1 day, Vercel CDN for 7 days (immutable images).
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      },
    });
  } catch (err) {
    return new Response(`proxy fetch failed: ${(err as Error).message}`, {
      status: 502,
      headers: corsHeaders,
    });
  }
}
