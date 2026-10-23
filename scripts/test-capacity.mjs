#!/usr/bin/env node
/**
 * Runs the combined capacity baseline (fixtures/capacity) the way the golden
 * consumer runner runs its fixtures: the harness and the customized consumer's
 * application source are copied outside the workspace, every Ship package is
 * installed from a freshly packed tarball with recorded provenance, and the
 * harness's own Biome and TypeScript gates run before the load starts.
 *
 *   node scripts/test-capacity.mjs            # CAPACITY_DURATION_SECONDS defaults to 600
 *   node scripts/test-capacity.mjs --short    # 60 s smoke shape (CAPACITY_MODE=short)
 *
 * Every CAPACITY_* variable is passed through; see docs/v4/capacity-baseline.md.
 * `--reuse <dir>` re-copies the sources into a previously kept run directory
 * (skipping pack and install) and `--keep` leaves the run directory in place.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORIES = new Map([
  ["@sixthsummit/ship-core", "kernel"],
  ["@sixthsummit/ship-hono", "hono"],
  ["@sixthsummit/ship-drizzle", "drizzle"],
  ["@sixthsummit/ship-contract", "contract"],
  ["@sixthsummit/ship-observability-otel", "observability-otel"],
  ["@sixthsummit/ship-testing", "testing"],
  ["@sixthsummit/ship-realtime-socketio", "realtime-socketio"],
  ["@sixthsummit/ship-webhooks", "webhooks"],
  ["@sixthsummit/ship-jobs-bullmq", "jobs-bullmq"],
  ["@sixthsummit/ship-console", "console"],
  ["@sixthsummit/ship-auth-credentials", "auth-credentials"],
  ["@sixthsummit/ship-cache-redis", "cache-redis"],
]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessSource = resolve(repoRoot, "fixtures", "capacity");
const consumerSource = resolve(repoRoot, "fixtures", "consumers", "customized", "src");
const options = parseArguments(process.argv.slice(2));

const runRoot = options.reuse ?? (await mkdtemp(resolve(tmpdir(), "ship-api-capacity-")));
const artifactDirectory = resolve(runRoot, "artifacts");
const harnessDirectory = resolve(runRoot, "harness");
const gitSha = run("git", ["rev-parse", "--short", "HEAD"], repoRoot, true).trim();

try {
  await copySources();
  if (!options.reuse) {
    await mkdir(artifactDirectory, { recursive: true });
    const manifest = JSON.parse(await readFile(resolve(harnessSource, "package.json"), "utf8"));
    const artifacts = await packPackages(closure(manifest));
    await configureHarness(manifest, artifacts);
    run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], harnessDirectory);
  }
  run("pnpm", ["run", "check"], harnessDirectory);
  run("pnpm", ["run", "type-check"], harnessDirectory);
  run("pnpm", ["run", "start"], harnessDirectory, false, {
    ...(options.short ? { CAPACITY_MODE: "short" } : {}),
    CAPACITY_OUTPUT_DIR: process.env.CAPACITY_OUTPUT_DIR ?? resolve(repoRoot, ".capacity"),
    CAPACITY_GIT_SHA: gitSha,
  });
} finally {
  if (options.keep || options.reuse) {
    console.log(`capacity run directory kept at ${runRoot}`);
  } else {
    await rm(runRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const parsed = { short: false, keep: false, reuse: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--short") parsed.short = true;
    else if (argument === "--keep") parsed.keep = true;
    else if (argument === "--reuse") {
      index += 1;
      if (!argv[index]) throw new Error("--reuse requires a directory");
      parsed.reuse = resolve(argv[index]);
    } else throw new Error(`unknown argument ${argument}`);
  }
  return parsed;
}

async function copySources() {
  await rm(resolve(harnessDirectory, "src"), { recursive: true, force: true });
  await rm(resolve(harnessDirectory, "consumer"), { recursive: true, force: true });
  await mkdir(harnessDirectory, { recursive: true });
  for (const entry of await readdir(harnessSource, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "consumer") continue;
    if (options.reuse && entry.name === "package.json") continue;
    await cp(resolve(harnessSource, entry.name), resolve(harnessDirectory, entry.name), {
      recursive: true,
    });
  }
  // The consumer's application source is the single source of truth; only its
  // tests and type-level checks stay behind.
  await mkdir(resolve(harnessDirectory, "consumer"));
  for (const entry of await readdir(consumerSource, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".typecheck.ts")) continue;
    await cp(
      resolve(consumerSource, entry.name),
      resolve(harnessDirectory, "consumer", entry.name),
    );
  }
}

function run(command, arguments_, cwd, capture = false, env = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...env },
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

/** Every Ship package the harness declares plus the Ship packages they depend on. */
function closure(manifest) {
  const names = new Set();
  const pending = [];
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (PACKAGE_DIRECTORIES.has(name)) pending.push(name);
    }
  }
  while (pending.length > 0) {
    const name = pending.pop();
    if (names.has(name)) continue;
    names.add(name);
    const directory = PACKAGE_DIRECTORIES.get(name);
    if (!directory) throw new Error(`no workspace mapping for ${name}`);
    const packageManifest = JSON.parse(
      readFileSync(resolve(repoRoot, "packages", directory, "package.json"), "utf8"),
    );
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(packageManifest[field] ?? {})) {
        if (PACKAGE_DIRECTORIES.has(dependency)) pending.push(dependency);
      }
    }
  }
  return [...names].sort();
}

async function packPackages(packageNames) {
  const artifacts = new Map();
  for (const packageName of packageNames) {
    const packageDirectory = resolve(repoRoot, "packages", PACKAGE_DIRECTORIES.get(packageName));
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

async function configureHarness(manifest, artifacts) {
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
    resolve(harnessDirectory, "package.json"),
    `${JSON.stringify(configured, null, 2)}\n`,
  );
  await mkdir(resolve(harnessDirectory, ".ship"), { recursive: true });
  await writeFile(
    resolve(harnessDirectory, ".ship", "framework-provenance.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        fixture: "capacity",
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
