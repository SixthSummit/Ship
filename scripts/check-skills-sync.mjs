#!/usr/bin/env node
// CI guard for the .cursor/rules/*.mdc → SKILL.md drift contract.
//
// Recomputes content hashes of every `.cursor/rules/*.mdc` file and
// compares against the pinned hashes in `scripts/skills-sync-state.json`.
// Fails (exit 1) when:
//
//   - A rule file's content has changed since the last `sync:skills`
//     run — the SKILL.md author needs to review the change and
//     re-run sync to acknowledge.
//   - A rule file is added but not yet pinned.
//   - A rule file in the state file was deleted from disk.
//
// Usage:
//   node scripts/check-skills-sync.mjs   — exit 0 if synced, exit 1 + report on drift
//   pnpm run check:skills                — same via root script

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const RULES_DIR = join(REPO_ROOT, ".cursor", "rules");
const STATE_PATH = join(__dirname, "skills-sync-state.json");

async function main() {
  const state = await loadState(STATE_PATH);
  const pinned = state.rules ?? {};

  const ruleFiles = (await readdir(RULES_DIR)).filter((f) => f.endsWith(".mdc")).sort();
  const drift = [];

  for (const file of ruleFiles) {
    const text = await readFile(join(RULES_DIR, file), "utf8");
    const actual = createHash("sha256").update(text).digest("hex");
    const expected = pinned[file];
    if (expected === undefined) {
      drift.push({ file, kind: "added" });
    } else if (expected !== actual) {
      drift.push({ file, kind: "changed" });
    }
  }

  for (const file of Object.keys(pinned)) {
    if (!ruleFiles.includes(file)) {
      drift.push({ file, kind: "removed" });
    }
  }

  if (drift.length === 0) {
    console.log("check:skills: in sync.");
    return 0;
  }

  console.error(
    "check:skills: drift detected between .cursor/rules/ and the pinned skill state.\n",
  );
  for (const d of drift) {
    const symbol = d.kind === "added" ? "+" : d.kind === "removed" ? "-" : "~";
    console.error(`  ${symbol} ${d.file} (${d.kind})`);
  }
  console.error(
    "\nFix: review the SKILL.md summaries under packages/claude-plugin/skills/" +
      ` to confirm they still accurately reflect the rule changes, then run:\n\n` +
      "  pnpm run sync:skills\n\n" +
      "and commit the updated scripts/skills-sync-state.json.",
  );
  return 1;
}

async function loadState(path) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("check:skills: state file missing. Run `pnpm run sync:skills` to create it.");
      return { rules: {} };
    }
    throw err;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error("check:skills failed:", err.message);
    process.exit(1);
  });
