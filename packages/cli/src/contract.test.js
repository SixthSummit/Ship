import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateContractArtifacts } from "./contract.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const cliPath = resolve(packageDirectory, "src/bin.js");
const fixtureApp = resolve(sourceDirectory, "__fixtures__/graph/ship.config.ts");
const mergeFixture = (variant) =>
  resolve(sourceDirectory, `__fixtures__/contract-merge/${variant}.config.ts`);
const ARTIFACTS = ["contract", "openapi", "typescript"];

describe("Ship contract CLI", () => {
  let temporaryDirectory;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ship-api-contract-cli-test-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it("emits deterministic client and OpenAPI artifacts from one application graph", async () => {
    const firstDirectory = resolve(temporaryDirectory, "first");
    const secondDirectory = resolve(temporaryDirectory, "second");
    const options = {
      appPath: fixtureApp,
      title: "Graph fixture",
      version: "1.2.3",
    };
    const first = await generateContractArtifacts({ ...options, cwd: firstDirectory });
    const second = await generateContractArtifacts({ ...options, cwd: secondDirectory });
    const firstContract = await readFile(first.contract, "utf8");
    const secondContract = await readFile(second.contract, "utf8");
    const firstOpenApi = await readFile(first.openapi, "utf8");
    const secondOpenApi = await readFile(second.openapi, "utf8");
    const firstTypeScript = await readFile(first.typescript, "utf8");
    const secondTypeScript = await readFile(second.typescript, "utf8");

    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.operations).toBe(1);
    expect(secondContract).toBe(firstContract);
    expect(secondOpenApi).toBe(firstOpenApi);
    expect(secondTypeScript).toBe(firstTypeScript);
    expect(JSON.parse(firstContract).operations[0].id).toBe("accounts.read");
    expect(firstTypeScript).toContain("export type AppContract = ClientTypeContract");
    expect(firstTypeScript).toContain('"accounts.read"');
    expect(JSON.parse(firstOpenApi)).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Graph fixture", version: "1.2.3" },
      "x-ship-app-id": "graph-fixture",
    });
    // The digest is reported, never stored: a stored one changes with every
    // regeneration and conflicts between any two branches.
    for (const artifact of [firstContract, firstOpenApi, firstTypeScript]) {
      expect(artifact).not.toContain("fingerprint");
    }
  });

  it("emits artifacts that three-way merge cleanly when two branches change different operations", async () => {
    const emitted = {};
    for (const variant of ["base", "left", "right"]) {
      emitted[variant] = await generateContractArtifacts({
        appPath: mergeFixture(variant),
        cwd: resolve(temporaryDirectory, variant),
        title: "Merge fixture",
        version: "1.0.0",
      });
    }
    expect(emitted.left.fingerprint).not.toBe(emitted.base.fingerprint);
    expect(emitted.right.fingerprint).not.toBe(emitted.base.fingerprint);

    for (const artifact of ARTIFACTS) {
      const merge = spawnSync(
        "git",
        [
          "merge-file",
          "-p",
          "-L",
          "left",
          "-L",
          "base",
          "-L",
          "right",
          emitted.left[artifact],
          emitted.base[artifact],
          emitted.right[artifact],
        ],
        { encoding: "utf8" },
      );
      // `git merge-file` exits with the number of conflicts; anything below
      // zero is a usage error. Both must be zero for every artifact.
      expect({ artifact, status: merge.status, stderr: merge.stderr }).toEqual({
        artifact,
        status: 0,
        stderr: "",
      });
      expect(merge.stdout).not.toMatch(/^(?:<{7}|={7}|>{7})/mu);
      // The merged result carries both changes and nothing else.
      const merged =
        artifact === "typescript"
          ? JSON.parse(
              merge.stdout.slice(
                merge.stdout.indexOf("export const clientContract = ") +
                  "export const clientContract = ".length,
                merge.stdout.indexOf(" as const satisfies ClientContract;"),
              ),
            )
          : JSON.parse(merge.stdout);
      const serialized = JSON.stringify(merged);
      expect(serialized).toContain("displayName");
      expect(serialized).toContain("limit");
      expect(serialized).not.toContain("fingerprint");
    }

    // The merged manifest is exactly what regenerating from the merged
    // declarations would produce, which is what a consumer's verify step checks.
    const mergedContract = spawnSync(
      "git",
      ["merge-file", "-p", emitted.left.contract, emitted.base.contract, emitted.right.contract],
      { encoding: "utf8" },
    ).stdout;
    const regenerated = JSON.parse(await readFile(emitted.left.contract, "utf8"));
    const rightReports = JSON.parse(await readFile(emitted.right.contract, "utf8")).operations.find(
      (operation) => operation.id === "reports.summary",
    );
    regenerated.operations = regenerated.operations.map((operation) =>
      operation.id === "reports.summary" ? rightReports : operation,
    );
    expect(JSON.parse(mergedContract)).toEqual(regenerated);
  });

  it("runs deterministic generation through the packed CLI entrypoint", async () => {
    const contract = resolve(temporaryDirectory, "contract.json");
    const openapi = resolve(temporaryDirectory, "openapi.json");
    const typescript = resolve(temporaryDirectory, "contract.ts");
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "contract",
        "--app",
        fixtureApp,
        "--out",
        contract,
        "--openapi",
        openapi,
        "--typescript",
        typescript,
        "--openapi-title",
        "Graph fixture",
        "--api-version",
        "1.2.3",
        "--format",
        "json",
      ],
      { cwd: packageDirectory, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "contract",
      ok: true,
      appId: "graph-fixture",
      operations: 1,
      contract,
      openapi,
      typescript,
    });
    await expect(readFile(typescript, "utf8")).resolves.toContain("export const clientContract");
  });

  it("rejects colliding artifact paths before writing", async () => {
    const target = resolve(temporaryDirectory, "same.json");

    await expect(
      generateContractArtifacts({ appPath: fixtureApp, out: target, openapi: target }),
    ).rejects.toMatchObject({
      exitCode: 2,
      diagnostics: [{ code: "SHIP_CLI_CONTRACT_OUTPUT_COLLISION", path: target }],
    });
  });

  it("rejects a TypeScript artifact that collides with another output", async () => {
    const target = resolve(temporaryDirectory, "same.json");

    await expect(
      generateContractArtifacts({ appPath: fixtureApp, out: target, typescript: target }),
    ).rejects.toMatchObject({
      exitCode: 2,
      diagnostics: [{ code: "SHIP_CLI_CONTRACT_OUTPUT_COLLISION", path: target }],
    });
  });
});
