// Slugify a preset/shader filename into a stable URL-safe id.
//
// Examples:
//   "_____________Geiss - Myriad Spirals - cruise mix.milk"
//     → "geiss-myriad-spirals-cruise-mix"
//   "$$$ Royal - Mashup (197).milk"
//     → "royal-mashup-197"
//   "martin [shadow harlequins shape code] - fata morgana.milk"
//     → "martin-shadow-harlequins-shape-code-fata-morgana"
//
// Rules:
//   1. Strip the file extension (.milk, .glsl, .fs, etc.)
//   2. Strip Geiss's leading "_" sort-priority padding
//   3. Strip leading "$" / digit-only / punctuation prefixes
//   4. Lowercase
//   5. Replace anything not [a-z0-9] with a hyphen
//   6. Collapse multiple hyphens
//   7. Trim leading/trailing hyphens
//   8. Truncate at MAX_LEN preserving word boundaries when possible

const MAX_LEN = 80;

export function slugify(name: string): string {
  // Drop extension (last dot-segment).
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;

  const replaced = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (replaced.length <= MAX_LEN) return replaced;

  // Truncate at the last hyphen before MAX_LEN to keep word boundaries.
  const head = replaced.slice(0, MAX_LEN);
  const lastDash = head.lastIndexOf("-");
  return (lastDash > 40 ? head.slice(0, lastDash) : head).replace(/-+$/, "");
}

/** Compose a fully-qualified id from a source family + slug. */
export function entryId(sourceType: string, slug: string): string {
  return `${sourceType}:${slug}`;
}

/** Disambiguate a slug against existing ids by appending -2, -3, ... */
export function disambiguate(slug: string, existing: ReadonlySet<string>): string {
  if (!existing.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`unable to disambiguate slug after 999 tries: ${slug}`);
}
