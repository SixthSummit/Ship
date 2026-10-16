import { createHash } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";

export const SHIP_API_PACKAGE_DIRECTORIES = Object.freeze([
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
  "jobs-bullmq",
  "mcp-server",
  "claude-plugin",
  "core",
]);

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function createCandidateManifest(packageEntries) {
  const packages = {};
  for (const entry of [...packageEntries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (packages[entry.name]) throw new Error(`duplicate candidate package ${entry.name}`);
    packages[entry.name] = structuredClone(entry);
  }

  const candidate = {
    schemaVersion: 1,
    kind: "ship-framework-candidate",
    packages,
  };
  validateCandidateManifest(candidate);
  return Object.freeze({
    ...candidate,
    fingerprint: candidateFingerprint(candidate),
  });
}

export function candidateFingerprint(candidate) {
  return `sha256:${createHash("sha256")
    .update(`${JSON.stringify(candidate)}\n`)
    .digest("hex")}`;
}

export function validateCandidateManifest(candidate) {
  if (candidate?.schemaVersion !== 1 || candidate?.kind !== "ship-framework-candidate") {
    throw new Error("candidate manifest must use ship-framework-candidate schema version 1");
  }
  if (!candidate.packages || typeof candidate.packages !== "object") {
    throw new Error("candidate manifest must declare packages");
  }

  const names = Object.keys(candidate.packages);
  if (names.length === 0) throw new Error("candidate manifest must contain at least one package");
  if (names.some((name, index) => index > 0 && names[index - 1].localeCompare(name) >= 0)) {
    throw new Error("candidate manifest packages must be sorted by name");
  }

  for (const [name, entry] of Object.entries(candidate.packages)) {
    if (entry?.name !== name || typeof entry.version !== "string" || entry.version.length === 0) {
      throw new Error(`candidate package ${name} has an invalid identity`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 1) {
      throw new Error(`candidate package ${name} has an invalid byte size`);
    }
    if (!SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`candidate package ${name} has an invalid SHA-256 identity`);
    }
    assertPortableArchivePath(entry.archive, name);
    if (
      typeof entry.source?.repository !== "string" ||
      entry.source.repository.length === 0 ||
      typeof entry.source.commit !== "string" ||
      !/^[a-f0-9]{40}$/u.test(entry.source.commit) ||
      typeof entry.source.packagePath !== "string" ||
      entry.source.packagePath.length === 0
    ) {
      throw new Error(`candidate package ${name} has invalid source provenance`);
    }
  }

  if (candidate.fingerprint !== undefined) {
    if (!SHA256_PATTERN.test(candidate.fingerprint)) {
      throw new Error("candidate manifest has an invalid fingerprint");
    }
    const { fingerprint: _fingerprint, ...unsigned } = candidate;
    if (candidateFingerprint(unsigned) !== candidate.fingerprint) {
      throw new Error("candidate manifest fingerprint does not match its contents");
    }
  }

  return candidate;
}

export function parseCandidateArguments(arguments_) {
  const additionalPackages = [];
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--output") {
      output = arguments_[index + 1];
      index += 1;
    } else if (argument === "--package") {
      additionalPackages.push(arguments_[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown candidate option ${argument}`);
    }
  }
  if (!output) {
    throw new Error(
      "usage: pnpm candidate:pack -- --output <new-directory> [--package <package-directory>]",
    );
  }
  if (additionalPackages.some((directory) => !directory)) {
    throw new Error("--package requires a package directory");
  }
  return { output, additionalPackages };
}

function assertPortableArchivePath(value, packageName) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw new Error(`candidate package ${packageName} has an invalid archive path`);
  }
  const normalized = normalize(value);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`)
  ) {
    throw new Error(`candidate package ${packageName} archive escapes the candidate directory`);
  }
}
