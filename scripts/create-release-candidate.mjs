#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createCandidateManifest,
  parseCandidateArguments,
  SHIP_API_PACKAGE_DIRECTORIES,
} from "./release-candidate.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { output, additionalPackages } = parseCandidateArguments(process.argv.slice(2));
const outputRoot = resolve(output);
const archiveRoot = resolve(outputRoot, "archives");
let ownsOutput = false;

try {
  await mkdir(outputRoot);
  ownsOutput = true;
  await mkdir(archiveRoot);

  const packageRoots = [
    ...SHIP_API_PACKAGE_DIRECTORIES.map((directory) =>
      resolve(repositoryRoot, "packages", directory),
    ),
    ...additionalPackages.map((directory) => resolve(directory)),
  ];
  const entries = [];
  for (const packageRoot of packageRoots) entries.push(await packPackage(packageRoot));

  const manifest = createCandidateManifest(entries);
  const manifestPath = resolve(outputRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `Candidate ${manifest.fingerprint}: ${entries.length} packages at ${manifestPath}\n`,
  );
  for (const entry of Object.values(manifest.packages)) {
    process.stdout.write(`  ${entry.name}@${entry.version} ${entry.bytes} bytes ${entry.sha256}\n`);
  }
} catch (error) {
  if (ownsOutput) await rm(outputRoot, { recursive: true, force: true });
  throw error;
}

async function packPackage(packageRoot) {
  const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  if (typeof packageManifest.name !== "string" || typeof packageManifest.version !== "string") {
    throw new Error(`${packageRoot} does not contain a named, versioned package`);
  }

  const source = sourceProvenance(packageRoot);
  const dirty = run(
    "git",
    ["-C", source.root, "status", "--porcelain", "--untracked-files=all", "--", source.packagePath],
    repositoryRoot,
    true,
  ).trim();
  if (dirty.length > 0) {
    throw new Error(`${packageManifest.name} package source is not committed:\n${dirty}`);
  }

  const packed = JSON.parse(
    run("pnpm", ["pack", "--json", "--pack-destination", archiveRoot], packageRoot, true),
  );
  if (packed.name !== packageManifest.name || packed.version !== packageManifest.version) {
    throw new Error(`packed identity mismatch for ${packageManifest.name}`);
  }
  verifyManifestTargets(packed, packageManifest);

  const archive = await readFile(packed.filename);
  return {
    name: packed.name,
    version: packed.version,
    archive: `archives/${basename(packed.filename)}`,
    bytes: (await stat(packed.filename)).size,
    sha256: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    source: {
      repository: source.repository,
      commit: source.commit,
      packagePath: source.packagePath,
    },
  };
}

function sourceProvenance(packageRoot) {
  const root = run(
    "git",
    ["-C", packageRoot, "rev-parse", "--show-toplevel"],
    repositoryRoot,
    true,
  ).trim();
  const commit = run("git", ["-C", root, "rev-parse", "HEAD"], repositoryRoot, true).trim();
  const remote = run(
    "git",
    ["-C", root, "config", "--get", "remote.origin.url"],
    repositoryRoot,
    true,
    true,
  ).trim();
  return {
    root,
    commit,
    repository: remote || basename(root),
    packagePath: relative(root, packageRoot) || ".",
  };
}

function verifyManifestTargets(pack, manifest) {
  const packedPaths = new Set(pack.files.map(({ path }) => path));
  const targets = new Set(["package.json"]);
  collectTargets(manifest.main, targets);
  collectTargets(manifest.types, targets);
  collectTargets(manifest.bin, targets);
  collectTargets(manifest.exports, targets);
  for (const target of targets) {
    if (!packedPaths.has(target)) {
      throw new Error(`${pack.name} archive is missing manifest target ${target}`);
    }
  }
}

function collectTargets(value, targets) {
  if (typeof value === "string") {
    if (value.startsWith("./") && !value.includes("*")) targets.add(value.slice(2));
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectTargets(child, targets);
  }
}

function run(command, arguments_, cwd, capture = false, allowFailure = false) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    if (capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${arguments_.join(" ")} exited with ${result.status}`);
  }
  return result.stdout ?? "";
}
