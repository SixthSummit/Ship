import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCli } from "./ship-api.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureApp = resolve(sourceDirectory, "__fixtures__/graph/ship.config.ts");

describe("focused Ship CLI", () => {
  let temporaryDirectory;
  let stdout;
  let stderr;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ship-cli-program-test-"));
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it("registers only the graph and contract command surface", () => {
    const program = createCli({ version: "9.8.7" });

    expect(program.commands.map((command) => command.name())).toEqual([
      "create",
      "check",
      "inspect",
      "affected",
      "contract",
      "migrate-routes",
    ]);
    expect(program.version()).toBe("9.8.7");
  });

  it("executes operation-native scaffolding through Commander", async () => {
    await createCli({
      version: "1.0.0",
      cwd: temporaryDirectory,
      templateDirectory: resolve(sourceDirectory, "../templates/operation"),
      releaseManifest: {
        schemaVersion: 1,
        packageManager: "pnpm@10.34.5",
        packages: {
          "@sixthsummit/ship-contract": "0.1.0-alpha.0",
          "@sixthsummit/ship-core": "0.1.0-alpha.0",
          "@sixthsummit/ship-hono": "0.1.0-alpha.0",
        },
        dependencies: { hono: "4.12.25", zod: "^4.3.6" },
        devDependencies: { "@sixthsummit/ship-cli": "0.1.0-alpha.0" },
      },
    }).parseAsync(["node", "ship-api", "create", "orders-api", "--skip-install"]);

    expect(process.exitCode).toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(resolve(temporaryDirectory, "orders-api/package.json"), "utf8")),
    ).toMatchObject({ name: "orders-api" });
  });

  it("reports scaffold failures with the CLI usage exit class", async () => {
    await createCli({
      version: "1.0.0",
      cwd: temporaryDirectory,
      templateDirectory: resolve(sourceDirectory, "../templates/operation"),
      releaseManifest: {
        schemaVersion: 1,
        packageManager: "pnpm@10.34.5",
        packages: {},
        dependencies: {},
        devDependencies: {},
      },
    }).parseAsync(["node", "ship-api", "create", "../unsafe", "--skip-install"]);

    expect(process.exitCode).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([value]) => value).join("")).toContain(
      "project name must be lower-case kebab-case",
    );
  });

  it.each([
    ["check", ["check", "--app", fixtureApp, "--format", "json"]],
    ["inspect", ["inspect", "operation", "accounts.read", "--app", fixtureApp, "--format", "json"]],
    [
      "affected",
      ["affected", "provider", "platform.clock", "--app", fixtureApp, "--format", "json"],
    ],
  ])("executes %s through Commander", async (command, args) => {
    await createCli({ version: "1.0.0" }).parseAsync(["node", "ship-api", ...args]);

    expect(process.exitCode).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls.map(([value]) => value).join(""))).toMatchObject({
      command,
      ok: true,
    });
  });

  it("executes contract generation through Commander", async () => {
    const contract = resolve(temporaryDirectory, "contract.json");
    const typescript = resolve(temporaryDirectory, "contract.ts");
    const openapi = resolve(temporaryDirectory, "openapi.json");

    await createCli({ version: "1.0.0" }).parseAsync([
      "node",
      "ship-api",
      "contract",
      "--app",
      fixtureApp,
      "--out",
      contract,
      "--typescript",
      typescript,
      "--openapi",
      openapi,
      "--openapi-title",
      "CLI fixture",
      "--api-version",
      "2.0.0",
      "--format",
      "json",
    ]);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(await readFile(openapi, "utf8"))).toMatchObject({
      info: { title: "CLI fixture", version: "2.0.0" },
    });
    await expect(readFile(typescript, "utf8")).resolves.toContain("type AppContract");
  });

  it("executes legacy route accounting through Commander", async () => {
    const catalog = resolve(temporaryDirectory, "catalog.json");
    const mapping = resolve(temporaryDirectory, "mapping.json");
    await writeFile(
      catalog,
      JSON.stringify({
        schemaVersion: 1,
        applicationId: "graph-fixture",
        revision: "candidate-a",
        routes: [
          {
            id: "accounts.routes.ts:1",
            method: "GET",
            path: "/accounts/:accountId",
          },
        ],
      }),
    );
    await writeFile(
      mapping,
      JSON.stringify({
        schemaVersion: 1,
        applicationId: "graph-fixture",
        catalogRevision: "candidate-a",
        entries: [{ legacyRouteId: "accounts.routes.ts:1", operationId: "accounts.read" }],
      }),
    );

    await createCli({ version: "1.0.0" }).parseAsync([
      "node",
      "ship-api",
      "migrate-routes",
      "--app",
      fixtureApp,
      "--catalog",
      catalog,
      "--mapping",
      mapping,
      "--format",
      "json",
    ]);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout.mock.calls.map(([value]) => value).join(""))).toMatchObject({
      command: "migrate-routes",
      ok: true,
      routes: 1,
      mapped: 1,
    });
  });
});
