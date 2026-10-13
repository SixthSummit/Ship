import { describe, expect, it } from "vitest";
import { changedPaths, classifyChanges } from "./plan.mjs";
import { verifyResults } from "./summary.mjs";

describe("selective CI", () => {
  it("isolates framework and documentation changes", () => {
    expect(classifyChanges(["packages/angular/query/src/read.ts"])).toEqual({
      api: false,
      angular: true,
      apiDocs: false,
      angularDocs: false,
    });
    expect(classifyChanges(["packages/cache-redis/src/cache.ts"])).toEqual({
      api: true,
      angular: false,
      apiDocs: false,
      angularDocs: false,
    });
    expect(classifyChanges(["angular/docs/README.md"])).toEqual({
      api: false,
      angular: false,
      apiDocs: false,
      angularDocs: true,
    });
  });
  it("runs both frameworks for shared contracts and all checks for unknown/shared tooling", () => {
    for (const path of [
      "packages/contract/src/index.ts",
      "packages/hono/src/adapter.ts",
      "fixtures/joint-conformance/app.ts",
    ]) {
      expect(classifyChanges([path])).toMatchObject({ api: true, angular: true });
    }
    for (const path of ["pnpm-lock.yaml", ".github/workflows/ci.yml", "new-config.json"]) {
      expect(Object.values(classifyChanges([path])).every(Boolean)).toBe(true);
    }
  });
  it("does not mistake shipped templates or deleted code for documentation-only work", () => {
    expect(classifyChanges(["packages/core/templates/default/README.md"]).api).toBe(true);
    expect(classifyChanges(["packages/angular/templates/default/README.md"]).angular).toBe(true);
    expect(classifyChanges(["packages/core/src/deleted.ts"]).api).toBe(true);
    expect(changedPaths("0".repeat(40)).full).toBe(true);
    expect(changedPaths("nonexistent-ci-reference").full).toBe(true);
  });
  it("checks the whole PR rather than only its last commit", () => {
    expect(
      classifyChanges(["packages/core/src/first.ts", "packages/angular/src/second.ts"]),
    ).toMatchObject({ api: true, angular: true });
  });
  it("only permits jobs explicitly excluded by a successful plan to skip", () => {
    const jobs = {
      plan: {
        result: "success",
        outputs: { api: "true", angular: "false", apiDocs: "false", angularDocs: "false" },
      },
      api: { result: "success" },
      angular: { result: "skipped" },
      "api-docs": { result: "skipped" },
      "angular-docs": { result: "skipped" },
    };
    expect(verifyResults(jobs)).toBe(true);
    for (const result of ["failure", "cancelled", "skipped"])
      expect(verifyResults({ ...jobs, api: { result } })).toBe(false);
    expect(verifyResults({ ...jobs, plan: { result: "failure" } })).toBe(false);
    expect(verifyResults({ ...jobs, angular: { result: "failure" } })).toBe(false);
    expect(verifyResults({})).toBe(false);
  });
});
