#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertReproduciblePackageArchives,
  packageArchiveIdentity,
} from "./package-reproducibility.mjs";
import { SHIP_API_PACKAGE_DIRECTORIES } from "./release-candidate.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = await mkdtemp(resolve(tmpdir(), "ship-api-pack-reproducibility-"));

try {
  const firstBuild = await buildAndPack("first");
  const secondBuild = await buildAndPack("second");
  const names = assertReproduciblePackageArchives(firstBuild, secondBuild);

  console.log(`reproducible package graph passed: ${names.length} byte-identical archives`);
  for (const name of names) {
    const identity = firstBuild.get(name);
    console.log(`  ${name}@${identity.version}: ${identity.bytes} bytes ${identity.sha256}`);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function buildAndPack(pass) {
  run("pnpm", ["run", "api:build"], repositoryRoot);
  const archiveRoot = resolve(fixtureRoot, pass);
  await mkdir(archiveRoot);
  const identities = new Map();

  for (const directory of SHIP_API_PACKAGE_DIRECTORIES) {
    const packageRoot = resolve(repositoryRoot, "packages", directory);
    const pack = JSON.parse(
      run("pnpm", ["pack", "--json", "--pack-destination", archiveRoot], packageRoot, true),
    );
    const identity = await packageArchiveIdentity(pack);
    if (identities.has(identity.name)) {
      throw new Error(`duplicate package identity ${identity.name} in the ${pass} build`);
    }
    identities.set(identity.name, identity);
  }

  return identities;
}

function run(command, arguments_, cwd, capture = false) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${arguments_.join(" ")} exited with ${result.status}`);
  }
  return result.stdout ?? "";
}
