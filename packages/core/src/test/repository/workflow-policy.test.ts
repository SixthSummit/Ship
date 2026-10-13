import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFile(resolve(repoRoot, path), "utf8");

describe("repository workflow policy", () => {
  it("retains every required API gate in the selected framework job", async () => {
    const { scripts } = JSON.parse(await read("package.json"));
    for (const gate of [
      "api:check",
      "check:skills",
      "api:type-check",
      "api:test:coverage",
      "test:parity",
      "vitest.integration.config.ts",
      "test:edge",
      "test:pack",
      "test:consumer:minimal",
      "test:consumer:customized",
      "audit:runtime",
    ]) {
      expect(scripts["ci:api"]).toContain(gate);
    }
    expect(scripts["ci:angular"]).toContain("build-joint-conformance.mjs");
    expect(scripts["ci:angular"]).toContain("--filter ship-angular run ci");
  });
  it("requires a successful detection job and includes all selected jobs in the stable summary", async () => {
    const ci = await read(".github/workflows/ci.yml");
    expect(ci).toContain("fetch-depth: 0");
    expect(ci).toContain("github.event.pull_request.base.sha || github.event.before");
    expect(ci).toContain("needs: [plan, api, angular, api-docs, angular-docs]");
    expect(ci).toContain("if: always()");
    expect(ci).toContain("node scripts/ci/summary.mjs");
    expect(ci).toContain("node scripts/ci/release-preview.mjs");
    expect(ci).not.toContain("paths-ignore:");
  });
  it("uses frozen installs and does not give pull requests publish permissions", async () => {
    for (const name of ["ci", "security", "dependency-update", "release"]) {
      expect(await read(`.github/workflows/${name}.yml`)).toContain(
        "pnpm install --frozen-lockfile",
      );
    }
    const ci = await read(".github/workflows/ci.yml");
    expect(ci).not.toContain("id-token: write");
    expect(ci).not.toContain("packages: write");
    const release = await read(".github/workflows/release.yml");
    expect(release).toContain("vars.SHIP_PUBLISH_ENABLED == 'true'");
    expect(release).toContain("id-token: write");
    expect(release).not.toContain("pull_request:");
    expect(release).not.toContain("npm.pkg.github.com");
  });
  it("does not retain advisory allowlists for dependencies that have been patched", async () => {
    for (const name of [".audit-ci.json", ".audit-ci.runtime.json"]) {
      expect(JSON.parse(await read(name)).allowlist).toEqual([]);
    }
  });
});
