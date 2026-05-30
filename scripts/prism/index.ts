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
import { existsSync } from "node:fs";

import { runAnnotate } from "./commands/annotate";
import { runIngest } from "./commands/ingest";
import { runMigrate } from "./commands/migrate";

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
      runIngest(repoRoot, path, { limit });
      break;
    }
    case "annotate": {
      const slug = args.find((a) => !a.startsWith("--"));
      const all = args.includes("--all");
      const limitArg = args.find((a) => a.startsWith("--limit="));
      const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
      void runAnnotate(repoRoot, { slug, all, limit }).catch((err: Error) => {
        console.error(`[annotate] FAILED: ${err.message}`);
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
