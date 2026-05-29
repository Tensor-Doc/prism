// storage.ts — catalog upsert. The catalog is a single JSON file containing
// every annotated visualization across all source families. Atomic-write
// semantics: read full, modify in memory, write replace.
//
// Future-proofing: easy to swap the JSON-file backend for SQLite, Postgres,
// or a managed catalog store without touching callers. The CatalogEntry
// shape is the contract.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { CatalogEntry } from "./types";

export async function loadCatalog(catalogPath: string): Promise<CatalogEntry[]> {
  try {
    const raw = await fs.readFile(catalogPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`catalog at ${catalogPath} is not an array`);
    }
    return parsed as CatalogEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function upsertCatalogEntry(
  catalogPath: string,
  entry: CatalogEntry,
): Promise<{ inserted: boolean; replaced: CatalogEntry | null }> {
  await fs.mkdir(dirname(catalogPath), { recursive: true });
  const catalog = await loadCatalog(catalogPath);
  const idx = catalog.findIndex((e) => e.id === entry.id);
  let replaced: CatalogEntry | null = null;
  if (idx >= 0) {
    replaced = catalog[idx];
    catalog[idx] = entry;
  } else {
    catalog.push(entry);
  }
  // Stable sort: by source then id, so diffs read cleanly.
  catalog.sort((a, b) => {
    const t = a.source_type.localeCompare(b.source_type);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  return { inserted: idx < 0, replaced };
}

/** Synchronous existence check — useful for skip-if-present in batch runs. */
export async function entryExists(
  catalogPath: string,
  id: string,
): Promise<boolean> {
  const catalog = await loadCatalog(catalogPath);
  return catalog.some((e) => e.id === id);
}
