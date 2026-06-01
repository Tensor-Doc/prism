// build-textures — scan public/textures/ and emit a manifest mapping
// each preset-referenceable texture name (e.g. "worms") to its file on
// disk (e.g. "worms.jpg"). The milkdrop backend fetches this manifest
// on cold-open and feeds every entry into butterchurn's
// loadExtraImages() so .milk presets can sample them.
//
// Without this, butterchurn knows only its own 6 bundled textures
// (cells, lichen, mage, prayerwheel, seaweed, smalltiled_lizard_scales)
// and every preset that references anything else renders black.

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEXTURE_EXTS = /\.(jpg|jpeg|png|gif)$/i;

/** Normalize a filename to the key .milk presets reference.
 *  Strips the extension, lowercases, replaces spaces with underscores,
 *  trims trailing underscores some catalog filenames carry. */
function normalizeName(filename: string): string {
  return filename
    .replace(TEXTURE_EXTS, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/_+$/, "");
}

/** Aliases for textures that .milk presets reference under
 *  Flexi/Fryer-namespaced names (fc_*, fw_*) but that are visually the
 *  same as our base textures. Each maps `alias` → `canonical key`. */
const ALIASES: Record<string, string> = {
  fc_clouds: "clouds",
  fc_clouds2: "clouds2",
  fc_wrenches: "wrenches",
  fw_clouds: "clouds",
  fw_lichen: "lichen",
  fw_wrenches: "wrenches",
};

export function runBuildTextures(repoRoot: string): void {
  const dir = join(repoRoot, "public/textures");
  const files = readdirSync(dir).filter((f) => TEXTURE_EXTS.test(f)).sort();
  const manifest: Record<string, string> = {};
  for (const f of files) {
    const key = normalizeName(f);
    if (manifest[key]) {
      console.warn(`[build-textures] duplicate key "${key}" from ${f} (kept ${manifest[key]})`);
      continue;
    }
    manifest[key] = f;
  }
  // Apply aliases — these point at existing files under different keys.
  let aliasCount = 0;
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (manifest[alias]) continue;
    if (!manifest[target]) continue;
    manifest[alias] = manifest[target];
    aliasCount++;
  }
  const out = join(dir, "index.json");
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[build-textures] ${files.length} files → ${Object.keys(manifest).length} keys (${aliasCount} aliases) → public/textures/index.json`);
}
