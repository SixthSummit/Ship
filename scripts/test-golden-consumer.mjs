#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORIES = new Map([
  ["@sixthsummit/ship-core", "kernel"],
  ["@sixthsummit/ship-hono", "hono"],
  ["@sixthsummit/ship-drizzle", "drizzle"],
  ["@sixthsummit/ship-contract", "contract"],
  ["@sixthsummit/ship-cli", "cli"],
  ["@sixthsummit/ship-auth-firebase", "auth-firebase"],
  ["@sixthsummit/ship-observability-otel", "observability-otel"],
  ["@sixthsummit/ship-testing", "testing"],
  ["@sixthsummit/ship-realtime-socketio", "realtime-socketio"],
  ["@sixthsummit/ship-webhooks", "webhooks"],
  ["@sixthsummit/ship-jobs-bullmq", "jobs-bullmq"],
  ["@sixthsummit/ship-console", "console"],
]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureName = process.argv[2];
if (!fixtureName || !/^[a-z][a-z0-9-]*$/u.test(fixtureName)) {
  throw new Error("usage: node scripts/test-golden-consumer.mjs <fixture-name>");
}

const sourceDirectory = resolve(repoRoot, "fixtures", "consumers", fixtureName);
const sourceManifest = JSON.parse(await readFile(resolve(sourceDirectory, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(resolve(tmpdir(), `ship-api-${fixtureName}-consumer-`));
const artifactDirectory = resolve(temporaryRoot, "artifacts");
const consumerDirectory = resolve(temporaryRoot, "consumer");

try {
  await mkdir(artifactDirectory);
  await cp(sourceDirectory, consumerDirectory, { recursive: true });
  const localPackageNames = findLocalPackages(sourceManifest);
  const artifacts = await packPackages(localPackageNames);
  await configureConsumer(sourceManifest, artifacts);

  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumerDirectory);
  await verifyInstalledPackages(artifacts);

  const gates = ["check", "type-check", "test", "build", "test:integration"];
  const timings = {};
  for (const gate of gates) {
    const started = performance.now();
    run("pnpm", ["run", gate], consumerDirectory);
    timings[gate] = Math.round(performance.now() - started);
  }

  const totalBytes = [...artifacts.values()].reduce((sum, artifact) => sum + artifact.bytes, 0);
  console.log(
    `golden consumer ${fixtureName} passed from ${artifacts.size} packed packages (${totalBytes} bytes)`,
  );
  for (const [gate, durationMs] of Object.entries(timings)) {
    console.log(`  ${gate}: ${durationMs} ms`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
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
  return result.stdout;
}

function findLocalPackages(manifest) {
  const names = new Set();
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (PACKAGE_DIRECTORIES.has(name)) names.add(name);
    }
  }
  if (names.size === 0) throw new Error(`${fixtureName} declares no packed Ship packages`);
  return [...names].sort();
}

async function packPackages(packageNames) {
  const artifacts = new Map();
  for (const packageName of packageNames) {
    const directoryName = PACKAGE_DIRECTORIES.get(packageName);
    if (!directoryName) throw new Error(`no workspace mapping for ${packageName}`);
    const packageDirectory = resolve(repoRoot, "packages", directoryName);
    const packed = JSON.parse(
      run(
        "pnpm",
        ["pack", "--json", "--pack-destination", artifactDirectory],
        packageDirectory,
        true,
      ),
    );
    if (packed.name !== packageName) {
      throw new Error(`packed ${packed.name} while expecting ${packageName}`);
    }
    const archive = await readFile(packed.filename);
    artifacts.set(packageName, {
      filename: packed.filename,
      version: packed.version,
      bytes: (await stat(packed.filename)).size,
      sha256: createHash("sha256").update(archive).digest("hex"),
    });
  }
  return artifacts;
}

async function configureConsumer(manifest, artifacts) {
  const localReferences = Object.fromEntries(
    [...artifacts].map(([name, artifact]) => [name, `file:${artifact.filename}`]),
  );
  const configured = structuredClone(manifest);
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, reference] of Object.entries(localReferences)) {
      if (configured[field]?.[name]) configured[field][name] = reference;
    }
  }
  configured.pnpm = { ...(configured.pnpm ?? {}), overrides: localReferences };
  await writeFile(
    resolve(consumerDirectory, "package.json"),
    `${JSON.stringify(configured, null, 2)}\n`,
  );
  await mkdir(resolve(consumerDirectory, ".ship"));
  await writeFile(
    resolve(consumerDirectory, ".ship", "framework-provenance.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        fixture: fixtureName,
        packages: Object.fromEntries(
          [...artifacts].map(([name, { version, bytes, sha256 }]) => [
            name,
            { version, bytes, sha256: `sha256:${sha256}` },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function verifyInstalledPackages(artifacts) {
  const provenance = JSON.parse(
    await readFile(resolve(consumerDirectory, ".ship", "framework-provenance.json"), "utf8"),
  );
  for (const [name, artifact] of artifacts) {
    const installedManifestPath = resolve(consumerDirectory, "node_modules", name, "package.json");
    const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
    const installedRoot = await realpath(dirname(installedManifestPath));
    if (installedManifest.version !== artifact.version) {
      throw new Error(
        `${name} installed ${installedManifest.version}, expected ${artifact.version}`,
      );
    }
    if (installedRoot.startsWith(repoRoot)) {
      throw new Error(`${name} resolved through the framework workspace instead of its tarball`);
    }
    if ((await lstat(resolve(consumerDirectory, "node_modules", name))).isSymbolicLink()) {
      const target = await realpath(resolve(consumerDirectory, "node_modules", name));
      if (target.startsWith(repoRoot)) {
        throw new Error(`${name} symlink escapes into the framework workspace`);
      }
    }
    if (provenance.packages[name]?.sha256 !== `sha256:${artifact.sha256}`) {
      throw new Error(`${name} provenance does not match the installed archive`);
    }
  }
}
