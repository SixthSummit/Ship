import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSchemaLintCli } from "./cli.js";
import { SCHEMA_LINT_EXIT } from "./lint.js";
import { RELEASE_STEP_ENV, runRelease } from "./release.js";
import type { SnapshotQueryable } from "./snapshot.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "migrations");

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    options: {
      cwd: fixtures,
      env,
      stdout: (text: string) => {
        out.push(text);
      },
      stderr: (text: string) => {
        err.push(text);
      },
    },
  };
}

const emptyCatalog: SnapshotQueryable = { query: async () => ({ rows: [] }) };

describe("ship-schema-lint check", () => {
  it("exits 1 with the recipe for the unsafe fixture", async () => {
    const { out, options } = io();
    const code = await runSchemaLintCli(
      ["check", "unsafe", "--allowlist", "unsafe/allowlist.json"],
      options,
    );
    expect(code).toBe(SCHEMA_LINT_EXIT.findings);
    const text = out.join("");
    expect(text).toContain("[non-concurrent-index]");
    expect(text).toContain("Safe recipe:");
    expect(text).toContain("allowed 0001_retire_legacy.sql");
  });

  it("exits 0 for the safe fixture and prints JSON on request", async () => {
    const { out, options } = io();
    expect(await runSchemaLintCli(["check", "safe", "--json"], options)).toBe(SCHEMA_LINT_EXIT.ok);
    const result = JSON.parse(out.join(""));
    expect(result.ok).toBe(true);
    expect(result.command).toBe("check");
    expect(result.findings).toEqual([]);
  });

  it("exits 2 for a missing directory, a bad allowlist, or bad flags", async () => {
    const missing = io();
    expect(await runSchemaLintCli(["check", "missing"], missing.options)).toBe(
      SCHEMA_LINT_EXIT.invalid,
    );
    expect(missing.err.join("")).toContain("cannot read migrations directory");
    const badAllowlist = io();
    expect(
      await runSchemaLintCli(
        ["check", "safe", "--allowlist", "safe/meta/_journal.json", "--json"],
        badAllowlist.options,
      ),
    ).toBe(SCHEMA_LINT_EXIT.invalid);
    expect(JSON.parse(badAllowlist.out.join("")).error).toContain("invalid allowlist");
    const badFlag = io();
    expect(await runSchemaLintCli(["check"], badFlag.options)).toBe(SCHEMA_LINT_EXIT.invalid);
    const help = io();
    expect(await runSchemaLintCli(["--help"], help.options)).toBe(SCHEMA_LINT_EXIT.ok);
    expect(help.out.join("")).toContain("release");
  });
});

describe("ship-schema-lint release", () => {
  it("refuses to apply migrations outside a release context", async () => {
    const { out, options } = io({});
    const code = await runSchemaLintCli(["release", "--migrations", "safe", "--json"], options);
    expect(code).toBe(SCHEMA_LINT_EXIT.refused);
    const result = JSON.parse(out.join(""));
    expect(result.steps[0]).toMatchObject({ name: "guard", status: "refused" });
    expect(result.output).toContain(RELEASE_STEP_ENV);
  });

  it("dry-run lints and prints the plan without the guard", async () => {
    const { out, options } = io({});
    const code = await runSchemaLintCli(
      [
        "release",
        "--migrations",
        "safe",
        "--dry-run",
        "--migrate-command",
        "node migrate.mjs",
        "--snapshot",
        "schema.json",
      ],
      options,
    );
    expect(code).toBe(SCHEMA_LINT_EXIT.ok);
    expect(out.join("")).toContain("dry run: would apply migrations with: node migrate.mjs");
  });

  it("stops before migrating when lint fails", async () => {
    const calls: string[] = [];
    const result = await runRelease({
      cwd: fixtures,
      env: { [RELEASE_STEP_ENV]: "1" },
      migrationsDir: "unsafe",
      migrateCommand: "node migrate.mjs",
      write: () => undefined,
      runCommand: (command) => {
        calls.push(command);
        return { status: 0 };
      },
    });
    expect(result.exitCode).toBe(SCHEMA_LINT_EXIT.findings);
    expect(result.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "guard:passed",
      "lint:failed",
    ]);
    expect(calls).toEqual([]);
  });

  it("runs lint, the migrator and the snapshot check in order", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-release-"));
    const snapshotPath = resolve(directory, "schema.snapshot.json");
    await writeFile(
      snapshotPath,
      JSON.stringify({ schemaVersion: 1, schemas: ["public"], enums: [], tables: [] }),
      "utf8",
    );
    const calls: Array<{ command: string; args: readonly string[]; databaseUrl?: string }> = [];
    let closed = false;
    const result = await runRelease({
      cwd: fixtures,
      env: { [RELEASE_STEP_ENV]: "1" },
      migrationsDir: "safe",
      databaseUrl: "postgres://release@localhost/app",
      migrateCommand: "node migrate.mjs --flag",
      snapshotPath,
      write: () => undefined,
      runCommand: (command, args, context) => {
        calls.push({ command, args, databaseUrl: context.env.DATABASE_URL });
        return { status: 0 };
      },
      connect: async () => ({
        client: emptyCatalog,
        close: async () => {
          closed = true;
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        command: "node",
        args: ["migrate.mjs", "--flag"],
        databaseUrl: "postgres://release@localhost/app",
      },
    ]);
    expect(result.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "guard:passed",
      "lint:passed",
      "migrate:passed",
      "snapshot:passed",
    ]);
    expect(closed).toBe(true);
  });

  it("fails when the migrator exits non-zero and when the snapshot drifts", async () => {
    const failed = await runRelease({
      cwd: fixtures,
      env: { [RELEASE_STEP_ENV]: "1" },
      migrationsDir: "safe",
      migrateCommand: "node migrate.mjs",
      write: () => undefined,
      runCommand: () => ({ status: 7 }),
    });
    expect(failed.exitCode).toBe(SCHEMA_LINT_EXIT.findings);
    expect(failed.steps.at(-1)).toMatchObject({
      name: "migrate",
      status: "failed",
      detail: "exited with 7",
    });

    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-release-"));
    const snapshotPath = resolve(directory, "schema.snapshot.json");
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        schemas: ["public"],
        enums: [],
        tables: [{ schema: "public", name: "orders", columns: [], constraints: [], indexes: [] }],
      }),
      "utf8",
    );
    const drifted = await runRelease({
      cwd: fixtures,
      env: { [RELEASE_STEP_ENV]: "1", DATABASE_URL: "postgres://x" },
      migrationsDir: "safe",
      migrateCommand: "node migrate.mjs",
      snapshotPath,
      write: () => undefined,
      runCommand: () => ({ status: 0 }),
      connect: async () => ({ client: emptyCatalog, close: async () => undefined }),
    });
    expect(drifted.exitCode).toBe(SCHEMA_LINT_EXIT.findings);
    expect(drifted.snapshot?.differences.map((difference) => difference.path)).toEqual([
      "table public.orders",
    ]);
  });

  it("writes the snapshot when asked and needs a database url to do so", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-release-"));
    const snapshotPath = resolve(directory, "schema.snapshot.json");
    const written = await runRelease({
      cwd: fixtures,
      env: { [RELEASE_STEP_ENV]: "1", DATABASE_URL: "postgres://x" },
      migrationsDir: "safe",
      migrateCommand: "node migrate.mjs",
      snapshotPath,
      writeSnapshot: true,
      write: () => undefined,
      runCommand: () => ({ status: 0 }),
      connect: async () => ({ client: emptyCatalog, close: async () => undefined }),
    });
    expect(written.ok).toBe(true);
    expect(written.steps.at(-1)).toMatchObject({ name: "snapshot", status: "passed" });
    const missingUrl = await runRelease({
      cwd: fixtures,
      env: { [RELEASE_STEP_ENV]: "1" },
      migrationsDir: "safe",
      migrateCommand: "node migrate.mjs",
      snapshotPath,
      write: () => undefined,
      runCommand: () => ({ status: 0 }),
    });
    expect(missingUrl.exitCode).toBe(SCHEMA_LINT_EXIT.invalid);
  });

  it("explains when drizzle-kit cannot be resolved", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-nokit-"));
    await writeFile(resolve(directory, "package.json"), "{}", "utf8");
    const result = await runRelease({
      cwd: directory,
      env: { [RELEASE_STEP_ENV]: "1" },
      migrationsDir: resolve(fixtures, "safe"),
      write: () => undefined,
    });
    expect(result.exitCode).toBe(SCHEMA_LINT_EXIT.invalid);
    expect(result.steps.at(-1)?.detail).toContain("drizzle-kit is not installed");
  });
});

describe("ship-schema-lint snapshot and pending", () => {
  it("checks a snapshot through an injected connection and reports drift", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-cli-"));
    const snapshotPath = resolve(directory, "schema.snapshot.json");
    const { out, options } = io({ DATABASE_URL: "postgres://x" });
    const writeCode = await runSchemaLintCli(["snapshot", "write", "--out", snapshotPath], {
      ...options,
      connect: async () => ({ client: emptyCatalog, close: async () => undefined }),
    });
    expect(writeCode).toBe(SCHEMA_LINT_EXIT.ok);
    expect(out.join("")).toContain("schema snapshot written");
    const checkCode = await runSchemaLintCli(
      ["snapshot", "check", "--snapshot", snapshotPath, "--json"],
      {
        ...options,
        connect: async () => ({
          client: {
            query: async (text: string) => ({
              rows:
                text.includes("pg_class c") && !text.includes("pg_attribute")
                  ? [{ schema: "public", name: "extra" }]
                  : [],
            }),
          },
          close: async () => undefined,
        }),
      },
    );
    expect(checkCode).toBe(SCHEMA_LINT_EXIT.findings);
    expect(JSON.parse(out.at(-1) ?? "{}").differences[0]).toMatchObject({
      kind: "added",
      path: "table public.extra",
    });
  });

  it("requires a database url for snapshot and pending commands", async () => {
    const { err, options } = io({});
    expect(await runSchemaLintCli(["snapshot", "check", "--snapshot", "x.json"], options)).toBe(
      SCHEMA_LINT_EXIT.invalid,
    );
    expect(await runSchemaLintCli(["pending", "--migrations", "safe"], options)).toBe(
      SCHEMA_LINT_EXIT.invalid,
    );
    expect(err.join("")).toContain("DATABASE_URL");
  });

  it("pending exits 1 and names the pending tags", async () => {
    const { out, options } = io({ DATABASE_URL: "postgres://x" });
    const code = await runSchemaLintCli(["pending", "--migrations", "safe"], {
      ...options,
      connect: async () => ({
        client: { query: async () => ({ rows: [{ created_at: "1760000000000" }] }) },
        close: async () => undefined,
      }),
    });
    expect(code).toBe(SCHEMA_LINT_EXIT.findings);
    expect(out.join("")).toContain("0001_add_currency");
    const applied = await runSchemaLintCli(["pending", "--migrations", "safe", "--json"], {
      ...options,
      connect: async () => ({
        client: { query: async () => ({ rows: [{ created_at: "1760000100000" }] }) },
        close: async () => undefined,
      }),
    });
    expect(applied).toBe(SCHEMA_LINT_EXIT.ok);
  });
});
