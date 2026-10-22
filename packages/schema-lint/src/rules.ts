import type { SqlStatement } from "./statements.js";

/**
 * Rule identifiers. Each rule encodes one production schema rule: never
 * remove, rename, or retype a production column; additive is not the same as
 * non-blocking; data moves outside the DDL transaction.
 */
export const RULE_IDS = [
  "table-drop",
  "table-rename",
  "column-drop",
  "column-rename",
  "column-type-change",
  "not-null-without-default",
  "set-not-null",
  "non-concurrent-index",
  "backfill-in-ddl-transaction",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export function isRuleId(value: unknown): value is RuleId {
  return typeof value === "string" && (RULE_IDS as readonly string[]).includes(value);
}

export interface Finding {
  readonly ruleId: RuleId;
  /** Migration tag (file name without `.sql`). */
  readonly migration: string;
  readonly statementIndex: number;
  readonly line: number;
  /** Normalized statement text, truncated for display. */
  readonly statement: string;
  readonly table?: string;
  readonly column?: string;
  readonly message: string;
  /** Safe multi-step recipe, one step per entry. */
  readonly recipe: readonly string[];
}

export interface TableReference {
  readonly schema: string;
  readonly name: string;
}

export function tableKey(reference: TableReference): string {
  return `${reference.schema}.${reference.name}`;
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(${IDENTIFIER})(?:\.(${IDENTIFIER}))?`;

const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`,
  "iu",
);
const DROP_TABLE = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}`, "iu");
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s*\*?\s+([\s\S]+)$`,
  "iu",
);
const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENTIFIER}\s+)?ON\s+(?:ONLY\s+)?${QUALIFIED}`,
  "iu",
);
const RENAME_TABLE = new RegExp(String.raw`^RENAME\s+TO\s+(${IDENTIFIER})`, "iu");
const RENAME_COLUMN = new RegExp(
  String.raw`^RENAME\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+TO\s+(${IDENTIFIER})`,
  "iu",
);
const DROP_COLUMN = new RegExp(
  String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENTIFIER})`,
  "iu",
);
const ALTER_COLUMN_TYPE = new RegExp(
  String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+(?:SET\s+DATA\s+)?TYPE\s+`,
  "iu",
);
const ALTER_COLUMN_SET_NOT_NULL = new RegExp(
  String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+SET\s+NOT\s+NULL`,
  "iu",
);
const ADD_COLUMN = new RegExp(
  String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})\s+([\s\S]+)$`,
  "iu",
);
const ADD_CONSTRAINT = /^ADD\s+(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE)\b/iu;
const DDL_STATEMENT =
  /^(?:CREATE|ALTER|DROP)\s+(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|UNIQUE)\s+)*(?:TABLE|INDEX|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW|SCHEMA|DOMAIN|FUNCTION|TRIGGER|POLICY)\b/iu;
const BACKFILL_STATEMENT =
  /^(?:UPDATE\s|DELETE\s+FROM\s|MERGE\s+INTO\s|INSERT\s+INTO\s+[\s\S]+?\b(?:SELECT|WITH)\b)/iu;
const WITH_STATEMENT = /^WITH\s[\s\S]*\b(?:UPDATE|DELETE|INSERT|MERGE)\b/iu;

/** Normalizes a possibly quoted, possibly schema-qualified table reference. */
export function parseTableReference(
  first: string | undefined,
  second: string | undefined,
): TableReference {
  if (second !== undefined) {
    return { schema: unquote(first ?? ""), name: unquote(second) };
  }
  return { schema: "public", name: unquote(first ?? "") };
}

export function unquote(identifier: string): string {
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/gu, '"');
  }
  return identifier.toLowerCase();
}

/** Returns the table a `CREATE TABLE` statement creates, if it is one. */
export function createdTable(statement: SqlStatement): TableReference | undefined {
  const match = CREATE_TABLE.exec(statement.code);
  return match ? parseTableReference(match[1], match[2]) : undefined;
}

export function isDdlStatement(statement: SqlStatement): boolean {
  return DDL_STATEMENT.test(statement.code);
}

export function isBackfillStatement(statement: SqlStatement): boolean {
  return BACKFILL_STATEMENT.test(statement.code) || WITH_STATEMENT.test(statement.code);
}

export interface StatementContext {
  readonly migration: string;
  /** Tables created earlier in the same migration file (`schema.name`). */
  readonly createdInMigration: ReadonlySet<string>;
  /** Whether the migration file contains any DDL statement. */
  readonly migrationHasDdl: boolean;
}

/** Evaluates every rule against one statement. */
export function evaluateStatement(
  statement: SqlStatement,
  context: StatementContext,
): readonly Finding[] {
  const findings: Finding[] = [];
  const base = {
    migration: context.migration,
    statementIndex: statement.index,
    line: statement.line,
    statement: truncate(statement.code),
  };
  const isNew = (table: TableReference): boolean => context.createdInMigration.has(tableKey(table));

  const dropTable = DROP_TABLE.exec(statement.code);
  if (dropTable) {
    const table = parseTableReference(dropTable[1], dropTable[2]);
    findings.push({
      ...base,
      ruleId: "table-drop",
      table: tableKey(table),
      message: `drops table ${tableKey(table)}`,
      recipe: RECIPES["table-drop"],
    });
  }

  const createIndex = CREATE_INDEX.exec(statement.code);
  if (createIndex && !createIndex[1]) {
    const table = parseTableReference(createIndex[2], createIndex[3]);
    if (!isNew(table)) {
      findings.push({
        ...base,
        ruleId: "non-concurrent-index",
        table: tableKey(table),
        message: `creates an index on existing table ${tableKey(table)} without CONCURRENTLY`,
        recipe: RECIPES["non-concurrent-index"],
      });
    }
  }

  const alterTable = ALTER_TABLE.exec(statement.code);
  if (alterTable) {
    const table = parseTableReference(alterTable[1], alterTable[2]);
    const key = tableKey(table);
    for (const action of splitActions(alterTable[3] ?? "")) {
      const renameTable = RENAME_TABLE.exec(action);
      if (renameTable) {
        findings.push({
          ...base,
          ruleId: "table-rename",
          table: key,
          message: `renames table ${key} to ${unquote(renameTable[1] ?? "")}`,
          recipe: RECIPES["table-rename"],
        });
        continue;
      }
      const renameColumn = RENAME_COLUMN.exec(action);
      if (renameColumn) {
        const column = unquote(renameColumn[1] ?? "");
        findings.push({
          ...base,
          ruleId: "column-rename",
          table: key,
          column,
          message: `renames column ${key}.${column} to ${unquote(renameColumn[2] ?? "")}`,
          recipe: RECIPES["column-rename"],
        });
        continue;
      }
      const dropColumn = DROP_COLUMN.exec(action);
      if (dropColumn && !/^DROP\s+CONSTRAINT\b/iu.test(action)) {
        const column = unquote(dropColumn[1] ?? "");
        findings.push({
          ...base,
          ruleId: "column-drop",
          table: key,
          column,
          message: `drops column ${key}.${column}`,
          recipe: RECIPES["column-drop"],
        });
        continue;
      }
      const alterType = ALTER_COLUMN_TYPE.exec(action);
      if (alterType) {
        const column = unquote(alterType[1] ?? "");
        findings.push({
          ...base,
          ruleId: "column-type-change",
          table: key,
          column,
          message: `changes the type of column ${key}.${column}`,
          recipe: RECIPES["column-type-change"],
        });
        continue;
      }
      const setNotNull = ALTER_COLUMN_SET_NOT_NULL.exec(action);
      if (setNotNull && !isNew(table)) {
        const column = unquote(setNotNull[1] ?? "");
        findings.push({
          ...base,
          ruleId: "set-not-null",
          table: key,
          column,
          message: `sets NOT NULL on existing column ${key}.${column} with a full-table scan under ACCESS EXCLUSIVE`,
          recipe: RECIPES["set-not-null"],
        });
        continue;
      }
      const addColumn = ADD_COLUMN.exec(action);
      if (addColumn && !ADD_CONSTRAINT.test(action) && !isNew(table)) {
        const column = unquote(addColumn[1] ?? "");
        const definition = addColumn[2] ?? "";
        const notNull =
          /\bNOT\s+NULL\b/iu.test(definition) || /\bPRIMARY\s+KEY\b/iu.test(definition);
        const hasDefault =
          /\bDEFAULT\b/iu.test(definition) ||
          /\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\b/iu.test(definition);
        if (notNull && !hasDefault) {
          findings.push({
            ...base,
            ruleId: "not-null-without-default",
            table: key,
            column,
            message: `adds NOT NULL column ${key}.${column} to an existing table without a DEFAULT`,
            recipe: RECIPES["not-null-without-default"],
          });
        }
      }
    }
  }

  if (context.migrationHasDdl && isBackfillStatement(statement)) {
    findings.push({
      ...base,
      ruleId: "backfill-in-ddl-transaction",
      message: "modifies rows in the same migration (and transaction) as schema changes",
      recipe: RECIPES["backfill-in-ddl-transaction"],
    });
  }

  return findings;
}

/** Splits `ALTER TABLE` actions on top-level commas. */
function splitActions(body: string): readonly string[] {
  const actions: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | undefined;
  for (const character of body) {
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      actions.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) actions.push(current.trim());
  return actions;
}

function truncate(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export const RULE_SUMMARIES: Readonly<Record<RuleId, string>> = Object.freeze({
  "table-drop":
    "Dropping a table destroys production data and breaks every running release that reads it.",
  "table-rename": "Renaming a table breaks every running release that references the old name.",
  "column-drop":
    "Dropping a column destroys production data and breaks every running release that reads it.",
  "column-rename": "Renaming a column breaks every running release that references the old name.",
  "column-type-change":
    "Changing a column type rewrites the table under an ACCESS EXCLUSIVE lock and breaks readers of the old type.",
  "not-null-without-default":
    "Adding a NOT NULL column without a default fails on any table that already has rows.",
  "set-not-null":
    "SET NOT NULL scans the whole table under an ACCESS EXCLUSIVE lock, blocking reads and writes for the duration.",
  "non-concurrent-index":
    "CREATE INDEX without CONCURRENTLY holds a SHARE lock that blocks writes for the whole build.",
  "backfill-in-ddl-transaction":
    "Backfilling rows inside the DDL transaction holds the schema locks for the duration of the data move.",
});

export const RECIPES: Readonly<Record<RuleId, readonly string[]>> = Object.freeze({
  "table-drop": [
    "Stop every reader and writer of the table in a release that ships first.",
    "Leave the table in place for at least one full release cycle; keep it out of the application schema with a comment.",
    "Archive or export the data if it has any retention value.",
    "Only then drop it, in its own migration, with a justification in the allowlist.",
  ],
  "table-rename": [
    "Create the new table (or a view with the new name over the old table) in an additive migration.",
    "Dual-write from the application until every running release reads the new name.",
    "Backfill in a separate batched job, not in a migration.",
    "Retire the old table with the table-drop recipe once nothing references it.",
  ],
  "column-drop": [
    "Remove every read and write of the column from the application and ship that release first.",
    "Keep the column for at least one full release cycle so a rollback still has its data.",
    "Drop the column in its own migration afterwards, with a justification in the allowlist.",
  ],
  "column-rename": [
    "Add the new column in an additive migration (nullable, or with a default).",
    "Dual-write both columns from the application; read the new column with a fallback to the old one.",
    "Backfill the new column in a separate batched job, outside any DDL transaction.",
    "Once every running release uses the new column, retire the old one with the column-drop recipe.",
  ],
  "column-type-change": [
    "Add a new column with the target type in an additive migration.",
    "Dual-write both columns from the application and backfill the new column in a separate batched job.",
    "Switch reads to the new column, then retire the old column with the column-drop recipe.",
    "If the change is a widening the planner treats as binary-compatible (for example varchar(50) -> text), allowlist it with that justification.",
  ],
  "not-null-without-default": [
    "Add the column as nullable (or with a constant DEFAULT, which PostgreSQL 11+ applies without rewriting rows).",
    "Backfill existing rows in a separate batched job.",
    "Add a CHECK (column IS NOT NULL) NOT VALID constraint, then VALIDATE CONSTRAINT in its own statement.",
    "Finally SET NOT NULL (PostgreSQL 12+ uses the validated constraint and skips the scan) and drop the CHECK.",
  ],
  "set-not-null": [
    "Add a CHECK (column IS NOT NULL) NOT VALID constraint in one migration.",
    "VALIDATE CONSTRAINT in a later migration; validation takes only a SHARE UPDATE EXCLUSIVE lock.",
    "Then SET NOT NULL (PostgreSQL 12+ proves it from the validated constraint without a scan) and drop the CHECK.",
  ],
  "non-concurrent-index": [
    "Use CREATE INDEX CONCURRENTLY [IF NOT EXISTS] so writers are not blocked for the build.",
    "CONCURRENTLY cannot run inside a transaction and Drizzle applies each migration file in one; run the index as its own release step or an operational task, and record that in the allowlist justification if the migration must keep the plain CREATE INDEX for a small table.",
    "Indexes on a table created in the same migration are exempt: the table is empty and unreferenced.",
  ],
  "backfill-in-ddl-transaction": [
    "Keep the migration to schema changes only.",
    "Move the data change into a separate migration, or better a batched application job that commits in bounded chunks.",
    "Seed rows with plain INSERT ... VALUES are not flagged; UPDATE, DELETE, MERGE, and INSERT ... SELECT are.",
  ],
});
