import type { Column, Table } from "drizzle-orm";
import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  type SQL,
} from "drizzle-orm";
import type { ColumnFilter, DslQueryFilter } from "./QueryOptions.js";

/**
 * Translate the neutral `DslQueryFilter` DSL into a Drizzle `SQL` expression
 * suitable for `db.query.<table>.findMany({ where: ... })` or
 * `db.select().from(table).where(...)`.
 *
 * Filters are AND-combined across columns. Per-column filter objects with
 * multiple operators are also AND-combined (e.g., `{ age: { gte: 18, lt: 30 } }`
 * → `age >= 18 AND age < 30`).
 *
 * Returns `undefined` when the filter is empty so callers can spread it
 * conditionally without producing an empty `WHERE`.
 *
 * Unknown columns (not present on the table) are *silently dropped*, which
 * matches the `validate('query', schema)` upstream contract — by the time
 * a filter reaches `buildWhere`, the schema layer has already validated
 * shape; this function is the ORM-translation step, not validation.
 */
export function buildWhere<TTable extends Table>(
  table: TTable,
  filter?: DslQueryFilter,
): SQL | undefined {
  if (!filter) return undefined;

  const columns = table as unknown as { [K: string]: Column } as Record<string, Column>;
  const conditions: SQL[] = [];

  for (const [key, raw] of Object.entries(filter)) {
    if (raw === undefined) continue;

    const column = columns[key];
    if (!column || !isColumn(column)) continue; // silently drop unknown columns

    appendColumnConditions(column, raw as ColumnFilter, conditions);
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

function isColumn(value: unknown): value is Column {
  return (
    typeof value === "object" &&
    value !== null &&
    // Drizzle columns expose `.name` and `.dataType` consistently.
    typeof (value as { name?: unknown }).name === "string"
  );
}

function appendColumnConditions(column: Column, raw: ColumnFilter, out: SQL[]): void {
  // Bare value → eq shorthand
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw instanceof Date) {
    out.push(eq(column, raw as never));
    return;
  }

  const f = raw as Exclude<ColumnFilter, unknown> extends never ? never : Record<string, unknown>;
  const filter = f as Record<string, unknown>;

  if ("eq" in filter && filter.eq !== undefined) out.push(eq(column, filter.eq as never));
  if ("ne" in filter && filter.ne !== undefined) out.push(ne(column, filter.ne as never));
  if ("gt" in filter && filter.gt !== undefined) out.push(gt(column, filter.gt as never));
  if ("gte" in filter && filter.gte !== undefined) out.push(gte(column, filter.gte as never));
  if ("lt" in filter && filter.lt !== undefined) out.push(lt(column, filter.lt as never));
  if ("lte" in filter && filter.lte !== undefined) out.push(lte(column, filter.lte as never));
  if ("in" in filter && Array.isArray(filter.in)) {
    out.push(inArray(column, filter.in as never[]));
  }
  if ("like" in filter && typeof filter.like === "string") out.push(like(column, filter.like));
  if ("ilike" in filter && typeof filter.ilike === "string") out.push(ilike(column, filter.ilike));
  if ("isNull" in filter && typeof filter.isNull === "boolean") {
    out.push(filter.isNull ? isNull(column) : isNotNull(column));
  }
}
