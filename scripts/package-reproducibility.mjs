import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export async function packageArchiveIdentity(pack) {
  const archive = await readFile(pack.filename);
  return Object.freeze({
    name: pack.name,
    version: pack.version,
    bytes: (await stat(pack.filename)).size,
    sha256: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
  });
}

export function assertReproduciblePackageArchives(firstBuild, secondBuild) {
  const names = [...new Set([...firstBuild.keys(), ...secondBuild.keys()])].sort();
  for (const name of names) {
    const first = firstBuild.get(name);
    const second = secondBuild.get(name);
    if (!first || !second) {
      throw new Error(`${name} is missing from the ${first ? "second" : "first"} package build`);
    }
    for (const field of ["version", "bytes", "sha256"]) {
      if (first[field] !== second[field]) {
        throw new Error(
          `${name} archive is not reproducible: ${field} changed from ${first[field]} to ${second[field]}`,
        );
      }
    }
  }
  return names;
}
