import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { AllowlistError } from "./allowlist.js";
import { assertMigrationsApplied, migrationsStatus, PendingMigrationsError } from "./boot-guard.js";
import {
  formatLintReport,
  lintMigrations,
  MigrationSourceError,
  SCHEMA_LINT_EXIT,
} from "./lint.js";
import { type DatabaseConnection, defaultConnect, runRelease } from "./release.js";
import {
  captureSchemaSnapshot,
  checkSchemaSnapshot,
  formatSnapshotDifferences,
  SnapshotFileError,
  serializeSnapshot,
  writeSchemaSnapshot,
} from "./snapshot.js";

export interface CliIo {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly connect?: (databaseUrl: string) => Promise<DatabaseConnection>;
  readonly runCommand?: Parameters<typeof runRelease>[0]["runCommand"];
}

/** Runs the `ship-schema-lint` CLI and resolves with the process exit code. */
export async function runSchemaLintCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const cwd = resolve(io.cwd ?? process.cwd());
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const connect = io.connect ?? defaultConnect;
  let exitCode: number = SCHEMA_LINT_EXIT.ok;

  const program = new Command("ship-schema-lint")
    .description(
      "Migration linter, schema snapshot check, and gated release preset for Drizzle PostgreSQL migrations",
    )
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });

  program
    .command("check <migrations-dir>")
    .description("Lint Drizzle SQL migrations against the production schema rules")
    .option("--allowlist <file>", "JSON allowlist with justified exceptions")
    .option("--since <tag>", "only report findings from migrations after this tag")
    .option("--json", "print the result as JSON")
    .action(
      async (
        migrationsDir: string,
        options: { allowlist?: string; since?: string; json?: boolean },
      ) => {
        try {
          const result = await lintMigrations({
            migrationsDir: resolve(cwd, migrationsDir),
            allowlistPath: options.allowlist ? resolve(cwd, options.allowlist) : undefined,
            since: options.since,
          });
          stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatLintReport(result));
          exitCode = result.exitCode;
        } catch (error) {
          exitCode = reportInvalid(error, options.json, stdout, stderr);
        }
      },
    );

  program
    .command("release")
    .description(
      "Gated release step: lint, apply migrations, then check or write the schema snapshot",
    )
    .requiredOption("--migrations <dir>", "Drizzle migrations directory")
    .option("--allowlist <file>", "JSON allowlist with justified exceptions")
    .option("--since <tag>", "only report findings from migrations after this tag")
    .option("--database-url <url>", "target database (defaults to DATABASE_URL)")
    .option("--drizzle-config <file>", "passed to drizzle-kit migrate --config")
    .option(
      "--migrate-command <command>",
      "replace drizzle-kit migrate with another migrator command",
    )
    .option("--snapshot <file>", "committed schema snapshot to verify after migrating")
    .option("--write-snapshot", "write the snapshot instead of verifying it")
    .option("--dry-run", "lint and print the plan without applying anything")
    .option("--json", "print the result as JSON")
    .action(
      async (options: {
        migrations: string;
        allowlist?: string;
        since?: string;
        databaseUrl?: string;
        drizzleConfig?: string;
        migrateCommand?: string;
        snapshot?: string;
        writeSnapshot?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const buffered: string[] = [];
        const result = await runRelease({
          cwd,
          env,
          migrationsDir: options.migrations,
          allowlistPath: options.allowlist,
          since: options.since,
          databaseUrl: options.databaseUrl,
          drizzleConfig: options.drizzleConfig,
          migrateCommand: options.migrateCommand,
          snapshotPath: options.snapshot,
          writeSnapshot: options.writeSnapshot,
          dryRun: options.dryRun,
          write: options.json ? (text) => buffered.push(text) : stdout,
          connect,
          runCommand: io.runCommand,
        });
        if (options.json)
          stdout(`${JSON.stringify({ ...result, output: buffered.join("") }, null, 2)}\n`);
        exitCode = result.exitCode;
      },
    );

  const snapshot = program
    .command("snapshot")
    .description("Capture or verify the canonical schema snapshot");
  snapshot
    .command("write")
    .description("Capture the database schema into a snapshot file")
    .requiredOption("--out <file>", "snapshot file to write")
    .option("--database-url <url>", "database to capture (defaults to DATABASE_URL)")
    .option("--schema <names...>", "schemas to capture", ["public"])
    .action(async (options: { out: string; databaseUrl?: string; schema: string[] }) => {
      const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
      if (!databaseUrl) {
        stderr("snapshot write requires --database-url or DATABASE_URL\n");
        exitCode = SCHEMA_LINT_EXIT.invalid;
        return;
      }
      const connection = await connect(databaseUrl);
      try {
        const written = await writeSchemaSnapshot({
          client: connection.client,
          snapshotPath: resolve(cwd, options.out),
          capture: { schemas: options.schema },
        });
        stdout(
          `schema snapshot written to ${resolve(cwd, options.out)} (${written.tables.length} tables)\n`,
        );
      } finally {
        await connection.close();
      }
    });
  snapshot
    .command("check")
    .description("Fail when the database schema drifts from the committed snapshot")
    .requiredOption("--snapshot <file>", "committed snapshot file")
    .option("--database-url <url>", "database to compare (defaults to DATABASE_URL)")
    .option("--json", "print the result as JSON")
    .action(async (options: { snapshot: string; databaseUrl?: string; json?: boolean }) => {
      const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
      if (!databaseUrl) {
        stderr("snapshot check requires --database-url or DATABASE_URL\n");
        exitCode = SCHEMA_LINT_EXIT.invalid;
        return;
      }
      const connection = await connect(databaseUrl);
      try {
        const result = await checkSchemaSnapshot({
          client: connection.client,
          snapshotPath: resolve(cwd, options.snapshot),
        });
        stdout(
          options.json ? `${JSON.stringify(result, null, 2)}\n` : formatSnapshotDifferences(result),
        );
        exitCode = result.exitCode;
      } catch (error) {
        exitCode = reportInvalid(error, options.json, stdout, stderr);
      } finally {
        await connection.close();
      }
    });
  snapshot
    .command("print")
    .description("Print the database schema snapshot to stdout")
    .option("--database-url <url>", "database to capture (defaults to DATABASE_URL)")
    .option("--schema <names...>", "schemas to capture", ["public"])
    .action(async (options: { databaseUrl?: string; schema: string[] }) => {
      const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
      if (!databaseUrl) {
        stderr("snapshot print requires --database-url or DATABASE_URL\n");
        exitCode = SCHEMA_LINT_EXIT.invalid;
        return;
      }
      const connection = await connect(databaseUrl);
      try {
        stdout(
          serializeSnapshot(
            await captureSchemaSnapshot(connection.client, { schemas: options.schema }),
          ),
        );
      } finally {
        await connection.close();
      }
    });

  program
    .command("pending")
    .description(
      "Boot-time guard: exit 1 when the journal has migrations the ledger has not applied",
    )
    .requiredOption("--migrations <dir>", "Drizzle migrations directory")
    .option("--database-url <url>", "database to inspect (defaults to DATABASE_URL)")
    .option("--migrations-schema <name>", "ledger schema", "drizzle")
    .option("--migrations-table <name>", "ledger table", "__drizzle_migrations")
    .option("--json", "print the result as JSON")
    .action(
      async (options: {
        migrations: string;
        databaseUrl?: string;
        migrationsSchema: string;
        migrationsTable: string;
        json?: boolean;
      }) => {
        const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
        if (!databaseUrl) {
          stderr("pending requires --database-url or DATABASE_URL\n");
          exitCode = SCHEMA_LINT_EXIT.invalid;
          return;
        }
        const connection = await connect(databaseUrl);
        try {
          const request = {
            client: connection.client,
            migrationsDir: resolve(cwd, options.migrations),
            migrationsSchema: options.migrationsSchema,
            migrationsTable: options.migrationsTable,
          };
          const status = options.json
            ? await migrationsStatus(request)
            : await assertMigrationsApplied(request);
          if (options.json) {
            stdout(
              `${JSON.stringify({ command: "pending", ok: status.pending.length === 0, ...status }, null, 2)}\n`,
            );
            exitCode =
              status.pending.length === 0 ? SCHEMA_LINT_EXIT.ok : SCHEMA_LINT_EXIT.findings;
          } else {
            stdout(`all ${status.applied} migration(s) applied\n`);
          }
        } catch (error) {
          if (error instanceof PendingMigrationsError) {
            stdout(`${error.message}\n`);
            exitCode = SCHEMA_LINT_EXIT.findings;
          } else {
            throw error;
          }
        } finally {
          await connection.close();
        }
      },
    );

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version")
        return SCHEMA_LINT_EXIT.ok;
      return SCHEMA_LINT_EXIT.invalid;
    }
    throw error;
  }
  return exitCode;
}

function reportInvalid(
  error: unknown,
  json: boolean | undefined,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  if (
    error instanceof MigrationSourceError ||
    error instanceof AllowlistError ||
    error instanceof SnapshotFileError
  ) {
    if (json) {
      stdout(
        `${JSON.stringify({ ok: false, exitCode: SCHEMA_LINT_EXIT.invalid, error: error.message }, null, 2)}\n`,
      );
    } else {
      stderr(`${error.message}\n`);
    }
    return SCHEMA_LINT_EXIT.invalid;
  }
  throw error;
}
