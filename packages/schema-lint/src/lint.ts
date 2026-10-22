import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type AllowEntry,
  type Allowlist,
  AllowlistError,
  EMPTY_ALLOWLIST,
  readAllowlistFile,
  readInlineDirectives,
} from "./allowlist.js";
import {
  createdTable,
  evaluateStatement,
  type Finding,
  isDdlStatement,
  RULE_SUMMARIES,
  tableKey,
} from "./rules.js";
import { splitSqlStatements } from "./statements.js";

/** Stable process exit codes shared by every command. */
export const SCHEMA_LINT_EXIT = Object.freeze({
  /** No findings, no drift. */
  ok: 0,
  /** Unsafe migration findings, stale allowlist entries, or snapshot drift. */
  findings: 1,
  /** Invalid input: missing directory, unreadable allowlist, malformed journal, bad flags. */
  invalid: 2,
  /** The command refused to run (for example a release step outside a release context). */
  refused: 3,
});

export interface MigrationSource {
  /** Migration tag: the file name without `.sql`. */
  readonly tag: string;
  readonly sql: string;
  /** Absolute file path when read from disk. */
  readonly file?: string;
}

export interface AllowedFinding {
  readonly finding: Finding;
  readonly justification: string;
  readonly source: AllowEntry["source"];
}

export interface LintResult {
  readonly command: "check";
  readonly ok: boolean;
  readonly exitCode: number;
  readonly migrationsDir?: string;
  readonly migrations: number;
  readonly linted: number;
  readonly findings: readonly Finding[];
  readonly allowed: readonly AllowedFinding[];
  readonly unusedAllowlist: readonly AllowEntry[];
}

export interface LintSqlOptions {
  readonly allowlist?: Allowlist;
  /** Only report findings from migrations after this tag; earlier ones still feed table state. */
  readonly since?: string;
}

export class MigrationSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationSourceError";
  }
}

/**
 * Reads a Drizzle migrations directory. Order follows `meta/_journal.json`
 * when present (the order the migrator applies); otherwise `.sql` files are
 * sorted by name, which matches Drizzle's zero-padded prefixes.
 */
export async function readMigrationsDirectory(
  directory: string,
): Promise<readonly MigrationSource[]> {
  const root = resolve(directory);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    throw new MigrationSourceError(
      `cannot read migrations directory ${root}: ${(error as Error).message}`,
    );
  }
  const sqlFiles = names.filter((name) => name.endsWith(".sql")).sort();
  let ordered: string[];
  if (names.includes("meta")) {
    ordered = await readJournalOrder(root, sqlFiles);
  } else {
    ordered = sqlFiles;
  }
  const sources: MigrationSource[] = [];
  for (const name of ordered) {
    const file = resolve(root, name);
    sources.push({ tag: basename(name, ".sql"), sql: await readFile(file, "utf8"), file });
  }
  return sources;
}

async function readJournalOrder(root: string, sqlFiles: readonly string[]): Promise<string[]> {
  const journalPath = resolve(root, "meta", "_journal.json");
  let journal: unknown;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8"));
  } catch {
    return [...sqlFiles];
  }
  if (
    typeof journal !== "object" ||
    journal === null ||
    !Array.isArray((journal as { entries?: unknown }).entries)
  ) {
    throw new MigrationSourceError(`${journalPath} must contain an entries array`);
  }
  const ordered: string[] = [];
  for (const entry of (journal as { entries: unknown[] }).entries) {
    const tag = (entry as { tag?: unknown })?.tag;
    if (typeof tag !== "string")
      throw new MigrationSourceError(`${journalPath} has an entry without a tag`);
    const name = `${tag}.sql`;
    if (!sqlFiles.includes(name))
      throw new MigrationSourceError(`${journalPath} lists ${tag} but ${name} is missing`);
    ordered.push(name);
  }
  return ordered;
}

/** Pure linter over already-loaded migration sources. */
export function lintMigrationSql(
  migrations: readonly MigrationSource[],
  options: LintSqlOptions = {},
): LintResult {
  const allowlist = options.allowlist ?? EMPTY_ALLOWLIST;
  const inlineEntries: AllowEntry[] = [];
  const inlineProblems: string[] = [];
  const rawFindings: Finding[] = [];
  let reporting = options.since === undefined && allowlist.baseline === undefined;
  let linted = 0;
  const sinceTag = options.since ?? allowlist.baseline;
  if (sinceTag !== undefined && !migrations.some((migration) => migration.tag === sinceTag)) {
    throw new MigrationSourceError(`baseline migration ${sinceTag} is not in the migration set`);
  }

  for (const migration of migrations) {
    const statements = splitSqlStatements(migration.sql);
    const migrationHasDdl = statements.some(isDdlStatement);
    const createdInMigration = new Set<string>();
    for (const statement of statements) {
      const directives = readInlineDirectives(migration.tag, statement.leadingComments);
      inlineEntries.push(...directives.entries);
      inlineProblems.push(...directives.problems);
      if (reporting) {
        rawFindings.push(
          ...evaluateStatement(statement, {
            migration: migration.tag,
            createdInMigration,
            migrationHasDdl,
          }),
        );
      }
      const created = createdTable(statement);
      if (created) {
        createdInMigration.add(tableKey(created));
      }
    }
    if (reporting) linted += 1;
    if (migration.tag === sinceTag) reporting = true;
  }

  if (inlineProblems.length > 0) throw new AllowlistError(inlineProblems);

  const entries = [...allowlist.entries, ...inlineEntries];
  const used = new Set<AllowEntry>();
  const findings: Finding[] = [];
  const allowed: AllowedFinding[] = [];
  for (const finding of rawFindings) {
    const entry = entries.find(
      (candidate) => candidate.migration === finding.migration && candidate.rule === finding.ruleId,
    );
    if (entry) {
      used.add(entry);
      allowed.push({ finding, justification: entry.justification, source: entry.source });
    } else {
      findings.push(finding);
    }
  }
  const knownTags = new Set(migrations.map((migration) => migration.tag));
  const unusedAllowlist = entries.filter(
    (entry) =>
      !used.has(entry) &&
      // Entries for migrations before the baseline are dormant, not stale.
      (knownTags.has(entry.migration)
        ? isAfterBaseline(entry.migration, migrations, sinceTag)
        : true),
  );

  const ok = findings.length === 0 && unusedAllowlist.length === 0;
  return {
    command: "check",
    ok,
    exitCode: ok ? SCHEMA_LINT_EXIT.ok : SCHEMA_LINT_EXIT.findings,
    migrations: migrations.length,
    linted,
    findings,
    allowed,
    unusedAllowlist,
  };
}

function isAfterBaseline(
  tag: string,
  migrations: readonly MigrationSource[],
  baseline: string | undefined,
): boolean {
  if (baseline === undefined) return true;
  const index = migrations.findIndex((migration) => migration.tag === tag);
  const baselineIndex = migrations.findIndex((migration) => migration.tag === baseline);
  return index > baselineIndex;
}

export interface LintOptions {
  readonly migrationsDir: string;
  readonly allowlistPath?: string;
  readonly since?: string;
}

/** Reads a migrations directory (and optional allowlist file) and lints it. */
export async function lintMigrations(options: LintOptions): Promise<LintResult> {
  const migrations = await readMigrationsDirectory(options.migrationsDir);
  const allowlist = options.allowlistPath
    ? await readAllowlistFile(options.allowlistPath)
    : undefined;
  const result = lintMigrationSql(migrations, { allowlist, since: options.since });
  return { ...result, migrationsDir: resolve(options.migrationsDir) };
}

/** Renders a lint result for humans: every finding with its recipe. */
export function formatLintReport(result: LintResult): string {
  const lines: string[] = [];
  const where = result.migrationsDir ? ` in ${result.migrationsDir}` : "";
  for (const finding of result.findings) {
    lines.push(
      `${finding.migration}.sql:${finding.line} [${finding.ruleId}] ${finding.message}`,
      `  ${finding.statement}`,
      `  ${RULE_SUMMARIES[finding.ruleId]}`,
      "  Safe recipe:",
      ...finding.recipe.map((step, index) => `    ${index + 1}. ${step}`),
      "",
    );
  }
  for (const entry of result.unusedAllowlist) {
    lines.push(
      `allowlist entry ${entry.migration} / ${entry.rule} (${entry.source}) matched nothing; remove it so the allowlist stays truthful.`,
      "",
    );
  }
  for (const allowed of result.allowed) {
    lines.push(
      `allowed ${allowed.finding.migration}.sql:${allowed.finding.line} [${allowed.finding.ruleId}] (${allowed.source}): ${allowed.justification}`,
    );
  }
  if (result.allowed.length > 0) lines.push("");
  lines.push(
    result.ok
      ? `schema lint passed: ${result.linted} of ${result.migrations} migrations linted${where}, ${result.allowed.length} allowed`
      : `schema lint failed: ${result.findings.length} finding(s), ${result.unusedAllowlist.length} stale allowlist entr(ies) across ${result.linted} linted migration(s)${where}`,
  );
  return `${lines.join("\n")}\n`;
}
