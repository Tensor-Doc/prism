// Resumable-job progress tracker.
//
// One JSON file on disk records the state of every preset across the
// ingest → render → annotate pipeline. Each step is idempotent and
// consults the tracker before doing work — so killing the process at
// any point and re-running picks up exactly where it left off.
//
// Operational state, not source of truth: the tracker is gitignored.
// The durable record lives in catalog/entries/<id>.json.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type Stage = "ingested" | "rendered" | "annotated" | "errored" | "skipped";

export interface PresetProgress {
  slug: string;
  status: Stage;
  source_file?: string;
  ingested_at?: string;
  rendered_at?: string;
  annotated_at?: string;
  render_ms?: number;
  annotate_ms?: number;
  stage_failed?: "ingest" | "render" | "annotate";
  attempts?: number;
  error?: string;
}

export interface ProgressFile {
  started_at: string;
  updated_at: string;
  total: number;
  counts: Record<Stage | "pending", number>;
  presets: Record<string, PresetProgress>;
}

export class Progress {
  private data: ProgressFile;
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf-8")) as ProgressFile;
    } else {
      this.data = {
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        total: 0,
        counts: { ingested: 0, rendered: 0, annotated: 0, errored: 0, skipped: 0, pending: 0 },
        presets: {},
      };
    }
  }

  setTotal(n: number): void {
    this.data.total = n;
    this.recountAndSave();
  }

  get(slug: string): PresetProgress | undefined {
    return this.data.presets[slug];
  }

  /** Idempotent: returns true if work should be done, false if already past this stage. */
  shouldRun(slug: string, stage: Stage): boolean {
    const cur = this.data.presets[slug];
    if (!cur) return true;
    const order: Stage[] = ["ingested", "rendered", "annotated"];
    const have = order.indexOf(cur.status);
    const want = order.indexOf(stage);
    // errored: re-run only if attempts < 3
    if (cur.status === "errored") return (cur.attempts ?? 0) < 3;
    return have < want;
  }

  update(slug: string, patch: Partial<PresetProgress>): void {
    const existing = this.data.presets[slug] ?? { slug, status: "ingested" as Stage };
    this.data.presets[slug] = { ...existing, ...patch };
    this.recountAndSave();
  }

  markError(slug: string, stage: "ingest" | "render" | "annotate", error: string): void {
    const existing = this.data.presets[slug] ?? { slug, status: "ingested" as Stage };
    this.data.presets[slug] = {
      ...existing,
      status: "errored",
      stage_failed: stage,
      attempts: (existing.attempts ?? 0) + 1,
      error,
    };
    this.recountAndSave();
  }

  summary(): string {
    const c = this.data.counts;
    return `ingested ${c.ingested} · rendered ${c.rendered} · annotated ${c.annotated} · errored ${c.errored} · pending ${c.pending} / ${this.data.total}`;
  }

  pendingSlugs(stage: Stage): string[] {
    return Object.values(this.data.presets)
      .filter((p) => this.shouldRun(p.slug, stage))
      .map((p) => p.slug);
  }

  /** Find an already-tracked entry by its source filename. Used by
   *  ingest to dedupe across re-runs — if a source file was already
   *  processed, reuse its slug instead of disambiguating to a new one. */
  findBySourceFile(sourceFile: string): PresetProgress | undefined {
    for (const p of Object.values(this.data.presets)) {
      if (p.source_file === sourceFile) return p;
    }
    return undefined;
  }

  private recountAndSave(): void {
    const counts = { ingested: 0, rendered: 0, annotated: 0, errored: 0, skipped: 0, pending: 0 };
    for (const p of Object.values(this.data.presets)) {
      counts[p.status]++;
    }
    counts.pending = Math.max(0, this.data.total - Object.keys(this.data.presets).length);
    this.data.counts = counts;
    this.data.updated_at = new Date().toISOString();
    // Atomic write: tmp + rename.
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}

export function progressPath(repoRoot: string): string {
  return join(repoRoot, "catalog/.ingest-progress.json");
}
