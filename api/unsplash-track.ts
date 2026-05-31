// /api/unsplash-track — fire Unsplash's "download trigger" endpoint.
//
//   GET /api/unsplash-track?url=<download_location>
//
// Unsplash TOS requires us to ping the photo's `download_location` URL
// whenever a user "uses" a photo. The frontend fires this when a photo
// is sampled into the slideshow. The endpoint itself only registers
// usage; the response body is irrelevant.
//
// Gated by the UNSPLASH_TRACK_ENABLED env var. Defaults to OFF in dev
// so we don't pollute analytics with refresh / iteration traffic. Set
// UNSPLASH_TRACK_ENABLED=true (or "1") in production for compliance.

export const config = { runtime: "edge" };

function isEnabled(): boolean {
  const v = (process.env.UNSPLASH_TRACK_ENABLED ?? "").toLowerCase().trim();
  return v === "true" || v === "1";
}

export default async function handler(req: Request): Promise<Response> {
  if (!isEnabled()) {
    // Quiet no-op so the frontend can always fire-and-forget.
    return new Response(null, { status: 204 });
  }

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: "UNSPLASH_ACCESS_KEY not configured" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return new Response(JSON.stringify({ error: "missing ?url parameter" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  // The download_location URLs are always under api.unsplash.com — guard
  // against being used as a generic proxy.
  if (!target.startsWith("https://api.unsplash.com/")) {
    return new Response(JSON.stringify({ error: "url must be on api.unsplash.com" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const resp = await fetch(target, {
    headers: {
      Authorization: `Client-ID ${key}`,
      "Accept-Version": "v1",
    },
  });
  // Always 204 to the client regardless of the upstream — the response
  // body isn't useful and we don't want to expose Unsplash error shapes.
  return new Response(null, { status: 204, headers: { "X-Track-Status": String(resp.status) } });
}
