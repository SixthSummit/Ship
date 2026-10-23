import { readFile, writeFile } from "node:fs/promises";

/** Minimal query surface; `pg.Pool`, `pg.Client`, and `pg.PoolClient` all satisfy it. */
export interface SnapshotQueryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface SnapshotColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  /** `a` (always) or `d` (by default) for identity columns, otherwise absent. */
  readonly identity?: "a" | "d";
  readonly generated?: boolean;
}

export interface SnapshotConstraint {
  readonly name: string;
  readonly type: string;
  readonly definition: string;
}

export interface SnapshotIndex {
  readonly name: string;
  readonly definition: string;
}

export interface SnapshotTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly SnapshotColumn[];
  readonly constraints: readonly SnapshotConstraint[];
  readonly indexes: readonly SnapshotIndex[];
}

export interface SnapshotEnum {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
}

export interface SchemaSnapshot {
  readonly schemaVersion: 1;
  readonly schemas: readonly string[];
  readonly enums: readonly SnapshotEnum[];
  readonly tables: readonly SnapshotTable[];
}

export interface CaptureSnapshotOptions {
  /** Schemas to capture; defaults to `public`. */
  readonly schemas?: readonly string[];
  /** Table names to leave out; Drizzle's migrations ledger is always excluded. */
  readonly excludeTables?: readonly string[];
}

const ALWAYS_EXCLUDED = ["__drizzle_migrations"];

/**
 * Captures the physical schema from `pg_catalog`: tables, columns (with
 * `format_type` and defaults), constraints (`pg_get_constraintdef`), indexes
 * (`pg_get_indexdef`), and enums. Everything is sorted so the output is
 * canonical for the same database state.
 */
export async function captureSchemaSnapshot(
  client: SnapshotQueryable,
  options: CaptureSnapshotOptions = {},
): Promise<SchemaSnapshot> {
  const schemas = [...(options.schemas ?? ["public"])].sort();
  const excluded = new Set([...ALWAYS_EXCLUDED, ...(options.excludeTables ?? [])]);

  const tableRows = (
    await client.query(
      `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[])
       ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;
  const columnRows = (
    await client.query(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expression,
              a.attidentity AS identity, a.attgenerated AS generated
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
         AND n.nspname = ANY($1::text[])
       ORDER BY 1, 2, 3`,
      [schemas],
    )
  ).rows;
  const constraintRows = (
    await client.query(
      `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
              con.contype AS type, pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY($1::text[])
       ORDER BY 1, 2, 3`,
      [schemas],
    )
  ).rows;
  const indexRows = (
    await client.query(
      `SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS definition
       FROM pg_catalog.pg_indexes
       WHERE schemaname = ANY($1::text[])
       ORDER BY 1, 2, 3`,
      [schemas],
    )
  ).rows;
  const enumRows = (
    await client.query(
      `SELECT n.nspname AS schema, t.typname AS name,
              array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = ANY($1::text[])
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;

  const tables: SnapshotTable[] = [];
  for (const row of sortRows(tableRows, "schema", "name")) {
    const schema = String(row.schema);
    const name = String(row.name);
    if (excluded.has(name)) continue;
    const matches = (candidate: Record<string, unknown>): boolean =>
      candidate.schema === schema && candidate.table === name;
    tables.push({
      schema,
      name,
      columns: sortRows(columnRows.filter(matches), "name").map((column) => {
        const identity =
          column.identity === "a" || column.identity === "d" ? column.identity : undefined;
        const generated = column.generated === "s";
        return {
          name: String(column.name),
          type: String(column.type),
          nullable: column.not_null !== true,
          default:
            column.default_expression === null || column.default_expression === undefined
              ? null
              : String(column.default_expression),
          ...(identity ? { identity } : {}),
          ...(generated ? { generated } : {}),
        };
      }),
      constraints: sortRows(constraintRows.filter(matches), "name").map((constraint) => ({
        name: String(constraint.name),
        type: String(constraint.type),
        definition: String(constraint.definition),
      })),
      indexes: sortRows(indexRows.filter(matches), "name").map((index) => ({
        name: String(index.name),
        definition: String(index.definition),
      })),
    });
  }

  return {
    schemaVersion: 1,
    schemas,
    enums: sortRows(enumRows, "schema", "name").map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      values: (row.values as unknown[]).map(String),
    })),
    tables,
  };
}

/**
 * Sorts by code point rather than relying on the database's collation, so the
 * same physical schema serializes identically on every PostgreSQL instance.
 */
function sortRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  ...keys: readonly string[]
): T[] {
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const a = String(left[key]);
      const b = String(right[key]);
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
}

export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export class SnapshotFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFileError";
  }
}

export async function readSnapshotFile(path: string): Promise<SchemaSnapshot> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new SnapshotFileError(`cannot read snapshot ${path}: ${(error as Error).message}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new SnapshotFileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (
    typeof document !== "object" ||
    document === null ||
    (document as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((document as { tables?: unknown }).tables)
  ) {
    throw new SnapshotFileError(`${path} is not a schema snapshot (schemaVersion 1 with tables)`);
  }
  return document as SchemaSnapshot;
}

export interface SnapshotDifference {
  readonly kind: "added" | "removed" | "changed";
  /** Dotted path such as `table public.orders.column total.type`. */
  readonly path: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

/** Structural diff: `expected` is the committed snapshot, `actual` the live database. */
export function diffSchemaSnapshots(
  expected: SchemaSnapshot,
  actual: SchemaSnapshot,
): readonly SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];

  diffNamed(
    differences,
    "enum",
    expected.enums,
    actual.enums,
    (item) => `${item.schema}.${item.name}`,
    (path, left, right) => {
      if (JSON.stringify(left.values) !== JSON.stringify(right.values)) {
        differences.push({
          kind: "changed",
          path: `${path}.values`,
          expected: left.values,
          actual: right.values,
        });
      }
    },
  );

  diffNamed(
    differences,
    "table",
    expected.tables,
    actual.tables,
    (item) => `${item.schema}.${item.name}`,
    (path, left, right) => {
      diffNamed(
        differences,
        `${path}.column`,
        left.columns,
        right.columns,
        (column) => column.name,
        (columnPath, a, b) => {
          for (const field of ["type", "nullable", "default", "identity", "generated"] as const) {
            if (JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null)) {
              differences.push({
                kind: "changed",
                path: `${columnPath}.${field}`,
                expected: a[field] ?? null,
                actual: b[field] ?? null,
              });
            }
          }
        },
      );
      diffNamed(
        differences,
        `${path}.constraint`,
        left.constraints,
        right.constraints,
        (constraint) => constraint.name,
        (constraintPath, a, b) => {
          if (a.definition !== b.definition || a.type !== b.type) {
            differences.push({
              kind: "changed",
              path: `${constraintPath}.definition`,
              expected: a.definition,
              actual: b.definition,
            });
          }
        },
      );
      diffNamed(
        differences,
        `${path}.index`,
        left.indexes,
        right.indexes,
        (index) => index.name,
        (indexPath, a, b) => {
          if (a.definition !== b.definition) {
            differences.push({
              kind: "changed",
              path: `${indexPath}.definition`,
              expected: a.definition,
              actual: b.definition,
            });
          }
        },
      );
    },
  );

  return differences;
}

function diffNamed<T>(
  differences: SnapshotDifference[],
  label: string,
  expected: readonly T[],
  actual: readonly T[],
  key: (item: T) => string,
  compare: (path: string, left: T, right: T) => void,
): void {
  const actualByKey = new Map(actual.map((item) => [key(item), item]));
  const seen = new Set<string>();
  for (const item of expected) {
    const name = key(item);
    seen.add(name);
    const path = `${label} ${name}`;
    const counterpart = actualByKey.get(name);
    if (!counterpart) {
      differences.push({ kind: "removed", path, expected: item });
      continue;
    }
    compare(path, item, counterpart);
  }
  for (const item of actual) {
    const name = key(item);
    if (!seen.has(name))
      differences.push({ kind: "added", path: `${label} ${name}`, actual: item });
  }
}

export interface SnapshotCheckResult {
  readonly command: "snapshot-check";
  readonly ok: boolean;
  readonly exitCode: number;
  readonly snapshotPath: string;
  readonly differences: readonly SnapshotDifference[];
}

/** Compares the committed snapshot with the live database; drift exits 1. */
export async function checkSchemaSnapshot(options: {
  readonly client: SnapshotQueryable;
  readonly snapshotPath: string;
  readonly capture?: CaptureSnapshotOptions;
}): Promise<SnapshotCheckResult> {
  const expected = await readSnapshotFile(options.snapshotPath);
  const actual = await captureSchemaSnapshot(options.client, {
    schemas: expected.schemas,
    ...options.capture,
  });
  const differences = diffSchemaSnapshots(expected, actual);
  return {
    command: "snapshot-check",
    ok: differences.length === 0,
    exitCode: differences.length === 0 ? 0 : 1,
    snapshotPath: options.snapshotPath,
    differences,
  };
}

export async function writeSchemaSnapshot(options: {
  readonly client: SnapshotQueryable;
  readonly snapshotPath: string;
  readonly capture?: CaptureSnapshotOptions;
}): Promise<SchemaSnapshot> {
  const snapshot = await captureSchemaSnapshot(options.client, options.capture);
  await writeFile(options.snapshotPath, serializeSnapshot(snapshot), "utf8");
  return snapshot;
}

export function formatSnapshotDifferences(result: SnapshotCheckResult): string {
  if (result.ok) return `schema snapshot matches ${result.snapshotPath}\n`;
  const lines = result.differences.map((difference) => {
    switch (difference.kind) {
      case "added":
        return `+ ${difference.path} (in database, not in snapshot)`;
      case "removed":
        return `- ${difference.path} (in snapshot, not in database)`;
      default:
        return `~ ${difference.path}: ${JSON.stringify(difference.expected)} -> ${JSON.stringify(difference.actual)}`;
    }
  });
  lines.push(
    `schema snapshot drift: ${result.differences.length} difference(s) between ${result.snapshotPath} and the database. Regenerate the snapshot through the release step (ship-schema-lint snapshot write) only when the migrations themselves changed; otherwise the database was edited by hand.`,
  );
  return `${lines.join("\n")}\n`;
}
