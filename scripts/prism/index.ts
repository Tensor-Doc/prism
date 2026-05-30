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
    case "validate":
    case "ingest":
    case "annotate":
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
