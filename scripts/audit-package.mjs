#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const [packagePath, configPath] = process.argv.slice(2);
const auditTimeoutMs = Number.parseInt(process.env.SHIP_API_AUDIT_TIMEOUT_MS ?? "120000", 10);

if (!packagePath || !configPath) {
  console.error("usage: audit-package <workspace-path> <audit-ci-config>");
  process.exit(2);
}

if (!Number.isSafeInteger(auditTimeoutMs) || auditTimeoutMs <= 0) {
  console.error("SHIP_API_AUDIT_TIMEOUT_MS must be a positive integer");
  process.exit(2);
}

function resolveInsideRepo(path) {
  const resolved = resolve(repoRoot, path);
  const fromRoot = relative(repoRoot, resolved);

  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`audit input must be a file or directory inside the repository: ${path}`);
  }

  return resolved;
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: "true" },
    stdio: "inherit",
    timeout: options.timeoutMs,
  });

  if (result.error?.code === "ETIMEDOUT") {
    console.error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`);
    process.exitCode = 124;
    return false;
  }

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;

  return result.status === 0;
}

function runWithTimeout(command, args, cwd, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      detached,
      env: { ...process.env, CI: "true" },
      stdio: "inherit",
    });

    let timedOut = false;
    let forceKillTimer;

    const kill = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") reject(error);
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });

    child.once("close", (status) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (timedOut) {
        process.exitCode = 124;
        resolvePromise(false);
        return;
      }

      if (status !== 0) process.exitCode = status ?? 1;
      resolvePromise(status === 0);
    });
  });
}

const packageFile = resolve(resolveInsideRepo(packagePath), "package.json");
const auditConfig = resolveInsideRepo(configPath);
const rootManifest = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const sourceManifest = JSON.parse(await readFile(packageFile, "utf8"));
const auditDirectory = await mkdtemp(resolve(tmpdir(), "ship-api-package-audit-"));
const workspaceManifests = await readWorkspaceManifests();
const workspaceClosure = resolveWorkspaceClosure(sourceManifest, workspaceManifests);

const auditManifest = {
  name: `ship-api-audit-${basename(resolve(repoRoot, packagePath))}`,
  version: "0.0.0",
  private: true,
  packageManager: rootManifest.packageManager,
  dependencies: { [sourceManifest.name]: "workspace:*" },
  pnpm: {
    overrides: rootManifest.pnpm?.overrides ?? {},
  },
};

try {
  const workspaceDirectory = resolve(auditDirectory, "workspaces");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    resolve(auditDirectory, "pnpm-workspace.yaml"),
    'packages:\n  - "workspaces/*"\n',
  );
  await writeFile(
    resolve(auditDirectory, "package.json"),
    `${JSON.stringify(auditManifest, null, 2)}\n`,
  );
  for (const manifest of workspaceClosure) {
    const target = resolve(workspaceDirectory, workspaceDirectoryName(manifest.name));
    await mkdir(target, { recursive: true });
    await writeFile(
      resolve(target, "package.json"),
      `${JSON.stringify(auditWorkspaceManifest(manifest), null, 2)}\n`,
    );
  }

  const installed = run(
    "pnpm",
    ["--dir", auditDirectory, "install", "--lockfile-only", "--prod", "--ignore-scripts"],
    repoRoot,
  );

  if (installed) {
    await runWithTimeout(
      "pnpm",
      ["exec", "audit-ci", "--directory", auditDirectory, "--config", auditConfig],
      repoRoot,
      auditTimeoutMs,
    );
  }
} finally {
  await rm(auditDirectory, { recursive: true, force: true });
}

async function readWorkspaceManifests() {
  const manifests = new Map();
  for (const parent of ["packages", "apps"]) {
    const parentPath = resolve(repoRoot, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          await readFile(resolve(parentPath, entry.name, "package.json"), "utf8"),
        );
        if (typeof manifest.name === "string") manifests.set(manifest.name, manifest);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return manifests;
}

function resolveWorkspaceClosure(target, manifests) {
  const closure = new Map();
  const pending = [target];
  while (pending.length > 0) {
    const manifest = pending.pop();
    if (closure.has(manifest.name)) continue;
    closure.set(manifest.name, manifest);
    for (const [name, range] of productionDependencies(manifest)) {
      if (!String(range).startsWith("workspace:")) continue;
      const dependency = manifests.get(name);
      if (!dependency) throw new Error(`workspace dependency ${name} is not present in the repo`);
      pending.push(dependency);
    }
  }
  return [...closure.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function productionDependencies(manifest) {
  return Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  });
}

function auditWorkspaceManifest(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    private: manifest.private === true,
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
  };
}

function workspaceDirectoryName(name) {
  return name.replace(/^@/u, "").replaceAll("/", "--");
}
