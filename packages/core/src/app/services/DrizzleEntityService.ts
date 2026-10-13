import {
  and,
  asc,
  type Column,
  count as countAggregate,
  desc,
  eq,
  ilike,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { NotFoundError } from "../../http/errors/NotFoundError.js";
import { withSpan } from "../../observability/tracing.js";
import { getRequestContext } from "../context/RequestContext.js";
import { buildWhere } from "../db/buildWhere.js";
import type { ShipDb } from "../db/client.js";
import type { DslQueryFilter, OrderClause, QueryOptions } from "../db/QueryOptions.js";
import {
  composeHooks,
  type QueryFilter as HookQueryFilter,
  type LifecycleHookContext,
  type LifecycleHooks,
} from "./hooks/LifecycleHooks.js";

/**
 * Generic CRUD/list/search base for Drizzle-backed services.
 *
 * Replaces v3's TypeORM `EntityService<T>`. Same surface (`get`, `getAll`,
 * `list`, `count`, etc.); abstract hooks renamed to fit Drizzle (`getTable()`
 * instead of `getEntityClass()`).
 *
 * **This batch (alpha-1, sub-batch 3b)** ships the read surface: `get`,
 * `getAll`, `list`, `count`, soft-delete filtering, free-text search across
 * `getDefaultSearchFields()`, and lifecycle-hook integration for
 * `beforeQuery`. Mutation methods (`create`, `update`, `delete`) and the
 * full lifecycle pair land in sub-batch 3c.
 *
 * Internally uses Drizzle's `db.select().from(table)` builder so the base
 * class is testable against a fake Drizzle-shaped client. Subclasses that
 * need nested relations should override the read methods to delegate to
 * `db.query.<table>.findMany(...)` — that path is opt-in until the
 * relational-query helpers in this base class mature.
 */

export interface ListResult<TRow> {
  rows: TRow[];
  total: number;
}

/** Fallback default order: newest first by `createdAt`. */
const DEFAULT_ORDER: readonly OrderClause[] = [{ field: "createdAt", direction: "desc" }];

export abstract class DrizzleEntityService<
  TTable extends PgTable,
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  constructor(protected readonly db: ShipDb<TSchema>) {}

  // ───────────────────── Abstract / overridable hooks ─────────────────────

  /** The Drizzle table this service operates on. */
  protected abstract getTable(): TTable;

  /** Relation keys to load by default. Currently advisory — used in v4.0 by
   *  subclasses that override read methods to delegate to the relational
   *  query builder. */
  protected getDefaultRelations(): readonly string[] {
    return [];
  }

  /** Default order for `getAll` / `list`. Override per service. */
  protected getDefaultOrder(): readonly OrderClause[] {
    return DEFAULT_ORDER;
  }

  /** Column names searched by free-text `?search=...`. Override per service. */
  protected getDefaultSearchFields(): readonly string[] {
    return [];
  }

  /** Compose lifecycle hooks for this service. Override to register hooks
   *  alongside framework-global ones. */
  protected getHooks(): LifecycleHooks {
    return {};
  }

  /**
   * Subclass-overridable hook for setting defaults / coercing optional fields
   * before persistence (translates v3 `EntityService.applyOptionalFields`).
   * Distinct from lifecycle hooks: this runs unconditionally per service,
   * before any composed `beforeCreate`/`beforeUpdate` hook.
   */
  protected async applyOptionalFields(values: unknown): Promise<unknown> {
    return values;
  }

  /**
   * Subclass-overridable hook for resolving "find or create by ID" relation
   * references before INSERT (translates v3 `EntityService.handleRelationships`).
   * Default no-op.
   */
  protected async resolveRelationIds(values: unknown): Promise<unknown> {
    return values;
  }

  // ────────────────────────────── Read API ───────────────────────────────

  /** Fetch by primary-key `id`. Returns null when not found. Soft-deleted
   *  rows are hidden unless `opts.includeDeleted: true`. */
  async get(id: string, opts: QueryOptions = {}): Promise<unknown | null> {
    return withSpan(`${this.spanName()}.get`, async () => {
      const table = this.getTable();
      const idColumn = this.getColumn("id");
      if (!idColumn) {
        throw new Error(`${this.constructor.name}: getTable() must expose an "id" column`);
      }

      const userFilter = await this.runBeforeQuery(opts.where);
      const where = this.composeWhere(userFilter, eq(idColumn, id), opts.includeDeleted);

      const rows = (await this.db
        .select()
        .from(table as PgTable)
        .where(where)
        .limit(1)) as unknown[];

      return rows[0] ?? null;
    });
  }

  /** Fetch all rows matching the filter (no pagination). Default order applies. */
  async getAll(opts: QueryOptions = {}): Promise<unknown[]> {
    return withSpan(`${this.spanName()}.getAll`, async () => {
      const table = this.getTable();
      const userFilter = await this.runBeforeQuery(opts.where);
      const where = this.composeWhere(
        userFilter,
        this.searchExpr(opts.search),
        opts.includeDeleted,
      );
      const order = this.resolveOrder(opts.order);

      let q = this.db.select().from(table as PgTable) as unknown as {
        where(arg: SQL | SQLWrapper | undefined): typeof q;
        orderBy(...args: Array<SQL | SQLWrapper>): typeof q;
        limit(n: number): typeof q;
        offset(n: number): typeof q;
      };
      if (where) q = q.where(where);
      if (order.length > 0) q = q.orderBy(...order);
      if (opts.limit !== undefined) q = q.limit(opts.limit);
      if (opts.offset !== undefined) q = q.offset(opts.offset);

      return (await (q as unknown as Promise<unknown[]>)) as unknown[];
    });
  }

  /** Paginated list — returns rows + total count under the same filter. */
  async list(opts: QueryOptions = {}): Promise<ListResult<unknown>> {
    return withSpan(`${this.spanName()}.list`, async () => {
      const [rows, total] = await Promise.all([
        this.getAll(opts),
        this.count({ where: opts.where, search: opts.search, includeDeleted: opts.includeDeleted }),
      ]);
      return { rows, total };
    });
  }

  /** Count of rows matching the filter (ignores limit/offset/order). */
  async count(opts: QueryOptions = {}): Promise<number> {
    return withSpan(`${this.spanName()}.count`, async () => {
      const table = this.getTable();
      const userFilter = await this.runBeforeQuery(opts.where);
      const where = this.composeWhere(
        userFilter,
        this.searchExpr(opts.search),
        opts.includeDeleted,
      );

      let q = this.db.select({ value: countAggregate() }).from(table as PgTable) as unknown as {
        where(arg: SQL | SQLWrapper | undefined): typeof q;
      };
      if (where) q = q.where(where);

      const rows = await (q as unknown as Promise<Array<{ value: number | string }>>);
      const v = rows[0]?.value ?? 0;
      return typeof v === "string" ? Number.parseInt(v, 10) : v;
    });
  }

  // ───────────────────────────── Mutate API ─────────────────────────────

  /**
   * Insert a new row.
   * Pipeline: `applyOptionalFields` → `resolveRelationIds` → auto-stamp
   * `createdBy` from `RequestContext.userId` if column exists →
   * `beforeCreate` hook chain → INSERT … RETURNING * → `afterCreate` hooks.
   */
  async create(values: unknown): Promise<unknown> {
    return withSpan(`${this.spanName()}.create`, async () => {
      const ctx = (getRequestContext() ?? {}) as LifecycleHookContext;
      const composed = composeHooks(this.getHooks());

      let prepared = await this.applyOptionalFields(values);
      prepared = await this.resolveRelationIds(prepared);
      prepared = this.stampActor(prepared, "createdBy", ctx);

      const beforeResult = await composed.beforeCreate?.(prepared, ctx);
      if (beforeResult !== undefined) prepared = beforeResult;

      const inserted = (await this.db
        .insert(this.getTable() as PgTable)
        .values(prepared as never)
        .returning()) as unknown[];

      const row = inserted[0];
      if (row === undefined) {
        throw new Error(`${this.constructor.name}.create: INSERT returned no rows`);
      }

      await composed.afterCreate?.(row, ctx);
      return row;
    });
  }

  /**
   * Update by primary-key `id` with a partial patch.
   * Pipeline: load `prev` (404s if missing) → auto-stamp `updatedBy` →
   * `beforeUpdate` hook chain (receives `prev` + `patch`) → UPDATE …
   * RETURNING * → `afterUpdate` hooks (receive `prev` + `next` for diffing).
   *
   * `prev` is loaded *before* the write so audit / CDC consumers can compute
   * diffs reliably even on tables without history triggers.
   */
  async update(id: string, patch: unknown): Promise<unknown> {
    return withSpan(`${this.spanName()}.update`, async () => {
      const ctx = (getRequestContext() ?? {}) as LifecycleHookContext;
      const composed = composeHooks(this.getHooks());

      const prev = await this.get(id);
      if (prev === null) {
        throw new NotFoundError(`${this.constructor.name}: id "${id}" not found`);
      }

      let prepared = this.stampActor(patch, "updatedBy", ctx);

      const beforeResult = await composed.beforeUpdate?.(prev, prepared, ctx);
      if (beforeResult !== undefined) prepared = beforeResult;

      const idColumn = this.getColumn("id");
      if (!idColumn) {
        throw new Error(`${this.constructor.name}: getTable() must expose an "id" column`);
      }

      const updated = (await this.db
        .update(this.getTable() as PgTable)
        .set(prepared as never)
        .where(eq(idColumn, id))
        .returning()) as unknown[];

      const next = updated[0];
      if (next === undefined) {
        // Row vanished between the get() and the UPDATE — race condition.
        throw new NotFoundError(`${this.constructor.name}: id "${id}" disappeared during update`);
      }

      await composed.afterUpdate?.(prev, next, ctx);
      return next;
    });
  }

  /**
   * Delete by primary-key `id`.
   * Pipeline: load `prev` (404s if missing) → `beforeDelete` (may throw to
   * abort) → soft-delete (UPDATE deleted_at = now() + updatedBy) when the
   * table has a `deletedAt` column, otherwise hard DELETE → `afterDelete`.
   */
  async delete(id: string): Promise<unknown> {
    return withSpan(`${this.spanName()}.delete`, async () => {
      const ctx = (getRequestContext() ?? {}) as LifecycleHookContext;
      const composed = composeHooks(this.getHooks());

      const prev = await this.get(id);
      if (prev === null) {
        throw new NotFoundError(`${this.constructor.name}: id "${id}" not found`);
      }

      await composed.beforeDelete?.(prev, ctx);

      const idColumn = this.getColumn("id");
      if (!idColumn) {
        throw new Error(`${this.constructor.name}: getTable() must expose an "id" column`);
      }

      const deletedAtCol = this.getColumn("deletedAt");

      let row: unknown;
      if (deletedAtCol) {
        // Soft delete
        const updates: Record<string, unknown> = { deletedAt: new Date() };
        if (ctx.userId !== undefined && this.getColumn("updatedBy")) {
          updates.updatedBy = ctx.userId;
        }
        const result = (await this.db
          .update(this.getTable() as PgTable)
          .set(updates as never)
          .where(eq(idColumn, id))
          .returning()) as unknown[];
        row = result[0];
      } else {
        // Hard delete
        const result = (await this.db
          .delete(this.getTable() as PgTable)
          .where(eq(idColumn, id))
          .returning()) as unknown[];
        row = result[0];
      }

      if (row === undefined) {
        throw new NotFoundError(`${this.constructor.name}: id "${id}" disappeared during delete`);
      }

      await composed.afterDelete?.(row, ctx);
      return row;
    });
  }

  // ──────────────────────────── Helpers ──────────────────────────────────

  /**
   * Compose user-filter + scoped clause + soft-delete clause into one `AND`
   * expression. `undefined` when nothing applies.
   */
  protected composeWhere(
    userFilter: DslQueryFilter | undefined,
    extra: SQL | undefined,
    includeDeleted = false,
  ): SQL | undefined {
    const parts: SQL[] = [];

    const userExpr = buildWhere(this.getTable(), userFilter);
    if (userExpr) parts.push(userExpr);
    if (extra) parts.push(extra);

    if (!includeDeleted) {
      const deletedAt = this.getColumn("deletedAt");
      if (deletedAt) parts.push(isNull(deletedAt));
    }

    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    return and(...parts);
  }

  /**
   * Build a free-text search expression OR'ing `ilike '%query%'` across
   * the columns returned by `getDefaultSearchFields()`. Returns `undefined`
   * when there are no search fields or no query.
   */
  protected searchExpr(query: string | undefined): SQL | undefined {
    if (!query) return undefined;
    const fields = this.getDefaultSearchFields();
    if (fields.length === 0) return undefined;
    const like = `%${query}%`;
    const exprs: SQL[] = [];
    for (const name of fields) {
      const col = this.getColumn(name);
      if (col) exprs.push(ilike(col, like));
    }
    if (exprs.length === 0) return undefined;
    if (exprs.length === 1) return exprs[0];
    return or(...exprs);
  }

  /**
   * Translate `OrderClause[]` into Drizzle `orderBy(...)` arguments. Falls
   * back to `getDefaultOrder()` when the caller provides nothing.
   */
  protected resolveOrder(order: readonly OrderClause[] | undefined): SQL[] {
    const clauses = order && order.length > 0 ? order : this.getDefaultOrder();
    const result: SQL[] = [];
    for (const clause of clauses) {
      const col = this.getColumn(clause.field);
      if (!col) continue;
      const direction = clause.direction === "asc" ? asc(col) : desc(col);
      // OrderClause's `nulls` is informational; Drizzle's asc/desc helpers
      // don't expose nulls-first/last today. Subclasses override
      // `getDefaultOrder()` and use raw `sql` if they need it.
      result.push(direction);
    }
    return result;
  }

  /** Walk the configured hooks' `beforeQuery` (if any) over the user filter. */
  protected async runBeforeQuery(
    filter: DslQueryFilter | undefined,
  ): Promise<DslQueryFilter | undefined> {
    const hooks = this.getHooks();
    if (!hooks.beforeQuery) return filter;
    const ctx = (getRequestContext() ?? {}) as LifecycleHookContext;
    const composed = composeHooks(hooks);
    const result = await composed.beforeQuery!((filter ?? {}) as HookQueryFilter, ctx);
    return (result ?? filter) as DslQueryFilter | undefined;
  }

  /**
   * Look up a column by property name on the configured table. Returns
   * `undefined` for unknown names (callers should treat this as "skip").
   */
  protected getColumn(name: string): PgColumn | undefined {
    const table = this.getTable() as unknown as Record<string, unknown>;
    const candidate = table[name] as Column | undefined;
    if (!candidate) return undefined;
    if (typeof (candidate as { name?: unknown }).name !== "string") return undefined;
    return candidate as PgColumn;
  }

  /** Span-name prefix per service (override if you want a custom one). */
  protected spanName(): string {
    return this.constructor.name;
  }

  /**
   * Auto-stamp `createdBy` / `updatedBy` from `RequestContext.userId` if the
   * column exists on the table and the value isn't already set on the input.
   * Returns a new object — does not mutate `values`.
   */
  protected stampActor(
    values: unknown,
    column: "createdBy" | "updatedBy",
    ctx: LifecycleHookContext,
  ): unknown {
    if (ctx.userId === undefined) return values;
    if (!this.getColumn(column)) return values;
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return values;
    }
    const obj = values as Record<string, unknown>;
    if (obj[column] !== undefined && obj[column] !== null) return values;
    return { ...obj, [column]: ctx.userId };
  }
}
