import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { manifests, REGISTRY } from "./plan.mjs";

export function validateArtifact(pkg, entry) {
  assert.equal(pkg.name, entry.name, "Artifact package name does not match plan");
  assert.equal(pkg.version, entry.version, "Artifact version does not match plan");
  assert.equal(pkg.publishConfig?.registry, REGISTRY);
  assert.equal(pkg.publishConfig?.access, "public");
  assert.equal(entry.access, "public");
  assert(["alpha", "latest"].includes(entry.tag));
  assert.equal(entry.tag === "alpha", pkg.version.includes("-alpha-"), "Tag/version mismatch");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const range of Object.values(pkg[field] ?? {}))
      assert(!/^(workspace:|file:|link:)/.test(range), `Unresolved dependency: ${range}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const publish = process.argv.includes("--publish");
  const plan = JSON.parse(readFileSync(".release/publish-plan.json", "utf8"));
  const packages = new Map(manifests().map((pkg) => [pkg.name, pkg]));
  const entries = plan.plan.flat();
  if (!publish && entries.length) {
    for (const entry of entries) {
      const pkg = packages.get(entry.name);
      assert(pkg && pkg.version === entry.version, "Source manifest changed after planning");
    }
    execFileSync(
      "pnpm",
      ["exec", "turbo", "run", "build", ...entries.map((entry) => `--filter=${entry.name}...`)],
      { stdio: "inherit" },
    );
    execFileSync(
      "pnpm",
      [
        "exec",
        "changeset",
        "pack",
        "--from-publish-plan",
        ".release/publish-plan.json",
        "--out-dir",
        ".release/artifacts",
      ],
      { stdio: "inherit" },
    );
  }
  if (!entries.length) process.exit(0);
  const directory = resolve(".release/artifacts");
  const packed = JSON.parse(readFileSync(`${directory}/publish-plan.json`, "utf8"));
  assert.equal(packed.version, 1);
  const artifacts = packed.plan.flat();
  assert.deepEqual(
    artifacts.map(({ tarball: _tarball, ...entry }) => entry),
    entries,
    "Packed plan differs from reviewed selection",
  );
  // Validate the entire set before publishing anything.
  for (const entry of artifacts) {
    const archive = resolve(directory, entry.tarball.path);
    const path = relative(directory, archive);
    assert(path && !path.startsWith("..") && !isAbsolute(path), "Archive escapes output directory");
    const digest = `sha256-${createHash("sha256").update(readFileSync(archive)).digest("base64")}`;
    assert.equal(digest, entry.tarball.integrity, "Archive integrity mismatch");
    const pkg = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    validateArtifact(pkg, entry);
  }
  if (publish) {
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "Automated publishing runs only in GitHub Actions",
    );
    for (const entry of artifacts)
      execFileSync(
        "npm",
        [
          "publish",
          resolve(directory, entry.tarball.path),
          "--registry",
          REGISTRY,
          "--access",
          "public",
          "--tag",
          entry.tag,
          "--provenance",
          "--ignore-scripts",
        ],
        { stdio: "inherit" },
      );
  } else writeFileSync(".release/verified.json", `${JSON.stringify(artifacts, null, 2)}\n`);
}
