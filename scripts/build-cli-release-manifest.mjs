#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = ["kernel", "hono", "contract"];

const manifests = await Promise.all(
  packageDirectories.map(async (directory) =>
    JSON.parse(
      await readFile(resolve(repositoryRoot, "packages", directory, "package.json"), "utf8"),
    ),
  ),
);
const rootManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const coreManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "packages/core/package.json"), "utf8"),
);
const cliManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "packages/cli/package.json"), "utf8"),
);

const manifest = {
  schemaVersion: 1,
  packageManager: rootManifest.packageManager,
  packages: Object.fromEntries(manifests.map(({ name, version }) => [name, version])),
  dependencies: {
    "@hono/node-server": coreManifest.dependencies["@hono/node-server"],
    hono: rootManifest.pnpm.overrides.hono,
    zod: coreManifest.dependencies.zod,
  },
  devDependencies: {
    "@biomejs/biome": rootManifest.devDependencies["@biomejs/biome"],
    "@sixthsummit/ship-cli": cliManifest.version,
    "@types/node": rootManifest.devDependencies["@types/node"],
    "@vitest/coverage-v8": rootManifest.devDependencies["@vitest/coverage-v8"],
    tsx: rootManifest.devDependencies.tsx,
    typescript: rootManifest.devDependencies.typescript,
    vitest: rootManifest.devDependencies.vitest,
  },
};

const target = resolve(repositoryRoot, "packages/cli/lib/release-manifest.json");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
