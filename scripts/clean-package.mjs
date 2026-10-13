#!/usr/bin/env node

import { access, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(repositoryRoot, "packages");
const packageRoot = resolve(process.cwd());
const outputDirectory = resolve(packageRoot, "lib");
const buildInfoPath = resolve(packageRoot, ".tsbuildinfo");
const packageRelative = relative(packagesRoot, packageRoot);

if (
  packageRelative.length === 0 ||
  packageRelative.startsWith(`..${sep}`) ||
  packageRelative === ".." ||
  packageRelative.includes(sep)
) {
  throw new Error(`refusing to clean outside a direct packages/* workspace: ${packageRoot}`);
}

const manifestPath = resolve(packageRoot, "package.json");
await access(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (typeof manifest.name !== "string" || !manifest.name.startsWith("@sixthsummit/")) {
  throw new Error(`refusing to clean an unrecognized package workspace: ${packageRoot}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await rm(buildInfoPath, { force: true });
