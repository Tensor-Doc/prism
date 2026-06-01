// pnpm prism <command> [args]
//
// Subcommands:
//   migrate            One-shot: catalog/catalog.json (v1) → catalog/entries/*.json (v2)
//   validate           Consistency check across catalog/entries/* (TODO)
//   ingest <path>      Add presets/textures from a folder (TODO)
//   annotate [--all]   Run Gemini against unannotated entries (TODO)
//   test-presets       Smoke test the catalog (TODO)
//
// All commands operate on the cwd's repo root.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader — Node 20 doesn't have --env-file-if-exists; we
// just parse the file ourselves if present and inject into process.env
// for the rest of the run (downstream commands read from process.env).
function loadDotenv(cwd: string): void {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf-8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k]) continue; // existing env wins
    process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

loadDotenv(process.cwd());

import { runAnnotate } from "./commands/annotate";
import { runBuildIndex } from "./commands/build-index";
import { runBuildTextures } from "./commands/build-textures";
import { runBackfillVideoSizes } from "./commands/backfill-video-sizes";
import { runIngest } from "./commands/ingest";
import { runIterateShader } from "./commands/iterate-shader";
import { runMigrate } from "./commands/migrate";
import { runValidateColdOpen } from "./commands/validate-cold-open";

function findRepoRoot(): string {
  // We expect to be run from the repo root via `pnpm prism …`. Verify the
  // catalog/ dir exists at cwd; fail loudly if not.
  const cwd = process.cwd();
  if (!existsSync(join(cwd, "catalog"))) {
    throw new Error(
      "no catalog/ at cwd — run from the repo root (e.g. via `pnpm prism <cmd>`)",
    );
  }
  return cwd;
}

function usage(): void {
  console.log("usage: prism <migrate|validate|ingest|annotate|test-presets> [args]");
}

function main(): void {
  const [, , command, ...args] = process.argv;
  if (!command) {
    usage();
    process.exit(1);
  }
  const repoRoot = findRepoRoot();
  switch (command) {
    case "migrate": {
      const dryRun = args.includes("--dry-run");
      runMigrate(repoRoot, dryRun);
      break;
    }
    case "ingest": {
      const path = args.find((a) => !a.startsWith("--"));
      if (!path) {
        console.error("[prism] ingest needs a source path, e.g. `pnpm prism ingest favorites`");
        process.exit(1);
      }
      const limitArg = args.find((a) => a.startsWith("--limit="));
      const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
      const subArg = args.find((a) => a.startsWith("--include-subdirs="));
      const includeSubdirs = subArg
        ? subArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      runIngest(repoRoot, path, { limit, includeSubdirs });
      break;
    }
    case "annotate": {
      const slug = args.find((a) => !a.startsWith("--"));
      const all = args.includes("--all");
      const reuseVideo = args.includes("--reuse-video");
      const retryErrored = args.includes("--retry-errored");
      const limitArg = args.find((a) => a.startsWith("--limit="));
      const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
      void runAnnotate(repoRoot, { slug, all, limit, reuseVideo, retryErrored }).catch((err: Error) => {
        console.error(`[annotate] FAILED: ${err.message}`);
        if (err.stack) console.error(err.stack);
        process.exit(2);
      });
      break;
    }
    case "build-index": {
      runBuildIndex(repoRoot);
      break;
    }
    case "build-textures": {
      runBuildTextures(repoRoot);
      break;
    }
    case "backfill-video-sizes": {
      runBackfillVideoSizes(repoRoot);
      break;
    }
    case "iterate-shader": {
      void runIterateShader(repoRoot, args).catch((err: Error) => {
        console.error(`[iterate-shader] FAILED: ${err.message}`);
        if (err.stack) console.error(err.stack);
        process.exit(2);
      });
      break;
    }
    case "validate-cold-open": {
      void runValidateColdOpen(repoRoot).catch((err: Error) => {
        console.error(`[validate-cold-open] FAILED: ${err.message}`);
        process.exit(2);
      });
      break;
    }
    case "validate":
    case "test-presets":
      console.error(`[prism] '${command}' not implemented yet`);
      process.exit(2);
      break;
    default:
      console.error(`[prism] unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main();
