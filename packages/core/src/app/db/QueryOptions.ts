/**
 * Neutral query-operator DSL — load-bearing decision #2 from the v4 plan.
 *
 * The DSL is the contract between the HTTP layer (which parses query-strings
 * like `?where[name][ilike]=foo&where[age][gte]=18`) and the data layer
 * (`DrizzleEntityService` translates DSL → Drizzle `where` SQL). It is
 * deliberately ORM-neutral: keeping query semantics decoupled from Drizzle
 * means a future ORM swap doesn't break the public REST contract, and the
 * same DSL feeds both Drizzle and any future read-replica / cache-aware
 * variants.
 *
 * Documented operators only. Anything outside this set rejects at parse
 * time so consumers can't smuggle ORM-specific syntax through.
 *
 * v3's `services/interfaces/QueryOptions.ts` (TypeORM-flavored) stays in
 * place during the parallel-path build; this v4 module replaces it at the
 * cut-over.
 */

export type QueryOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "like"
  | "ilike"
  | "isNull";

/**
 * One column's filter clause. Either a bare value (shorthand for `eq`) or an
 * operator-keyed object. Multiple operators on one column are AND-combined
 * (e.g., `{ age: { gte: 18, lt: 30 } }`).
 */
export type ColumnFilter<TValue = unknown> =
  | TValue
  | {
      eq?: TValue;
      ne?: TValue;
      gt?: TValue;
      gte?: TValue;
      lt?: TValue;
      lte?: TValue;
      in?: readonly TValue[];
      /** SQL `LIKE`. Pattern uses `%` / `_` wildcards. */
      like?: string;
      /** Case-insensitive `LIKE` (Postgres `ILIKE`). */
      ilike?: string;
      /** `IS NULL` (true) or `IS NOT NULL` (false). */
      isNull?: boolean;
    };

/**
 * A `where` filter — record of column names to per-column filters.
 *
 * Multiple columns are AND-combined. To express OR, callers pass an array
 * of filters at the service level (`getAll({ where: [filterA, filterB] })`)
 * — the OR layer is at the service surface, not the DSL — keeps the DSL
 * flat and analyzable.
 */
export type DslQueryFilter<TRow = Record<string, unknown>> = {
  [K in keyof TRow]?: ColumnFilter<TRow[K]>;
};

/** A single `ORDER BY` clause. */
export interface OrderClause<TRow = Record<string, unknown>> {
  field: keyof TRow & string;
  direction: "asc" | "desc";
  /** `nulls first|last` — defaults to Postgres' default per direction. */
  nulls?: "first" | "last";
}

/**
 * Full query options accepted by `DrizzleEntityService` reads. Used by both
 * controller-side parsing (from query strings) and direct service calls.
 */
export interface QueryOptions<TRow = Record<string, unknown>, TRelation extends string = string> {
  where?: DslQueryFilter<TRow>;
  /** Relations to eager-load (Drizzle `with: { role: true }`). */
  relations?: readonly TRelation[];
  order?: readonly OrderClause<TRow>[];
  limit?: number;
  offset?: number;
  /** Free-text search across the entity's `getDefaultSearchFields()`. */
  search?: string;
  /**
   * Include soft-deleted rows (rows with non-null `deletedAt`). Defaults
   * `false` — soft-deleted rows are filtered out automatically.
   */
  includeDeleted?: boolean;
}

/**
 * Type guards / refinement helpers for the parser layer.
 */
export const QUERY_OPERATORS: ReadonlySet<QueryOperator> = new Set<QueryOperator>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "like",
  "ilike",
  "isNull",
]);

export function isQueryOperator(value: unknown): value is QueryOperator {
  return typeof value === "string" && QUERY_OPERATORS.has(value as QueryOperator);
}
