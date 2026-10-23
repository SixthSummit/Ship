import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { AllowlistError } from "./allowlist.js";
import {
  formatLintReport,
  type LintResult,
  lintMigrations,
  MigrationSourceError,
  SCHEMA_LINT_EXIT,
} from "./lint.js";
import {
  checkSchemaSnapshot,
  formatSnapshotDifferences,
  type SnapshotCheckResult,
  SnapshotFileError,
  type SnapshotQueryable,
  writeSchemaSnapshot,
} from "./snapshot.js";

/** Environment variable the release pipeline sets to opt into applying migrations. */
export const RELEASE_STEP_ENV = "SHIP_RELEASE_STEP";

export interface DatabaseConnection {
  readonly client: SnapshotQueryable;
  close(): Promise<void>;
}

export interface CommandRunner {
  (
    command: string,
    args: readonly string[],
    context: { cwd: string; env: NodeJS.ProcessEnv },
  ): {
    status: number | null;
    error?: Error;
  };
}

export interface ReleaseOptions {
  readonly cwd?: string;
  readonly migrationsDir: string;
  readonly allowlistPath?: string;
  readonly since?: string;
  /** Falls back to `DATABASE_URL` from `env`. */
  readonly databaseUrl?: string;
  /** Passed to `drizzle-kit migrate --config`. */
  readonly drizzleConfig?: string;
  /** Replaces `drizzle-kit migrate`; split on whitespace, run without a shell. */
  readonly migrateCommand?: string;
  /** Committed snapshot to check after migrating (or to write with `writeSnapshot`). */
  readonly snapshotPath?: string;
  readonly writeSnapshot?: boolean;
  /** Lint and print the plan; apply nothing. */
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
  readonly runCommand?: CommandRunner;
  readonly connect?: (databaseUrl: string) => Promise<DatabaseConnection>;
}

export interface ReleaseStep {
  readonly name: "guard" | "lint" | "migrate" | "snapshot";
  readonly status: "passed" | "failed" | "skipped" | "refused" | "planned";
  readonly detail?: string;
}

export interface ReleaseResult {
  readonly command: "release";
  readonly ok: boolean;
  readonly exitCode: number;
  readonly steps: readonly ReleaseStep[];
  readonly lint?: LintResult;
  readonly snapshot?: SnapshotCheckResult;
}

/**
 * The gated release preset: lint the migrations, apply them with the project's
 * migrator, then verify (or write) the schema snapshot. It refuses to apply
 * anything unless `SHIP_RELEASE_STEP=1`, which belongs in the release job's
 * environment and never in an application runtime environment.
 */
export async function runRelease(options: ReleaseOptions): Promise<ReleaseResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const steps: ReleaseStep[] = [];
  const fail = (
    exitCode: number,
    lint?: LintResult,
    snapshot?: SnapshotCheckResult,
  ): ReleaseResult => ({
    command: "release",
    ok: false,
    exitCode,
    steps,
    ...(lint ? { lint } : {}),
    ...(snapshot ? { snapshot } : {}),
  });

  if (!options.dryRun && env[RELEASE_STEP_ENV] !== "1") {
    steps.push({
      name: "guard",
      status: "refused",
      detail: `${RELEASE_STEP_ENV} is not "1". Migrations run as a gated release step, never at boot; set ${RELEASE_STEP_ENV}=1 in the release job only.`,
    });
    write(`${steps[0]?.detail}\n`);
    return fail(SCHEMA_LINT_EXIT.refused);
  }
  steps.push({ name: "guard", status: options.dryRun ? "skipped" : "passed" });

  let lint: LintResult;
  try {
    lint = await lintMigrations({
      migrationsDir: resolve(cwd, options.migrationsDir),
      allowlistPath: options.allowlistPath ? resolve(cwd, options.allowlistPath) : undefined,
      since: options.since,
    });
  } catch (error) {
    if (error instanceof MigrationSourceError || error instanceof AllowlistError) {
      steps.push({ name: "lint", status: "failed", detail: error.message });
      write(`${error.message}\n`);
      return fail(SCHEMA_LINT_EXIT.invalid);
    }
    throw error;
  }
  write(formatLintReport(lint));
  if (!lint.ok) {
    steps.push({ name: "lint", status: "failed", detail: `${lint.findings.length} finding(s)` });
    return fail(SCHEMA_LINT_EXIT.findings, lint);
  }
  steps.push({ name: "lint", status: "passed", detail: `${lint.linted} migration(s) linted` });

  const migrate = resolveMigrateCommand(options, cwd);
  if ("error" in migrate) {
    steps.push({ name: "migrate", status: "failed", detail: migrate.error });
    write(`${migrate.error}\n`);
    return fail(SCHEMA_LINT_EXIT.invalid, lint);
  }
  const display = [migrate.command, ...migrate.args].join(" ");
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;

  if (options.dryRun) {
    steps.push({ name: "migrate", status: "planned", detail: display });
    steps.push({
      name: "snapshot",
      status: options.snapshotPath ? "planned" : "skipped",
      detail: options.snapshotPath
        ? `${options.writeSnapshot ? "write" : "check"} ${resolve(cwd, options.snapshotPath)}`
        : undefined,
    });
    write(`dry run: would apply migrations with: ${display}\n`);
    return { command: "release", ok: true, exitCode: SCHEMA_LINT_EXIT.ok, steps, lint };
  }

  const runCommand = options.runCommand ?? defaultRunCommand;
  write(`applying migrations: ${display}\n`);
  const migrateEnv = databaseUrl ? { ...env, DATABASE_URL: databaseUrl } : env;
  const outcome = runCommand(migrate.command, migrate.args, { cwd, env: migrateEnv });
  if (outcome.error || outcome.status !== 0) {
    const detail = outcome.error ? outcome.error.message : `exited with ${outcome.status}`;
    steps.push({ name: "migrate", status: "failed", detail });
    write(`migration apply failed: ${detail}\n`);
    return fail(SCHEMA_LINT_EXIT.findings, lint);
  }
  steps.push({ name: "migrate", status: "passed", detail: display });

  if (!options.snapshotPath) {
    steps.push({ name: "snapshot", status: "skipped" });
    return { command: "release", ok: true, exitCode: SCHEMA_LINT_EXIT.ok, steps, lint };
  }
  if (!databaseUrl) {
    const detail = "snapshot requires --database-url or DATABASE_URL";
    steps.push({ name: "snapshot", status: "failed", detail });
    write(`${detail}\n`);
    return fail(SCHEMA_LINT_EXIT.invalid, lint);
  }
  const snapshotPath = resolve(cwd, options.snapshotPath);
  const connection = await (options.connect ?? defaultConnect)(databaseUrl);
  try {
    if (options.writeSnapshot) {
      await writeSchemaSnapshot({ client: connection.client, snapshotPath });
      steps.push({ name: "snapshot", status: "passed", detail: `wrote ${snapshotPath}` });
      write(`schema snapshot written to ${snapshotPath}\n`);
      return { command: "release", ok: true, exitCode: SCHEMA_LINT_EXIT.ok, steps, lint };
    }
    let snapshot: SnapshotCheckResult;
    try {
      snapshot = await checkSchemaSnapshot({ client: connection.client, snapshotPath });
    } catch (error) {
      if (error instanceof SnapshotFileError) {
        steps.push({ name: "snapshot", status: "failed", detail: error.message });
        write(`${error.message}\n`);
        return fail(SCHEMA_LINT_EXIT.invalid, lint);
      }
      throw error;
    }
    write(formatSnapshotDifferences(snapshot));
    if (!snapshot.ok) {
      steps.push({
        name: "snapshot",
        status: "failed",
        detail: `${snapshot.differences.length} difference(s)`,
      });
      return fail(SCHEMA_LINT_EXIT.findings, lint, snapshot);
    }
    steps.push({ name: "snapshot", status: "passed", detail: `matches ${snapshotPath}` });
    return { command: "release", ok: true, exitCode: SCHEMA_LINT_EXIT.ok, steps, lint, snapshot };
  } finally {
    await connection.close();
  }
}

type ResolvedCommand = { command: string; args: readonly string[] } | { error: string };

function resolveMigrateCommand(options: ReleaseOptions, cwd: string): ResolvedCommand {
  if (options.migrateCommand) {
    const [command, ...args] = options.migrateCommand.trim().split(/\s+/u);
    if (!command) return { error: "--migrate-command must not be empty" };
    return { command, args };
  }
  let binary: string;
  try {
    const require = createRequire(resolve(cwd, "package.json"));
    const manifestPath = require.resolve("drizzle-kit/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin?: Record<string, string> | string;
    };
    const relative =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["drizzle-kit"];
    if (!relative) return { error: "drizzle-kit package has no drizzle-kit binary" };
    binary = resolve(dirname(manifestPath), relative);
  } catch {
    return {
      error:
        "drizzle-kit is not installed in this project; install it or pass --migrate-command to use another migrator",
    };
  }
  const args = ["migrate"];
  if (options.drizzleConfig) args.push("--config", options.drizzleConfig);
  return { command: process.execPath, args: [binary, ...args] };
}

const defaultRunCommand: CommandRunner = (command, args, context) => {
  const result = spawnSync(command, [...args], {
    cwd: context.cwd,
    env: context.env,
    stdio: "inherit",
  });
  return { status: result.status, ...(result.error ? { error: result.error } : {}) };
};

export async function defaultConnect(databaseUrl: string): Promise<DatabaseConnection> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return {
    client,
    close: async () => {
      await client.end();
    },
  };
}
