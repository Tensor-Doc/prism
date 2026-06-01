// recover-gap — find every entry that's annotated but not gallery-
// visible (renders:false OR missing https video URL), re-run annotate
// on each so the texture-pack fix and any subsequent backend changes
// have a chance to recover them. Resilient to Gemini 503s — retries
// each slug once after a 60s backoff before giving up.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CatalogEntry } from "../entry-types";
import { runAnnotateOne } from "./annotate";

const GEMINI_503_RETRY_MS = 60_000;

interface Bucket {
  slug: string;
  prefix: string;
  reason: string;
}

function listGap(repoRoot: string): Bucket[] {
  const dir = join(repoRoot, "catalog/entries");
  const out: Bucket[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const e = JSON.parse(readFileSync(join(dir, f), "utf-8")) as CatalogEntry;
    if (!e.annotation) continue;
    const rf = e.compatibility?.renders === false;
    const noVid = !e.assets.video || !e.assets.video.startsWith("https://");
    if (!rf && !noVid) continue;
    const [prefix, ...rest] = f.replace(/\.json$/, "").split("_");
    const slug = rest.join("_");
    const reason = rf && noVid ? "both" : rf ? "renders:false" : "no-video";
    out.push({ slug, prefix, reason });
  }
  return out;
}

export async function runRecoverGap(
  repoRoot: string,
  opts: { limit?: number } = {},
): Promise<void> {
  const all = listGap(repoRoot);
  const target = opts.limit ? all.slice(0, opts.limit) : all;
  console.log(`[recover-gap] ${target.length} of ${all.length} gap entries queued`);
  let pass = 0, fail = 0;
  for (let i = 0; i < target.length; i++) {
    const { slug, prefix, reason } = target[i];
    const qualified = `${prefix}:${slug}`;
    console.log(`\n[recover-gap] ${i + 1}/${target.length} (${reason}) ${qualified}`);
    try {
      await runAnnotateOne(repoRoot, qualified, { reuseVideo: false });
      pass++;
    } catch (err) {
      const msg = (err as Error).message;
      // One free retry on Gemini overload — those clear quickly. Other
      // errors (compile failures, GPU timeouts, etc.) we accept as
      // genuine and move on.
      if (/503|UNAVAILABLE|overloaded|high demand/i.test(msg)) {
        console.log(`  Gemini overload — backing off ${GEMINI_503_RETRY_MS / 1000}s and retrying once`);
        await new Promise((r) => setTimeout(r, GEMINI_503_RETRY_MS));
        try {
          await runAnnotateOne(repoRoot, qualified, { reuseVideo: true });
          pass++;
          continue;
        } catch (err2) {
          console.log(`  retry failed: ${(err2 as Error).message}`);
        }
      }
      console.log(`  FAIL: ${msg}`);
      fail++;
    }
  }
  console.log(`\n[recover-gap] done. pass=${pass} fail=${fail} of ${target.length}`);
}
