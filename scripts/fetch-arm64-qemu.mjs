// Stage the native-arm64 qemu bundle into vendor/qemu-pebble-win-arm64/ (gitignored)
// from the latest successful run of the Phase-0 arm64 CI workflow.
//
// Requires the GitHub CLI (`gh`) authenticated for therealjasonlin/pebble-studio
// (GH_TOKEN or `gh auth`). On this build host gh is installed but not on PATH:
//   export PATH="$PATH:/c/Program Files/GitHub CLI"
//   export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
//
// Manual fallback (no gh): open the workflow's latest green run in GitHub Actions,
// download the `qemu-pebble-win-arm64` artifact zip, and unzip it so that
// vendor/qemu-pebble-win-arm64/qemu-pebble.exe exists.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ARTIFACT_NAME = "qemu-pebble-win-arm64";
export const WORKFLOW_NAME = "qemu-arm64.yml";
const REPO = "therealjasonlin/pebble-studio";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEST_DIR = join(repoRoot, "vendor", "qemu-pebble-win-arm64");

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", env: process.env }).trim();
}

async function main() {
  const runId = gh([
    "run", "list", "--repo", REPO, "--workflow", WORKFLOW_NAME,
    "--status", "success", "--limit", "1", "--json", "databaseId",
    "--jq", ".[0].databaseId",
  ]);
  if (!runId) throw new Error(`no successful ${WORKFLOW_NAME} run found on ${REPO}`);

  const staging = mkdtempSync(join(tmpdir(), "arm64-qemu-"));
  try {
    gh(["run", "download", runId, "--repo", REPO, "--name", ARTIFACT_NAME, "--dir", staging]);
    const exe = join(staging, "qemu-pebble.exe");
    if (!existsSync(exe)) throw new Error(`artifact ${ARTIFACT_NAME} did not contain qemu-pebble.exe`);
    rmSync(DEST_DIR, { recursive: true, force: true });
    mkdirSync(DEST_DIR, { recursive: true });
    cpSync(staging, DEST_DIR, { recursive: true });
    console.log(`staged arm64 qemu bundle -> ${DEST_DIR}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Only run the network path when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(String(e)); process.exit(1); });
}
