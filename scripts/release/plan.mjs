import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getReleasePlan } from "@changesets/get-release-plan";
import { classifyChanges } from "../ci/plan.mjs";
import { changelogEntry } from "./notes.mjs";

export const REGISTRY = "https://registry.npmjs.org";
export function manifests() {
  return readdirSync("packages")
    .map((directory) => {
      const path = `packages/${directory}`;
      return { ...JSON.parse(readFileSync(`${path}/package.json`, "utf8")), path };
    })
    .filter((pkg) => !pkg.private);
}
export function selectReleases(packages, registry, { channel, bootstrap = false, changed = [] }) {
  assert(["alpha", "latest"].includes(channel), "Invalid release channel");
  const changedSet = new Set(changed);
  return packages.filter((pkg) => {
    if (channel === "alpha" && !changedSet.has(pkg.name)) return false;
    assert.equal(pkg.publishConfig?.registry, REGISTRY, pkg.name);
    assert.equal(pkg.publishConfig?.access, "public", pkg.name);
    assert(
      !pkg.version.includes("-") || channel === "alpha",
      "Stable release cannot contain prerelease versions",
    );
    assert(
      channel !== "alpha" || pkg.version.includes("-alpha-"),
      "Alpha must have a snapshot version",
    );
    const existing = registry.get(pkg.name);
    assert(existing !== undefined, `Missing registry response for ${pkg.name}`);
    if (existing === null)
      assert(
        bootstrap,
        `${pkg.name} has never been published to npm; first publication requires bootstrap=true`,
      );
    return !existing?.versions?.[pkg.version];
  });
}
export function validateDependencies(selected, packages, registry) {
  const releasing = new Set(selected.map((pkg) => pkg.name));
  const local = new Map(packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of selected) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (!local.has(name) || releasing.has(name)) continue;
        const version = local.get(name).version;
        assert(
          registry.get(name)?.versions?.[version],
          `${pkg.name} requires local ${name}@${version}, which is absent from npm and the release plan`,
        );
      }
    }
  }
}
export function publishPlan(selected, channel) {
  const remaining = new Map(selected.map((pkg) => [pkg.name, pkg]));
  const plan = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(
      (pkg) =>
        !Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).some((name) =>
          remaining.has(name),
        ),
    );
    assert(ready.length, "Runtime dependency cycle in release plan");
    plan.push(
      ready.map((pkg) => ({
        kind: "publish",
        name: pkg.name,
        version: pkg.version,
        access: "public",
        tag: channel,
      })),
    );
    for (const pkg of ready) remaining.delete(pkg.name);
  }
  return { version: 1, plan };
}
export async function registryMetadata(packages) {
  return new Map(
    await Promise.all(
      packages.map(async ({ name }) => {
        const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 404) return [name, null];
        assert(response.ok, `npm metadata request failed for ${name}: ${response.status}`);
        return [name, await response.json()];
      }),
    ),
  );
}
const run = (args) => execFileSync("pnpm", args, { stdio: "inherit" });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const channel = process.env.RELEASE_CHANNEL ?? "latest";
  const bootstrap = process.env.RELEASE_BOOTSTRAP === "true";
  assert(["alpha", "latest"].includes(channel));
  mkdirSync(".release", { recursive: true });
  const before = manifests();
  const status = await getReleasePlan(process.cwd());
  writeFileSync(".release/status.json", `${JSON.stringify(status, null, 2)}\n`);
  if (channel === "alpha") {
    if (bootstrap)
      writeFileSync(
        ".changeset/npm-bootstrap.md",
        `---\n${before.map((pkg) => `"${pkg.name}": patch`).join("\n")}\n---\n\nInitial npm snapshot bootstrap.\n`,
      );
    // Refresh status after the explicitly requested bootstrap additions.
    writeFileSync(
      ".release/status.json",
      `${JSON.stringify(await getReleasePlan(process.cwd()), null, 2)}\n`,
    );
    execFileSync(process.execPath, ["scripts/snapshot-dependents.mjs", ".release/status.json"], {
      stdio: "inherit",
    });
    run(["exec", "changeset", "version", "--snapshot", "alpha"]);
    run(["--filter", "ship-angular", "sync-version"]);
    // Changesets emits Markdown that differs from Angular's enforced formatting.
    run([
      "--filter",
      "ship-angular",
      "exec",
      "prettier",
      "--write",
      "../packages/angular/CHANGELOG.md",
    ]);
  } else
    assert.equal(
      status.changesets.length,
      0,
      "Version pending changesets in a reviewed stable version PR first",
    );
  const packages = manifests();
  const registry = await registryMetadata(packages);
  const changed = packages
    .filter((pkg) => before.find((old) => old.name === pkg.name).version !== pkg.version)
    .map((pkg) => pkg.name);
  const selected = selectReleases(packages, registry, { channel, bootstrap, changed });
  validateDependencies(selected, packages, registry);
  writeFileSync(
    ".release/publish-plan.json",
    `${JSON.stringify(publishPlan(selected, channel), null, 2)}\n`,
  );
  const checks = classifyChanges(selected.map((pkg) => `${pkg.path}/package.json`));
  const outputs = { ...checks, count: selected.length };
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(outputs))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  const summary =
    selected.map((pkg) => `- ${pkg.name}@${pkg.version} (${channel})`).join("\n") ||
    "Nothing to publish.";
  console.log(summary);
  const notes = !selected.length
    ? ""
    : channel === "alpha"
      ? status.changesets.map((entry) => `### ${entry.id}\n\n${entry.summary}`).join("\n\n")
      : selected
          .map(
            (pkg) =>
              `### ${pkg.name}@${pkg.version}\n\n${changelogEntry(readFileSync(`${pkg.path}/CHANGELOG.md`, "utf8"), pkg.version)}`,
          )
          .join("\n\n");
  const review = `## Exact npm publication plan\n\n${summary}\n\n${notes}\n`;
  writeFileSync(".release/review.md", review);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, review);
}
