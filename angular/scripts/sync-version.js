#!/usr/bin/env node
// Syncs everything that mirrors ../packages/angular/package.json#version:
//
//   1. ../packages/angular/src/version.ts          — the VERSION export (generated)
//   2. package.json (root)                   — private mirror, kept aligned
//   3. templates/default/package.json        — the framework dep range
//      (^x.y.z for stable versions; an exact pin for prereleases such as
//      the alpha snapshots published from dev, e.g. 4.1.1-alpha-20260918120000)
//
// Runs standalone (`pnpm sync-version`), on every core prebuild, as part of
// `pnpm version-packages` right after `changeset version` bumps the core
// package, and after `changeset version --snapshot alpha` in the dev
// snapshot job — so a release bump propagates everywhere in one step.
//
// Deliberately NOT mirrored: workspace package versions (../apps/angular-docs).
// changesets/action detects "released packages" by diffing workspace
// package.json versions and then reads each one's CHANGELOG.md for the
// version-PR body — bumping ../apps/angular-docs here made the action crash with
// ENOENT on ../apps/angular-docs/CHANGELOG.md. The root package.json is safe (the
// workspace root isn't iterated as a package).

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');

const pkgPath = path.join(repoRoot, '..', 'packages', 'angular', 'package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
const version = pkg.version;
// Anything after the first `-` is a prerelease identifier (4.1.1-alpha-…).
// A caret range on a prerelease only matches later prereleases of the same
// x.y.z and the eventual stable x.y.z, so it is surprising for snapshots;
// consumers of a prerelease template pin the exact version instead
// (the same rule `ship-angular create` applies at scaffold time).
const isPrerelease = version.includes('-');
const templateDepRange = isPrerelease ? version : `^${version}`;

async function writeIfChanged(filePath, contents, label) {
  const existing = await fs.readFile(filePath, 'utf8').catch(() => null);
  if (existing === contents) {
    console.log(`✓ ${label} already in sync (${version})`);
    return;
  }
  await fs.writeFile(filePath, contents, 'utf8');
  console.log(`✓ Wrote ${version} to ${label}`);
}

async function syncJson(filePath, label, mutate) {
  const raw = await fs.readFile(filePath, 'utf8');
  const json = JSON.parse(raw);
  mutate(json);
  await writeIfChanged(filePath, JSON.stringify(json, null, 2) + '\n', label);
}

// 1. version.ts
await writeIfChanged(
  path.join(repoRoot, '..', 'packages', 'angular', 'src', 'version.ts'),
  `// Auto-generated from ../packages/angular/package.json by scripts/sync-version.js.
// Do not edit by hand — run \`pnpm sync-version\` (or any build) to regenerate.

export const VERSION = '${version}';
`,
  '../packages/angular/src/version.ts'
);

// 2. root package.json (private mirror)
await syncJson(path.join(repoRoot, 'package.json'), 'package.json (root)', json => {
  json.version = version;
});

// 3. template's framework dep range
await syncJson(
  path.join(repoRoot, '..', 'packages', 'angular', 'templates', 'default', 'package.json'),
  'templates/default/package.json (dep range)',
  json => {
    if (json.dependencies?.['@sixthsummit/ship-angular']) {
      json.dependencies['@sixthsummit/ship-angular'] = templateDepRange;
    } else {
      console.warn(
        '⚠️  templates/default/package.json has no @sixthsummit/ship-angular dependency — dep-range sync skipped'
      );
    }
  }
);
