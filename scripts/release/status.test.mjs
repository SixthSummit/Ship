import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReleasePlan } from "@changesets/get-release-plan";
import { afterEach, expect, it } from "vitest";

const directories = [];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ship-release-status-"));
  directories.push(cwd);
  mkdirSync(join(cwd, ".changeset"));
  mkdirSync(join(cwd, "packages/example"), { recursive: true });
  writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }),
  );
  writeFileSync(
    join(cwd, "packages/example/package.json"),
    JSON.stringify({ name: "example", version: "1.0.0" }),
  );
  writeFileSync(
    join(cwd, ".changeset/config.json"),
    JSON.stringify({ baseBranch: "dev", access: "public" }),
  );
  return cwd;
}
afterEach(() => {
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});
it("accepts a consumed or documentation-only release plan without requiring a changeset", async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, "packages/example/README.md"), "Updated documentation.");
  const plan = await getReleasePlan(cwd);
  expect(plan.changesets).toEqual([]);
  expect(plan.releases).toEqual([]);
});
it("aggregates all pending entries and keeps their bump reasons visible", async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, ".changeset/patch.md"), '---\n"example": patch\n---\n\nFix a bug.\n');
  writeFileSync(join(cwd, ".changeset/minor.md"), '---\n"example": minor\n---\n\nAdd a feature.\n');
  const plan = await getReleasePlan(cwd);
  expect(plan.releases).toHaveLength(1);
  expect(plan.releases[0]).toMatchObject({
    name: "example",
    type: "minor",
    oldVersion: "1.0.0",
    newVersion: "1.1.0",
  });
  expect(plan.releases[0].changesets.sort()).toEqual(["minor", "patch"]);
});
