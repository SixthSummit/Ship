#!/usr/bin/env node

// Snapshot coherence for the dev release line.
//
// `changeset version --snapshot` only versions packages with a pending changeset, plus the
// dependents whose declared range the new version leaves. A snapshot such as
// `ship-core@1.1.0-alpha-<datetime>` satisfies none of the stable ranges (`^1.0.0`) that
// already-published adapters declare, because a semver range never matches a prerelease of a
// different version. npm then fails installs with ERESOLVE for a peer dependency, or nests a
// second copy for a regular dependency. Either breaks an alpha dry run.
//
// This script runs in the snapshot job only. It reads `changeset status --output` and writes a
// throwaway patch changeset for every publishable workspace that depends (dependencies,
// peerDependencies or optionalDependencies) on a package in the snapshot, transitively. Those
// packages are then snapshotted in the same run, and pnpm rewrites their `workspace:^` ranges to
// `^<same snapshot>` at publish. The file is never committed; stable releases on main are
// unaffected.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_CHANGESET = "snapshot-dependents.md";
const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * @param {ReadonlyArray<{ name: string, private?: boolean } & Record<string, unknown>>} manifests
 * @param {Iterable<string>} releasedNames packages already in the snapshot release plan
 * @param {Iterable<string>} [ignored] package names changesets ignores
 * @returns {string[]} publishable packages to add to the snapshot, sorted
 */
export function planSnapshotDependents(manifests, releasedNames, ignored = []) {
  const ignoredSet = new Set(ignored);
  const publishable = manifests.filter(
    (manifest) => manifest.private !== true && !ignoredSet.has(manifest.name),
  );
  const inSnapshot = new Set(releasedNames);
  const added = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const manifest of publishable) {
      if (inSnapshot.has(manifest.name)) continue;
      const dependsOnSnapshot = RUNTIME_FIELDS.some((field) =>
        Object.keys(manifest[field] ?? {}).some((name) => inSnapshot.has(name)),
      );
      if (!dependsOnSnapshot) continue;
      inSnapshot.add(manifest.name);
      added.add(manifest.name);
      changed = true;
    }
  }
  return [...added].sort();
}

/** @param {readonly string[]} names */
export function renderSnapshotChangeset(names) {
  const frontmatter = names.map((name) => `"${name}": patch`).join("\n");
  return `---\n${frontmatter}\n---\n\nSnapshot coherence: republish against the packages in this snapshot.\n`;
}

/** @param {{ releases?: ReadonlyArray<{ name: string, type: string }> }} status */
export function releasedFromStatus(status) {
  return (status.releases ?? [])
    .filter((release) => release.type !== "none")
    .map((release) => release.name);
}

async function main() {
  const statusPath = process.argv[2];
  if (!statusPath) {
    throw new Error("usage: node scripts/snapshot-dependents.mjs <changeset-status.json>");
  }
  const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
  const status = JSON.parse(await readFile(resolve(statusPath), "utf8"));
  const config = JSON.parse(await readFile(resolve(repoRoot, ".changeset/config.json"), "utf8"));
  const manifests = [];
  for (const entry of await readdir(resolve(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(
        JSON.parse(
          await readFile(resolve(repoRoot, "packages", entry.name, "package.json"), "utf8"),
        ),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const added = planSnapshotDependents(manifests, releasedFromStatus(status), config.ignore);
  if (added.length === 0) {
    console.log("Snapshot dependents: none to add.");
    return;
  }
  await writeFile(
    resolve(repoRoot, ".changeset", SNAPSHOT_CHANGESET),
    renderSnapshotChangeset(added),
  );
  console.log(`Snapshot dependents added as patch: ${added.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
