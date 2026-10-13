import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLibraryStamp } from "./add.js";

// AI-A3 — the vendored-library provenance stamp. `now` / `frameworkVersion`
// are injected for determinism (the addLibrary path resolves them live).
describe("writeLibraryStamp (AI-A3 vendored-library provenance)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-lib-stamp-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("stamps .ship-lib.json with the library's independent version", async () => {
    await writeLibraryStamp(
      tmp,
      "ai",
      { name: "ai", version: "0.2.0" },
      { now: "2026-06-03T00:00:00.000Z", frameworkVersion: "9.9.9-test" },
    );
    const stamp = JSON.parse(await readFile(path.join(tmp, ".ship-lib.json"), "utf8"));
    expect(stamp).toEqual({
      name: "ai",
      version: "0.2.0",
      source: "ship-api add -l",
      at: "2026-06-03T00:00:00.000Z",
      frameworkVersion: "9.9.9-test",
    });
  });

  it("falls back to 'unknown' version when library.json carries none", async () => {
    await writeLibraryStamp(
      tmp,
      "weaviate",
      { name: "weaviate" },
      { now: "x", frameworkVersion: "y" },
    );
    const stamp = JSON.parse(await readFile(path.join(tmp, ".ship-lib.json"), "utf8"));
    expect(stamp.version).toBe("unknown");
    expect(stamp.name).toBe("weaviate");
  });
});
