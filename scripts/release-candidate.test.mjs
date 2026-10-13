import { describe, expect, it } from "vitest";
import {
  candidateFingerprint,
  createCandidateManifest,
  parseCandidateArguments,
  validateCandidateManifest,
} from "./release-candidate.mjs";

const first = candidatePackage("@sixthsummit/ship-core", "ship-core.tgz", "a");
const second = candidatePackage("@sixthsummit/ship-hono", "ship-hono.tgz", "b");

describe("release candidate manifest", () => {
  it("sorts packages and fingerprints the exact candidate", () => {
    const left = createCandidateManifest([second, first]);
    const right = createCandidateManifest([first, second]);

    expect(left).toEqual(right);
    expect(Object.keys(left.packages)).toEqual([
      "@sixthsummit/ship-core",
      "@sixthsummit/ship-hono",
    ]);
    const { fingerprint, ...unsigned } = left;
    expect(fingerprint).toBe(candidateFingerprint(unsigned));
    expect(validateCandidateManifest(left)).toBe(left);
  });

  it("rejects duplicate package identities", () => {
    expect(() => createCandidateManifest([first, first])).toThrow(
      "duplicate candidate package @sixthsummit/ship-core",
    );
  });

  it.each([
    "../ship-core.tgz",
    "/tmp/ship-core.tgz",
  ])("rejects a non-portable archive path %s", (archive) => {
    expect(() => createCandidateManifest([{ ...first, archive }])).toThrow(
      /candidate package @sixthsummit\/ship-core/u,
    );
  });

  it("rejects a changed manifest with a stale fingerprint", () => {
    const manifest = createCandidateManifest([first]);
    const changed = {
      ...manifest,
      packages: {
        ...manifest.packages,
        [first.name]: { ...first, bytes: first.bytes + 1 },
      },
    };

    expect(() => validateCandidateManifest(changed)).toThrow(
      "candidate manifest fingerprint does not match its contents",
    );
  });

  it("keeps the candidate fingerprint sensitive to source provenance", () => {
    const manifest = createCandidateManifest([first]);
    const moved = createCandidateManifest([
      {
        ...first,
        source: { ...first.source, commit: "2".repeat(40) },
      },
    ]);

    expect(moved.fingerprint).not.toBe(manifest.fingerprint);
  });

  it("accepts pnpm's conventional argument separator", () => {
    expect(
      parseCandidateArguments([
        "--",
        "--output",
        "/private/tmp/candidate",
        "--package",
        "../ship-angular/packages/core",
      ]),
    ).toEqual({
      output: "/private/tmp/candidate",
      additionalPackages: ["../ship-angular/packages/core"],
    });
  });
});

function candidatePackage(name, archive, digestCharacter) {
  return {
    name,
    version: "0.1.0-alpha.0",
    archive,
    bytes: 123,
    sha256: `sha256:${digestCharacter.repeat(64)}`,
    source: {
      repository: "git@github.com:SixthSummit/ship-api.git",
      commit: "1".repeat(40),
      packagePath: `packages/${name.slice(name.lastIndexOf("/") + 1)}`,
    },
  };
}
