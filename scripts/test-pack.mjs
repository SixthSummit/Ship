#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PACKAGE_DIRECTORIES = [
  "kernel",
  "hono",
  "drizzle",
  "contract",
  "cli",
  "auth-firebase",
  "cache-redis",
  "observability-otel",
  "testing",
  "realtime-socketio",
  "push",
  "webhooks",
  "jobs-bullmq",
  "mcp-server",
  "claude-plugin",
  "core",
];
const ASSET_SOURCE_ROOTS = new Map([
  ["@sixthsummit/ship-api", ["templates/", "lib/modules/", "lib/libraries/"]],
  ["@sixthsummit/ship-cli", ["templates/"]],
]);
// Packages whose types, runtime guards and process-wide registries must exist exactly once per
// app. Every other packed package must take them as peers; only the compatibility distribution
// (which an app may install on its own) keeps them as regular dependencies.
const SINGLETON_PACKAGES = ["@sixthsummit/ship-core", "@sixthsummit/ship-hono"];
const SINGLETON_REGULAR_DEPENDENTS = new Set(["@sixthsummit/ship-api"]);
const FORBIDDEN_FILE_PATTERN =
  /(?:^|\/)(?:__tests__)(?:\/|$)|\.(?:test|integration\.test|parity\.test|typecheck)\.[^.\/]+(?:\.|$)|(?:^|\/)\.tsbuildinfo$/u;

const repoRoot = resolve(import.meta.dirname, "..");
const fixtureDirectory = await mkdtemp(resolve(tmpdir(), "ship-api-pack-test-"));
const artifactDirectory = resolve(fixtureDirectory, "artifacts");
const consumerDirectory = resolve(fixtureDirectory, "consumer");
const npmConsumerDirectory = resolve(fixtureDirectory, "npm-consumer");

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
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
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }

  return result.stdout;
}

try {
  await mkdir(artifactDirectory);
  const artifacts = await packAndVerifyPackages();
  await createConsumer(artifacts);
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumerDirectory);
  await verifyInstalledDeclarations();
  run(process.execPath, ["index.mjs"], consumerDirectory);
  await verifyCli(artifacts);
  run(
    "pnpm",
    [
      "exec",
      "tsc",
      "--strict",
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--resolveJsonModule",
      "typecheck.ts",
    ],
    consumerDirectory,
  );
  await verifySingleFrameworkCopy(artifacts);

  const totalFiles = [...artifacts.values()].reduce((sum, item) => sum + item.pack.files.length, 0);
  const totalBytes = [...artifacts.values()].reduce((sum, item) => sum + item.archiveBytes, 0);
  console.log(
    `packed package graph passed: ${artifacts.size} packages, ${totalFiles} files, ${totalBytes} archive bytes`,
  );
  for (const { pack, archiveBytes, archiveSha256 } of artifacts.values()) {
    console.log(
      `  ${pack.name}@${pack.version}: ${pack.files.length} files, ${archiveBytes} bytes, sha256:${archiveSha256}`,
    );
  }
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}

async function packAndVerifyPackages() {
  const artifacts = new Map();
  for (const directoryName of PACKAGE_DIRECTORIES) {
    const packageDirectory = resolve(repoRoot, "packages", directoryName);
    const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
    const pack = JSON.parse(
      run(
        "pnpm",
        ["pack", "--json", "--pack-destination", artifactDirectory],
        packageDirectory,
        true,
      ),
    );
    if (pack.name !== manifest.name || pack.version !== manifest.version) {
      throw new Error(`packed identity mismatch for ${directoryName}`);
    }

    verifyArchiveSurface(pack, manifest);
    const archive = await readFile(pack.filename);
    artifacts.set(pack.name, {
      directoryName,
      manifest,
      pack,
      archiveBytes: (await stat(pack.filename)).size,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
    });
  }
  return artifacts;
}

// npm is what Ship consumers use, and where a regular `^1.0.0` dependency once installed a
// private nested ship-core next to the app's prerelease copy. Install the packed graph with a
// plain `npm install` (no overrides, no --legacy-peer-deps) and require exactly one physical
// copy of each singleton package plus a clean `npm ls`.
async function verifySingleFrameworkCopy(artifacts) {
  for (const { pack } of artifacts.values()) {
    const packedManifest = JSON.parse(
      run("tar", ["-xOzf", pack.filename, "package/package.json"], fixtureDirectory, true),
    );
    if (SINGLETON_REGULAR_DEPENDENTS.has(packedManifest.name)) continue;
    for (const name of SINGLETON_PACKAGES) {
      if (packedManifest.dependencies?.[name] || packedManifest.optionalDependencies?.[name]) {
        throw new Error(
          `${packedManifest.name} lists ${name} as a regular dependency; declare it in peerDependencies`,
        );
      }
    }
  }

  await mkdir(npmConsumerDirectory);
  await writeFile(
    resolve(npmConsumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "ship-api-packed-npm-consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          [...artifacts.entries()].map(([name, { pack }]) => [name, `file:${pack.filename}`]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    npmConsumerDirectory,
  );
  run("npm", ["ls", "--all", ...SINGLETON_PACKAGES], npmConsumerDirectory, true);
  for (const name of SINGLETON_PACKAGES) {
    const copies = await findInstalledCopies(resolve(npmConsumerDirectory, "node_modules"), name);
    if (copies.length !== 1) {
      throw new Error(
        `npm installed ${copies.length} copies of ${name}; expected exactly one:\n  ${copies.join("\n  ")}`,
      );
    }
  }
}

async function findInstalledCopies(nodeModules, packageName) {
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const copies = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packageDirectories = entry.name.startsWith("@")
      ? (await readdir(resolve(nodeModules, entry.name), { withFileTypes: true }))
          .filter((scoped) => scoped.isDirectory())
          .map((scoped) => [
            `${entry.name}/${scoped.name}`,
            resolve(nodeModules, entry.name, scoped.name),
          ])
      : [[entry.name, resolve(nodeModules, entry.name)]];
    for (const [name, directory] of packageDirectories) {
      if (name === packageName) copies.push(directory);
      copies.push(...(await findInstalledCopies(resolve(directory, "node_modules"), packageName)));
    }
  }
  return copies;
}

function verifyArchiveSurface(pack, manifest) {
  const packedPaths = new Set(pack.files.map(({ path }) => path));
  const requiredPaths = new Set(["package.json"]);
  collectManifestTargets(manifest.main, requiredPaths);
  collectManifestTargets(manifest.types, requiredPaths);
  collectManifestTargets(manifest.bin, requiredPaths);
  collectManifestTargets(manifest.exports, requiredPaths);

  for (const requiredPath of requiredPaths) {
    if (!packedPaths.has(requiredPath)) {
      throw new Error(`${pack.name} archive is missing manifest target ${requiredPath}`);
    }
  }

  for (const path of packedPaths) {
    if (FORBIDDEN_FILE_PATTERN.test(path) && !isAssetSource(pack.name, path)) {
      throw new Error(`${pack.name} archive contains non-publishable test/build file ${path}`);
    }
    if (
      path.startsWith("src/") ||
      (path.endsWith(".ts") && !path.endsWith(".d.ts") && !isAssetSource(pack.name, path))
    ) {
      throw new Error(`${pack.name} archive contains non-asset TypeScript source ${path}`);
    }
  }
}

function collectManifestTargets(value, targets) {
  if (typeof value === "string") {
    if (value.startsWith("./") && !value.includes("*")) targets.add(value.slice(2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectManifestTargets(item, targets);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectManifestTargets(item, targets);
  }
}

function isAssetSource(packageName, path) {
  return (ASSET_SOURCE_ROOTS.get(packageName) ?? []).some((root) => path.startsWith(root));
}

async function createConsumer(artifacts) {
  await mkdir(consumerDirectory);
  const localPackages = Object.fromEntries(
    [...artifacts.entries()].map(([name, { pack }]) => [name, `file:${pack.filename}`]),
  );
  const rootManifest = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  await writeFile(
    resolve(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "ship-api-packed-consumer",
        private: true,
        type: "module",
        packageManager: rootManifest.packageManager,
        dependencies: localPackages,
        devDependencies: { typescript: rootManifest.devDependencies.typescript },
        pnpm: { overrides: localPackages },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(resolve(consumerDirectory, "index.mjs"), runtimeFixture());
  await writeFile(resolve(consumerDirectory, "ship.config.ts"), applicationFixture());
  await writeFile(resolve(consumerDirectory, "typecheck.ts"), typecheckFixture());
}

async function verifyInstalledDeclarations() {
  const contractDirectory = resolve(
    consumerDirectory,
    "node_modules/@sixthsummit/ship-contract/lib",
  );
  const browserDeclarations = `${await readFile(resolve(contractDirectory, "index.d.ts"), "utf8")}\n${await readFile(resolve(contractDirectory, "client.d.ts"), "utf8")}`;
  for (const forbidden of [
    "@sixthsummit/ship-core",
    'from "./project.js"',
    'from "./schema.js"',
    'from "./openapi.js"',
  ]) {
    if (browserDeclarations.includes(forbidden)) {
      throw new Error(`browser contract declarations leaked a server boundary: ${forbidden}`);
    }
  }
}

async function verifyCli(artifacts) {
  const cliPath = resolve(consumerDirectory, "node_modules/@sixthsummit/ship-cli/lib/bin.js");
  const check = JSON.parse(
    run(
      process.execPath,
      [cliPath, "check", "--format", "json", "--emit"],
      consumerDirectory,
      true,
    ),
  );
  const inspect = JSON.parse(
    run(
      process.execPath,
      [cliPath, "inspect", "operation", "packed.read", "--format", "json"],
      consumerDirectory,
      true,
    ),
  );
  const affected = JSON.parse(
    run(
      process.execPath,
      [cliPath, "affected", "module", "packed", "--format", "json"],
      consumerDirectory,
      true,
    ),
  );
  if (
    check.graph.appId !== "packed-consumer" ||
    inspect.node.id !== "packed.read" ||
    affected.affected.operations[0] !== "packed.read"
  ) {
    throw new Error("packed graph CLI returned an invalid projection");
  }

  const contractResult = JSON.parse(
    run(
      process.execPath,
      [
        cliPath,
        "contract",
        "--format",
        "json",
        "--openapi-title",
        "Packed consumer",
        "--api-version",
        "1.0.0",
      ],
      consumerDirectory,
      true,
    ),
  );
  const catalogPath = resolve(consumerDirectory, "legacy-routes.json");
  const mappingPath = resolve(consumerDirectory, "route-mapping.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify({
      schemaVersion: 1,
      applicationId: "packed-consumer",
      revision: "packed-candidate",
      routes: [{ id: "packed.routes:1", method: "GET", path: "/packed" }],
    })}\n`,
  );
  await writeFile(
    mappingPath,
    `${JSON.stringify({
      schemaVersion: 1,
      applicationId: "packed-consumer",
      catalogRevision: "packed-candidate",
      entries: [{ legacyRouteId: "packed.routes:1", operationId: "packed.read" }],
    })}\n`,
  );
  const migrationResult = JSON.parse(
    run(
      process.execPath,
      [
        cliPath,
        "migrate-routes",
        "--catalog",
        catalogPath,
        "--mapping",
        mappingPath,
        "--format",
        "json",
      ],
      consumerDirectory,
      true,
    ),
  );
  const emittedGraph = JSON.parse(
    await readFile(resolve(consumerDirectory, ".ship/graph.json"), "utf8"),
  );
  const emittedContract = JSON.parse(
    await readFile(resolve(consumerDirectory, ".ship/contract.json"), "utf8"),
  );
  const emittedOpenApi = JSON.parse(
    await readFile(resolve(consumerDirectory, ".ship/openapi.json"), "utf8"),
  );
  if (
    emittedGraph.appId !== "packed-consumer" ||
    contractResult.fingerprint !== emittedContract.fingerprint ||
    emittedOpenApi["x-ship-contract-fingerprint"] !== emittedContract.fingerprint ||
    migrationResult.routes !== 1 ||
    migrationResult.mapped !== 1
  ) {
    throw new Error("packed CLI emitted inconsistent graph or contract artifacts");
  }

  await verifyGeneratedApplication(cliPath, artifacts);
}

async function verifyGeneratedApplication(cliPath, artifacts) {
  const releaseManifest = JSON.parse(
    await readFile(
      resolve(consumerDirectory, "node_modules/@sixthsummit/ship-cli/lib/release-manifest.json"),
      "utf8",
    ),
  );
  for (const [packageName, version] of Object.entries(releaseManifest.packages)) {
    if (artifacts.get(packageName)?.pack.version !== version) {
      throw new Error(`scaffold release manifest is stale for ${packageName}@${version}`);
    }
  }

  run(process.execPath, [cliPath, "create", "generated-api", "--skip-install"], consumerDirectory);
  const generatedDirectory = resolve(consumerDirectory, "generated-api");
  const generatedManifestPath = resolve(generatedDirectory, "package.json");
  const generatedManifest = JSON.parse(await readFile(generatedManifestPath, "utf8"));
  const localPackages = Object.fromEntries(
    [...artifacts.entries()].map(([name, { pack }]) => [name, `file:${pack.filename}`]),
  );
  generatedManifest.dependencies = Object.fromEntries(
    Object.entries(generatedManifest.dependencies).map(([name, version]) => [
      name,
      localPackages[name] ?? version,
    ]),
  );
  generatedManifest.devDependencies = Object.fromEntries(
    Object.entries(generatedManifest.devDependencies).map(([name, version]) => [
      name,
      localPackages[name] ?? version,
    ]),
  );
  generatedManifest.pnpm = { overrides: localPackages };
  await writeFile(generatedManifestPath, `${JSON.stringify(generatedManifest, null, 2)}\n`);

  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], generatedDirectory);
  run("pnpm", ["run", "verify"], generatedDirectory);
}

function runtimeFixture() {
  return `import { firebaseBearerCredentials } from "@sixthsummit/ship-auth-firebase";
import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import { projectOpenApi } from "@sixthsummit/ship-contract/openapi";
import { projectClientContract } from "@sixthsummit/ship-contract/project";
import { contractSchema } from "@sixthsummit/ship-contract/schema";
import { defineRepositoryProjections, offsetPage, resolveOffsetPagination } from "@sixthsummit/ship-drizzle";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import { createExecutor, defineApp, defineModule, defineOperation, effectDependency, publicAccess, valueProvider } from "@sixthsummit/ship-core";
import { isOtelDisabledByEnv } from "@sixthsummit/ship-observability-otel/sdk";
import { runParityFixture } from "@sixthsummit/ship-testing/parity";
import { createApp } from "@sixthsummit/ship-api";
import { InMemorySlidingWindowBackend, RedisSlidingWindowBackend } from "@sixthsummit/ship-api/rate-limit";

const outputSchema = {
  "~standard": {
    version: 1,
    vendor: "pack-fixture",
    validate: (value) => value?.ok === true ? { value } : { issues: [{ message: "expected ok" }] },
  },
};
const recordedEffects = [];
const auditEffect = effectDependency("audit.record", { delivery: "immediate" });
const operation = defineOperation({
  id: "packed.read",
  transport: http.get("/packed"),
  input: {},
  output: { 200: contractSchema(outputSchema, { jsonSchema: { type: "object", required: ["ok"], properties: { ok: { const: true } } } }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: { audit: auditEffect },
  effects: [auditEffect],
  handler: async ({ services }) => {
    await services.audit.record("packed.read");
    return { ok: true };
  },
});
const module = defineModule({
  id: "packed",
  operations: [operation],
  providers: [valueProvider(auditEffect, { record: async (operationId) => recordedEffects.push(operationId) })],
  imports: [],
  exports: [],
});
const application = defineApp({ id: "packed-consumer", modules: [module] });
const executor = createExecutor(application);
const result = await executor.run("packed.read", {});
const adapter = createHonoAdapter(application);
const response = await adapter.request("/packed");
const contract = projectClientContract(application);
const openapi = projectOpenApi(application, { title: "Pack smoke", version: "1" });
const client = createHttpOperationClient(contract, {
  baseUrl: "https://api.example.test",
  fetch: (input, init) => adapter.request(input, init),
});
const remote = await client.call("packed.read", {});

const projection = defineRepositoryProjections({ summary: (id) => ({ id }) });
const page = offsetPage([projection.run("summary", "record-1")], 1, resolveOffsetPagination({ limit: 1 }));
const credential = await firebaseBearerCredentials().extract(new Request("https://api.test", { headers: { authorization: "Bearer packed-token" } }));
const parity = await runParityFixture(adapter, {
  id: "packed-parity",
  metadata: { area: "pack", surface: "generated route", source: "v4-conformance" },
  request: { method: "GET", path: "/packed" },
  checks: [{ path: "status", equals: 200 }, { path: "body.ok", equals: true }],
});
const legacy = createApp();
legacy.get("/legacy", (context) => context.json({ ok: true }));
const legacyResponse = await legacy.request("/legacy");
const redisRateLimit = new RedisSlidingWindowBackend({
  client: { eval: async () => [1, 1, 5, 1_060_000] },
  keyPrefix: "packed:",
});
const redisVerdict = await redisRateLimit.check({ key: "actor:1", windowMs: 60_000, max: 5, now: 1_000_000 });
const memoryVerdict = await new InMemorySlidingWindowBackend().check({ key: "actor:1", windowMs: 60_000, max: 5, now: 1_000_000 });

if (
  !result.ok || result.data.ok !== true ||
  response.status !== 200 || !remote.ok || remote.data.ok !== true ||
  openapi["x-ship-contract-fingerprint"] !== contract.fingerprint ||
  page.items[0]?.id !== "record-1" || credential?.token !== "packed-token" ||
  typeof isOtelDisabledByEnv !== "function" || !parity.passed || legacyResponse.status !== 200 ||
  recordedEffects.join(",") !== "packed.read,packed.read,packed.read,packed.read" ||
  application.graph.operations[0].effects[0]?.id !== "audit.record" ||
  !redisVerdict.allowed || redisVerdict.resetAtMs !== 1_060_000 ||
  !memoryVerdict.allowed || memoryVerdict.used !== 1
) throw new Error("packed package graph runtime smoke failed");
`;
}

function applicationFixture() {
  return `import { contractSchema } from "@sixthsummit/ship-contract/schema";
import { http } from "@sixthsummit/ship-hono";
import { defineApp, defineModule, defineOperation, publicAccess, type RuntimeSchema } from "@sixthsummit/ship-core";

const schema: RuntimeSchema<unknown, { readonly ok: true }> = {
  "~standard": {
    version: 1 as const,
    vendor: "pack-graph-fixture",
    validate: (value: unknown) => typeof value === "object" && value !== null && Reflect.get(value, "ok") === true
      ? { value: { ok: true as const } }
      : { issues: [{ message: "expected object with ok" }] },
  },
};
const operation = defineOperation({
  id: "packed.read",
  transport: http.get("/packed"),
  input: {},
  output: { 200: contractSchema(schema, { jsonSchema: { type: "object", required: ["ok"], properties: { ok: { const: true } } } }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => ({ ok: true }),
});
const module = defineModule({ id: "packed", operations: [operation], providers: [], imports: [], exports: [] });
export const app = defineApp({ id: "packed-consumer", modules: [module] });
`;
}

function typecheckFixture() {
  return `import { type ClientContract, createHttpOperationClient } from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import type { GraphCliDiagnostic } from "@sixthsummit/ship-cli/graph";
import { RedisSlidingWindowBackend, type RateLimitBackend, type RedisEvalClient, type RedisSlidingWindowBackendOptions } from "@sixthsummit/ship-api/rate-limit";
import contract from "./.ship/contract.json" with { type: "json" };
import type { app } from "./ship.config.js";

const diagnostic: GraphCliDiagnostic = { code: "TEST", severity: "error", message: "test", hint: "test" };
const redisClient: RedisEvalClient = { eval: async () => [1, 1, 5, 1_060_000] };
const redisOptions: RedisSlidingWindowBackendOptions = { client: redisClient };
const limiter: RateLimitBackend = new RedisSlidingWindowBackend(redisOptions);
const client = createHttpOperationClient<ApplicationContractOf<typeof app>>(contract as ClientContract, { baseUrl: "https://api.example.test" });
async function verify(): Promise<void> {
  const verdict = await limiter.check({ key: "actor:1", windowMs: 60_000, max: 5, now: 1_000_000 });
  verdict.allowed satisfies boolean;
  const result = await client.call("packed.read", {});
  if (result.ok) result.data.ok satisfies true;
  // @ts-expect-error operation ids remain exact across the packed boundary
  await client.call("packed.missing", {});
  // @ts-expect-error empty-input operations reject invented locations
  await client.call("packed.read", { body: {} });
}
void diagnostic;
void verify;
`;
}
