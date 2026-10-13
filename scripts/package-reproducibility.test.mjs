import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { assertReproduciblePackageArchives } from "./package-reproducibility.mjs";

const require = createRequire(import.meta.url);
const { sortPackageManifestDependencies } = require("../.pnpmfile.cjs");

const core = Object.freeze({
  name: "@sixthsummit/ship-core",
  version: "0.1.0-alpha.0",
  bytes: 128,
  sha256: `sha256:${"a".repeat(64)}`,
});

describe("package archive reproducibility", () => {
  it("sorts every publish-time dependency map without changing unrelated fields", () => {
    const manifest = {
      name: "example",
      dependencies: { zod: "4", alpha: "1" },
      devDependencies: { zebra: "1", beta: "2" },
      optionalDependencies: { y: "1", x: "1" },
      peerDependencies: { hono: "4", drizzle: "1" },
    };

    expect(sortPackageManifestDependencies(manifest)).toEqual({
      name: "example",
      dependencies: { alpha: "1", zod: "4" },
      devDependencies: { beta: "2", zebra: "1" },
      optionalDependencies: { x: "1", y: "1" },
      peerDependencies: { drizzle: "1", hono: "4" },
    });
  });

  it("accepts exact package identities in deterministic name order", () => {
    const first = new Map([
      ["@sixthsummit/ship-hono", { ...core, name: "@sixthsummit/ship-hono" }],
      [core.name, core],
    ]);
    const second = new Map([...first].reverse());

    expect(assertReproduciblePackageArchives(first, second)).toEqual([
      "@sixthsummit/ship-core",
      "@sixthsummit/ship-hono",
    ]);
  });

  it.each([
    ["version", "0.1.0-alpha.1"],
    ["bytes", 129],
    ["sha256", `sha256:${"b".repeat(64)}`],
  ])("rejects a changed %s", (field, value) => {
    const first = new Map([[core.name, core]]);
    const second = new Map([[core.name, { ...core, [field]: value }]]);

    expect(() => assertReproduciblePackageArchives(first, second)).toThrow(`${field} changed from`);
  });

  it("rejects a package missing from either build", () => {
    expect(() =>
      assertReproduciblePackageArchives(new Map([[core.name, core]]), new Map()),
    ).toThrow(`${core.name} is missing from the second package build`);
  });
});
