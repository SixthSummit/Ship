import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("repository workflow policy", () => {
  it("hard-gates only the published framework runtime in pull request CI", async () => {
    const packageJson = JSON.parse(await readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const runtimeConfig = JSON.parse(await readRepoFile(".audit-ci.runtime.json")) as {
      "skip-dev": boolean;
      allowlist: string[];
      "package-manager": string;
    };
    const ci = await readRepoFile(".github/workflows/ci.yml");

    expect(packageJson.scripts.audit).toBe("pnpm run audit:runtime");
    expect(runtimeConfig["skip-dev"]).toBe(true);
    expect(runtimeConfig.allowlist).toEqual([]);
    expect(runtimeConfig["package-manager"]).toBe("pnpm");
    expect(ci).toContain("name: Runtime Dependency Security");
    expect(ci).toContain("run: pnpm run audit:runtime");
  });

  it("pins pnpm and uses one workspace lockfile in every dependency workflow", async () => {
    const packageJson = JSON.parse(await readRepoFile("package.json")) as {
      packageManager?: string;
    };
    const workspace = await readRepoFile("pnpm-workspace.yaml");

    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(workspace).toContain('"packages/*"');
    expect(workspace).toContain('"apps/*"');

    for (const workflowPath of [
      ".github/workflows/ci.yml",
      ".github/workflows/security.yml",
      ".github/workflows/dependency-update.yml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = await readRepoFile(workflowPath);
      expect(workflow).toContain("pnpm install --frozen-lockfile");
      expect(workflow).not.toContain("npm ci");
      expect(workflow).not.toContain('cache: "npm"');
    }
  });

  it("audits each deployable trust zone from an isolated production manifest", async () => {
    const packageJson = JSON.parse(await readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const auditScript = await readRepoFile("scripts/audit-package.mjs");

    expect(packageJson.scripts["audit:runtime"]).toContain("packages/core");
    expect(packageJson.scripts["audit:docs"]).toContain("apps/docs");
    expect(auditScript).toContain("resolveWorkspaceClosure(sourceManifest, workspaceManifests)");
    expect(auditScript).toContain('dependencies: { [sourceManifest.name]: "workspace:*" }');
    expect(auditScript).toContain("manifest.optionalDependencies");
    expect(auditScript).toContain('"--lockfile-only", "--prod", "--ignore-scripts"');
    expect(auditScript).toContain('process.env.SHIP_API_AUDIT_TIMEOUT_MS ?? "120000"');
    expect(auditScript).toContain("process.kill(-child.pid, signal)");
    expect(auditScript).toContain("process.exitCode = 124");
    expect(auditScript).not.toContain("sourceManifest.devDependencies");
  });

  it("keeps every behavioral CI job in the required summary", async () => {
    const ci = await readRepoFile(".github/workflows/ci.yml");

    const summary = ci.slice(ci.indexOf("  ci-summary:"));
    const needs = summary.match(/needs:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    for (const job of [
      "integration-tests",
      "package-smoke",
      "edge-smoke",
      "docs-site",
      "skills-sync",
      "runtime-security",
      "angular",
    ]) {
      expect(ci).toContain(job);
      expect(needs.split(",").map((value) => value.trim())).toContain(job);
    }
  });

  it("fails the summary for unsuccessful jobs and only permits explicitly absent migrations", async () => {
    const ci = await readRepoFile(".github/workflows/ci.yml");
    const summary = ci.slice(ci.indexOf("  ci-summary:"));
    const script = summary.match(/<<'NODE'\n([\s\S]*?)\n\s+NODE/)?.[1];
    expect(script).toBeDefined();
    const run = (result: string, hasMigrations = "false", migrationResult = "skipped") =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script!], {
        env: {
          ...process.env,
          JOB_RESULTS: JSON.stringify({
            test: { result },
            "check-migrations": { result: "success", outputs: { "has-migrations": hasMigrations } },
            "migration-check": { result: migrationResult },
          }),
        },
      }).status;
    expect(run("success")).toBe(0);
    expect(run("success", "true", "success")).toBe(0);
    for (const result of ["failure", "cancelled", "skipped"]) expect(run(result)).toBe(1);
    expect(run("success", "true")).toBe(1);
    expect(run("success", "false", "failure")).toBe(1);
  });

  it("uses Biome as the primary check and keeps architecture rules executable", async () => {
    const packageJson = JSON.parse(await readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const ci = await readRepoFile(".github/workflows/ci.yml");

    expect(packageJson.scripts["api:check"]).toBe("biome check . && pnpm run lint:architecture");
    expect(packageJson.scripts["lint:architecture"]).toBe("eslint .");
    expect(packageJson.scripts["verify:fast"]).toContain("pnpm run api:test --changed");
    expect(packageJson.scripts["api:verify"]).toContain("pnpm run test:pack");
    expect(ci).toContain("run: pnpm run check");
    expect(ci).toContain("run: pnpm run test:pack");
    expect(ci).not.toContain("pnpm exec prettier");
  });

  it("does not call the disabled Issues API from dependency automation", async () => {
    const workflow = await readRepoFile(".github/workflows/dependency-update.yml");

    expect(workflow).not.toContain("github.rest.issues");
    expect(workflow).not.toContain("Create Update Issue");
  });

  it("allows a remediation PR after audit fix reports residual findings", async () => {
    const workflow = await readRepoFile(".github/workflows/dependency-update.yml");
    const fixIndex = workflow.indexOf("name: Apply pnpm audit overrides");
    const reportIndex = workflow.indexOf("name: Report remaining runtime findings");
    const prIndex = workflow.indexOf("name: Create PR if lockfile changed");

    expect(fixIndex).toBeGreaterThan(-1);
    expect(workflow.slice(fixIndex, reportIndex)).toContain("continue-on-error: true");
    expect(workflow.slice(reportIndex, prIndex)).toContain("continue-on-error: true");
    expect(prIndex).toBeGreaterThan(reportIndex);
  });

  it("separates runtime, docs, and tooling scans without a decorative license job", async () => {
    const workflow = await readRepoFile(".github/workflows/security.yml");

    expect(workflow).toContain("runtime-dependency-scan:");
    expect(workflow).toContain("docs-dependency-scan:");
    expect(workflow).toContain("tooling-dependency-scan:");
    expect(workflow).not.toContain("SLACK_SECURITY_WEBHOOK_URL");
    expect(workflow).not.toContain("License Compliance");
    expect(workflow).not.toContain("|| true");
  });
});
