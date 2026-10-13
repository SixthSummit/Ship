import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

assert(
  !existsSync(".changeset/pre.json"),
  "Changesets pre mode is not used; alpha uses snapshots.",
);
for (const directory of readdirSync("packages")) {
  const manifest = JSON.parse(readFileSync(`packages/${directory}/package.json`, "utf8"));
  if (manifest.private) continue;
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org", manifest.name);
  assert.equal(manifest.publishConfig?.access, "public", manifest.name);
  assert.equal(manifest.license, "Apache-2.0", manifest.name);
}
console.log("Public package and release configuration passed.");
