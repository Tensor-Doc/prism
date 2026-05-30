// validate-cold-open — sanity check that every preset in the
// landing's COLD_OPEN_POOL actually exists in the butterchurn-presets
// bundle. Run before pushing a change to the pool. Cheap (millis).
//
// Why: the cold-open is the first thing a visitor sees. A typo or a
// deleted preset would silently fall through to butterchurn's random
// pick. This script catches that in CI before it lands.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error — package has no types
import butterchurnPresetsRaw from "butterchurn-presets";

export async function runValidateColdOpen(repoRoot: string): Promise<void> {
  const mainPath = join(repoRoot, "src/landing/main.ts");
  const source = readFileSync(mainPath, "utf-8");
  const m = source.match(/const COLD_OPEN_POOL = \[([\s\S]*?)\];/);
  if (!m) {
    throw new Error("could not find COLD_OPEN_POOL in src/landing/main.ts");
  }
  const names = Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
  if (names.length === 0) {
    throw new Error("COLD_OPEN_POOL is empty");
  }

  const bundle = (butterchurnPresetsRaw as { getPresets?: () => Record<string, unknown> });
  const presets = typeof bundle.getPresets === "function"
    ? bundle.getPresets()
    : (butterchurnPresetsRaw as Record<string, unknown>);
  const available = new Set(Object.keys(presets));

  console.log(`[validate-cold-open] ${names.length} entries, ${available.size} presets in bundle`);

  const missing: string[] = [];
  for (const name of names) {
    if (!available.has(name)) missing.push(name);
  }
  if (missing.length === 0) {
    console.log(`[validate-cold-open] OK — every cold-open name resolves`);
    return;
  }
  console.error(`[validate-cold-open] ${missing.length} missing:`);
  for (const name of missing) console.error(`  ✗ "${name}"`);
  process.exit(1);
}
