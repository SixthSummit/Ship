import { describe, expect, it } from "vitest";
import { validateArtifact } from "./artifacts.mjs";
import { publishPlan, REGISTRY, selectReleases, validateDependencies } from "./plan.mjs";

const pkg = (name, version = "1.0.1-alpha-20261012") => ({
  name,
  version,
  publishConfig: { registry: REGISTRY, access: "public" },
});
describe("exact npm releases", () => {
  it("does not publish unchanged unpublished packages during alpha releases", () => {
    const packages = [pkg("a"), pkg("b")];
    const registry = new Map([
      ["a", { versions: {} }],
      ["b", null],
    ]);
    expect(
      selectReleases(packages, registry, { channel: "alpha", changed: ["a"] }).map((p) => p.name),
    ).toEqual(["a"]);
    expect(() => selectReleases(packages, registry, { channel: "alpha", changed: ["b"] })).toThrow(
      /bootstrap/,
    );
    expect(
      selectReleases(packages, registry, { channel: "alpha", changed: ["b"], bootstrap: true }),
    ).toEqual([packages[1]]);
  });
  it("skips published stable versions and refuses unknown registry responses", () => {
    const a = pkg("a", "1.0.1");
    expect(
      selectReleases([a], new Map([["a", { versions: { "1.0.1": {} } }]]), { channel: "latest" }),
    ).toEqual([]);
    expect(() => selectReleases([a], new Map(), { channel: "latest" })).toThrow(
      /registry response/,
    );
    expect(() => selectReleases([pkg("a")], new Map(), { channel: "latest" })).toThrow(
      /prerelease/,
    );
  });
  it("requires internal dependencies to be available and orders dependencies first", () => {
    const a = { ...pkg("a"), dependencies: { b: "workspace:*" } };
    const b = pkg("b");
    expect(() => validateDependencies([a], [a, b], new Map([["b", null]]))).toThrow(/absent/);
    expect(() => validateDependencies([a, b], [a, b], new Map())).not.toThrow();
    expect(publishPlan([a, b], "alpha").plan.map((group) => group.map((p) => p.name))).toEqual([
      ["b"],
      ["a"],
    ]);
    expect(() => publishPlan([a, { ...b, dependencies: { a: "*" } }], "alpha")).toThrow(/cycle/);
  });
  it("rejects mismatched artifacts and unresolved workspace dependencies", () => {
    const a = pkg("a");
    const entry = publishPlan([a], "alpha").plan[0][0];
    expect(() => validateArtifact(a, entry)).not.toThrow();
    expect(() => validateArtifact({ ...a, version: "1.0.0" }, entry)).toThrow();
    expect(() => validateArtifact({ ...a, dependencies: { b: "workspace:*" } }, entry)).toThrow(
      /Unresolved/,
    );
    expect(() => validateArtifact(a, { ...entry, tag: "latest" })).toThrow(/mismatch/);
  });
});
