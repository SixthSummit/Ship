#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const edgeDirectory = resolve(repoRoot, "scripts/edge-smoke");
const result = spawnSync(
  "pnpm",
  ["exec", "wrangler", "deploy", "--dry-run", "--outdir", "tmp/wrangler-out"],
  {
    cwd: edgeDirectory,
    env: {
      ...process.env,
      CI: "true",
      WRANGLER_LOG_PATH: resolve(edgeDirectory, "tmp/wrangler.log"),
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const outputDirectory = resolve(edgeDirectory, "tmp/wrangler-out");
const sourceMapName = (await readdir(outputDirectory)).find((name) => name.endsWith(".js.map"));
if (!sourceMapName) throw new Error("edge smoke did not emit a JavaScript source map");
const sourceMap = JSON.parse(await readFile(resolve(outputDirectory, sourceMapName), "utf8"));
const sources = sourceMap.sources.join("\n");
for (const requiredSource of [
  "packages/contract/src/client.ts",
  "packages/kernel/src/executor.ts",
  "packages/hono/src/adapter.ts",
]) {
  if (!sources.includes(requiredSource)) {
    throw new Error(`edge smoke did not bundle required source: ${requiredSource}`);
  }
}
for (const forbidden of [
  "packages/core/src/kernel/",
  "packages/core/src/hono/",
  "packages/core/src/contract/",
  "packages/contract/src/project.ts",
  "packages/contract/src/openapi.ts",
  "packages/contract/src/schema.ts",
  "/node_modules/.pnpm/zod@",
  "node:crypto",
]) {
  if (sources.includes(forbidden)) {
    throw new Error(
      `browser contract entry leaked build-time source into edge bundle: ${forbidden}`,
    );
  }
}
