import type { SQL } from "drizzle-orm";
import { boolean, integer, PgDialect, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { runWithRequestContext } from "../context/RequestContext.js";
import { baseFields } from "../db/baseFields.js";
import type { ShipDb } from "../db/client.js";
import { DrizzleEntityService } from "./DrizzleEntityService.js";
import type { LifecycleHooks } from "./hooks/LifecycleHooks.js";

/**
 * Fixture table covering everything the service exercises: search columns,
 * ordering by createdAt, soft-delete via baseFields' deletedAt.
 */
const widgets = pgTable("widgets", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  count: integer("count").notNull(),
  active: boolean("active").notNull(),
  ...baseFields,
});

const dialect = new PgDialect();

/**
 * Render the SQL produced by a Drizzle builder chain into a parameterized
 * `{ sql, params }` shape so we can inspect what reaches the driver.
 */
function renderSQL(expr: SQL | undefined): { sql: string; params: unknown[] } | undefined {
  if (!expr) return undefined;
  const q = dialect.sqlToQuery(expr);
  return { sql: q.sql, params: [...q.params] };
}

interface CallRecord {
  kind: "select" | "selectAggregate" | "insert" | "update" | "delete";
  whereExpr?: SQL;
  orderByExprs?: SQL[];
  limit?: number;
  offset?: number;
  insertValues?: unknown;
  setValues?: unknown;
}

/**
 * Minimal fake Drizzle client. Enough surface to exercise the service's
 * select / insert / update / delete builder usage; assertions go against
 * the captured chain.
 *
 * The `mutationQueue` lets each mutation call return a different row — useful
 * when a service does load-then-update (e.g., `update` calls `get` first then
 * `update().returning()`).
 */
function makeFakeDb(
  opts: {
    rows?: unknown[];
    count?: number;
    /** Returned row from each mutation call, in order. */
    mutationReturns?: unknown[][];
  } = {},
) {
  const calls: CallRecord[] = [];
  const fakeRows = opts.rows ?? [];
  const fakeCount = opts.count ?? fakeRows.length;
  const mutationQueue = [...(opts.mutationReturns ?? [])];

  function makeReadChain(record: CallRecord, isCount: boolean) {
    const chain = {
      where(expr: SQL) {
        record.whereExpr = expr;
        return chain;
      },
      orderBy(...exprs: SQL[]) {
        record.orderByExprs = exprs;
        return chain;
      },
      limit(n: number) {
        record.limit = n;
        return chain;
      },
      offset(n: number) {
        record.offset = n;
        return chain;
      },
      then(resolve: (value: unknown[]) => unknown, reject?: (err: unknown) => unknown) {
        const result = isCount ? [{ value: fakeCount }] : fakeRows;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function makeMutationChain(record: CallRecord, hasReturning = false) {
    const chain = {
      where(expr: SQL) {
        record.whereExpr = expr;
        return chain;
      },
      set(values: unknown) {
        record.setValues = values;
        return chain;
      },
      values(values: unknown) {
        record.insertValues = values;
        return chain;
      },
      returning() {
        // returning() returns a new awaitable.
        const result = mutationQueue.shift() ?? [];
        return {
          then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve(result).then(resolve, reject);
          },
        };
      },
    };

    // For mutations without `.returning()` (none in our service), the chain itself
    // is awaitable. Add a `then` for completeness.
    (chain as unknown as { then: (r: (v: unknown[]) => unknown) => unknown }).then = (resolve) => {
      const result = hasReturning ? (mutationQueue.shift() ?? []) : [];
      return Promise.resolve(result).then(resolve);
    };
    return chain;
  }

  const db = {
    select(arg?: unknown) {
      const isAggregate = arg !== undefined;
      const record: CallRecord = { kind: isAggregate ? "selectAggregate" : "select" };
      calls.push(record);
      return {
        from(_t: unknown) {
          return makeReadChain(record, isAggregate);
        },
      };
    },
    insert(_t: unknown) {
      const record: CallRecord = { kind: "insert" };
      calls.push(record);
      return makeMutationChain(record);
    },
    update(_t: unknown) {
      const record: CallRecord = { kind: "update" };
      calls.push(record);
      return makeMutationChain(record);
    },
    delete(_t: unknown) {
      const record: CallRecord = { kind: "delete" };
      calls.push(record);
      return makeMutationChain(record);
    },
  };

  return { db: db as unknown as ShipDb<Record<string, never>>, calls };
}

class WidgetService extends DrizzleEntityService<typeof widgets> {
  protected getTable() {
    return widgets;
  }
  protected getDefaultSearchFields(): readonly string[] {
    return ["name", "description"];
  }
}

describe("DrizzleEntityService.get", () => {
  it("filters by id and returns the first matching row", async () => {
    const { db, calls } = makeFakeDb({ rows: [{ id: "w-1", name: "alpha" }] });
    const svc = new WidgetService(db);

    const result = await svc.get("w-1");
    expect(result).toEqual({ id: "w-1", name: "alpha" });

    expect(calls).toHaveLength(1);
    const out = renderSQL(calls[0].whereExpr)!;
    // Composed: id = $1  AND  deleted_at IS NULL
    expect(out.params).toEqual(["w-1"]);
    expect(out.sql.toLowerCase()).toContain('"id" =');
    expect(out.sql.toLowerCase()).toContain("is null");
    expect(calls[0].limit).toBe(1);
  });

  it("returns null when no row matches", async () => {
    const { db } = makeFakeDb({ rows: [] });
    const svc = new WidgetService(db);
    expect(await svc.get("missing")).toBeNull();
  });

  it("includeDeleted skips the soft-delete filter", async () => {
    const { db, calls } = makeFakeDb();
    const svc = new WidgetService(db);
    await svc.get("w-1", { includeDeleted: true });
    const out = renderSQL(calls[0].whereExpr)!;
    expect(out.sql.toLowerCase()).not.toContain("is null");
  });
});

describe("DrizzleEntityService.getAll", () => {
  it("uses default order (createdAt desc) and applies soft-delete filter", async () => {
    const { db, calls } = makeFakeDb({ rows: [{ id: "w-1" }, { id: "w-2" }] });
    const svc = new WidgetService(db);

    const rows = await svc.getAll();
    expect(rows).toHaveLength(2);

    expect(calls[0].orderByExprs).toBeDefined();
    expect(calls[0].orderByExprs).toHaveLength(1);
    const order = renderSQL(calls[0].orderByExprs?.[0])!;
    expect(order.sql.toLowerCase()).toContain('"created_at" desc');

    const where = renderSQL(calls[0].whereExpr)!;
    expect(where.sql.toLowerCase()).toContain("is null"); // deletedAt
  });

  it("translates user where filter via buildWhere", async () => {
    const { db, calls } = makeFakeDb();
    const svc = new WidgetService(db);

    await svc.getAll({ where: { name: { ilike: "%alpha%" } } });
    const where = renderSQL(calls[0].whereExpr)!;
    expect(where.sql.toLowerCase()).toContain("ilike");
    expect(where.params).toEqual(expect.arrayContaining(["%alpha%"]));
  });

  it("composes free-text search across getDefaultSearchFields with OR", async () => {
    const { db, calls } = makeFakeDb();
    const svc = new WidgetService(db);

    await svc.getAll({ search: "alpha" });
    const where = renderSQL(calls[0].whereExpr)!;
    // OR across name + description, both ILIKE '%alpha%'
    expect(where.sql.toLowerCase()).toContain('"name" ilike');
    expect(where.sql.toLowerCase()).toContain('"description" ilike');
    expect(where.sql.toLowerCase()).toContain(" or ");
    expect(where.params.filter((p) => p === "%alpha%")).toHaveLength(2);
  });

  it("forwards limit / offset", async () => {
    const { db, calls } = makeFakeDb();
    const svc = new WidgetService(db);

    await svc.getAll({ limit: 10, offset: 20 });
    expect(calls[0].limit).toBe(10);
    expect(calls[0].offset).toBe(20);
  });

  it("respects custom order", async () => {
    const { db, calls } = makeFakeDb();
    const svc = new WidgetService(db);

    await svc.getAll({ order: [{ field: "name", direction: "asc" }] });
    const order = renderSQL(calls[0].orderByExprs?.[0])!;
    expect(order.sql.toLowerCase()).toContain('"name" asc');
  });

  it("silently skips order clauses for unknown fields", async () => {
    const { db, calls } = makeFakeDb();
    const svc = new WidgetService(db);

    await svc.getAll({ order: [{ field: "bogus", direction: "asc" }] });
    // All-unknown clauses → resolveOrder returns []; the service skips
    // calling .orderBy(...) entirely, so the fake never captures it.
    expect(calls[0].orderByExprs).toBeUndefined();
  });
});

describe("DrizzleEntityService.list", () => {
  it("returns rows + total via parallel select + aggregate", async () => {
    const { db, calls } = makeFakeDb({
      rows: [{ id: "w-1" }, { id: "w-2" }, { id: "w-3" }],
      count: 42,
    });
    const svc = new WidgetService(db);

    const result = await svc.list({ limit: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.total).toBe(42);

    // Two calls: one select (for rows), one selectAggregate (for count)
    expect(calls.map((c) => c.kind)).toEqual(expect.arrayContaining(["select", "selectAggregate"]));
  });
});

describe("DrizzleEntityService.count", () => {
  it("returns the aggregate count, parsing string responses from pg", async () => {
    const { db } = makeFakeDb({ count: 7 });
    const svc = new WidgetService(db);
    expect(await svc.count()).toBe(7);
  });

  it("ignores limit / offset / order on the underlying query", async () => {
    const { db, calls } = makeFakeDb({ count: 5 });
    const svc = new WidgetService(db);
    await svc.count({ limit: 1, offset: 1, order: [{ field: "name", direction: "asc" }] });
    expect(calls[0].limit).toBeUndefined();
    expect(calls[0].offset).toBeUndefined();
    expect(calls[0].orderByExprs).toBeUndefined();
  });
});

describe("DrizzleEntityService.beforeQuery hook", () => {
  it("invokes beforeQuery hook with current request context and merges its result", async () => {
    const { db, calls } = makeFakeDb();

    const hook = vi.fn(async (filter: Record<string, unknown>) => ({
      ...filter,
      tenantId: "tenant-x",
    }));

    class TenantedService extends WidgetService {
      protected override getHooks(): LifecycleHooks {
        return { beforeQuery: hook as unknown as LifecycleHooks["beforeQuery"] };
      }
    }

    const svc = new TenantedService(db);

    await runWithRequestContext({ requestId: "req-1", userId: "u-1" }, async () => {
      await svc.getAll({ where: { name: "alpha" } });
    });

    expect(hook).toHaveBeenCalledOnce();
    const ctxArg = hook.mock.calls[0]?.[1] as { requestId?: string };
    expect(ctxArg.requestId).toBe("req-1");

    // The hook's `tenantId` injection silently dropped (not on the table) —
    // proves the silent-drop path. The user filter passed through.
    const where = renderSQL(calls[0].whereExpr)!;
    expect(where.params).toEqual(expect.arrayContaining(["alpha"]));
  });

  it("works when no request context is active (ctx is empty object)", async () => {
    const { db, calls } = makeFakeDb();
    let observedCtx: unknown;
    class HookedService extends WidgetService {
      protected override getHooks(): LifecycleHooks {
        return {
          beforeQuery: async (filter, ctx) => {
            observedCtx = ctx;
            return filter;
          },
        };
      }
    }
    const svc = new HookedService(db);
    await svc.getAll();
    expect(observedCtx).toEqual({});
    expect(calls).toHaveLength(1);
  });
});

describe("DrizzleEntityService.get error path", () => {
  it("throws when getTable() returns a table without an id column", async () => {
    const noIdTable = pgTable("no_id_widgets", {
      slug: text("slug").primaryKey(),
      ...baseFields,
    });
    const { db } = makeFakeDb();
    class NoIdService extends DrizzleEntityService<typeof noIdTable> {
      protected getTable() {
        return noIdTable;
      }
    }
    const svc = new NoIdService(db);
    await expect(svc.get("anything")).rejects.toThrow(/must expose an "id"/);
  });
});

describe("DrizzleEntityService.create", () => {
  it("INSERTs the supplied values and returns the inserted row", async () => {
    const inserted = { id: "w-new", name: "fresh", count: 0, active: true };
    const { db, calls } = makeFakeDb({ mutationReturns: [[inserted]] });
    const svc = new WidgetService(db);

    const result = await svc.create({ name: "fresh", count: 0, active: true });
    expect(result).toEqual(inserted);

    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("insert");
    expect(calls[0].insertValues).toMatchObject({ name: "fresh", count: 0, active: true });
  });

  it("auto-stamps createdBy from RequestContext.userId", async () => {
    const { db, calls } = makeFakeDb({ mutationReturns: [[{ id: "w-1" }]] });
    const svc = new WidgetService(db);

    await runWithRequestContext({ userId: "u-actor" }, async () => {
      await svc.create({ name: "x", count: 0, active: true });
    });

    expect(calls[0].insertValues).toMatchObject({ createdBy: "u-actor" });
  });

  it("preserves an explicitly-provided createdBy (does not overwrite)", async () => {
    const { db, calls } = makeFakeDb({ mutationReturns: [[{ id: "w-1" }]] });
    const svc = new WidgetService(db);

    await runWithRequestContext({ userId: "u-actor" }, async () => {
      await svc.create({ name: "x", count: 0, active: true, createdBy: "u-explicit" });
    });

    expect(calls[0].insertValues).toMatchObject({ createdBy: "u-explicit" });
  });

  it("runs applyOptionalFields and resolveRelationIds before INSERT", async () => {
    const { db, calls } = makeFakeDb({ mutationReturns: [[{ id: "w-1" }]] });
    class CustomService extends WidgetService {
      protected override async applyOptionalFields(values: unknown) {
        return { ...(values as Record<string, unknown>), defaulted: true };
      }
      protected override async resolveRelationIds(values: unknown) {
        return { ...(values as Record<string, unknown>), relationResolved: true };
      }
    }
    const svc = new CustomService(db);
    await svc.create({ name: "x", count: 0, active: true });
    expect(calls[0].insertValues).toMatchObject({ defaulted: true, relationResolved: true });
  });

  it("calls beforeCreate and afterCreate hooks in order", async () => {
    const inserted = { id: "w-1", name: "ALPHA" };
    const { db, calls } = makeFakeDb({ mutationReturns: [[inserted]] });
    const order: string[] = [];

    class HookedService extends WidgetService {
      protected override getHooks(): LifecycleHooks {
        return {
          beforeCreate: (values) => {
            order.push("before");
            return {
              ...(values as Record<string, unknown>),
              name: (values as { name: string }).name.toUpperCase(),
            };
          },
          afterCreate: () => {
            order.push("after");
          },
        };
      }
    }
    const svc = new HookedService(db);
    const result = await svc.create({ name: "alpha", count: 0, active: true });

    expect(order).toEqual(["before", "after"]);
    expect(calls[0].insertValues).toMatchObject({ name: "ALPHA" });
    expect(result).toEqual(inserted);
  });

  it("treats a hook returning undefined as 'no change'", async () => {
    const { db, calls } = makeFakeDb({ mutationReturns: [[{ id: "w-1" }]] });
    class HookedService extends WidgetService {
      protected override getHooks(): LifecycleHooks {
        return { beforeCreate: () => undefined };
      }
    }
    const svc = new HookedService(db);
    await svc.create({ name: "x", count: 0, active: true });
    expect(calls[0].insertValues).toMatchObject({ name: "x" });
  });
});

describe("DrizzleEntityService.update", () => {
  it("loads prev, calls UPDATE … WHERE id, returns next", async () => {
    const prev = { id: "w-1", name: "old", count: 0, active: true };
    const next = { id: "w-1", name: "new", count: 0, active: true };
    const { db, calls } = makeFakeDb({
      rows: [prev],
      mutationReturns: [[next]],
    });
    const svc = new WidgetService(db);

    const result = await svc.update("w-1", { name: "new" });
    expect(result).toEqual(next);

    // Two calls: select (the get), then update
    expect(calls.map((c) => c.kind)).toEqual(["select", "update"]);
    expect(calls[1].setValues).toMatchObject({ name: "new" });
    expect(calls[1].whereExpr).toBeDefined();
    const whereOut = renderSQL(calls[1].whereExpr)!;
    expect(whereOut.params).toEqual(["w-1"]);
  });

  it("throws NotFoundError when the row doesn't exist", async () => {
    const { db } = makeFakeDb({ rows: [] });
    const svc = new WidgetService(db);

    await expect(svc.update("missing", { name: "x" })).rejects.toThrow(/not found/);
  });

  it("auto-stamps updatedBy from RequestContext.userId", async () => {
    const prev = { id: "w-1", name: "old" };
    const { db, calls } = makeFakeDb({
      rows: [prev],
      mutationReturns: [[prev]],
    });
    const svc = new WidgetService(db);

    await runWithRequestContext({ userId: "u-editor" }, async () => {
      await svc.update("w-1", { name: "new" });
    });

    expect(calls[1].setValues).toMatchObject({ updatedBy: "u-editor" });
  });

  it("invokes beforeUpdate with prev + patch and afterUpdate with prev + next", async () => {
    const prev = { id: "w-1", name: "old" };
    const next = { id: "w-1", name: "NEW" };
    const { db } = makeFakeDb({
      rows: [prev],
      mutationReturns: [[next]],
    });
    const seenPrevs: unknown[] = [];
    const seenAfters: unknown[] = [];

    class HookedService extends WidgetService {
      protected override getHooks(): LifecycleHooks {
        return {
          beforeUpdate: (prevRow, patch) => {
            seenPrevs.push(prevRow);
            return {
              ...(patch as Record<string, unknown>),
              name: ((patch as { name: string }).name ?? "").toUpperCase(),
            };
          },
          afterUpdate: (prevRow, nextRow) => {
            seenAfters.push({ prevRow, nextRow });
          },
        };
      }
    }
    const svc = new HookedService(db);
    await svc.update("w-1", { name: "new" });

    expect(seenPrevs).toEqual([prev]);
    expect(seenAfters).toEqual([{ prevRow: prev, nextRow: next }]);
  });
});

describe("DrizzleEntityService.delete", () => {
  it("soft-deletes when the table has a deletedAt column", async () => {
    const prev = { id: "w-1", name: "doomed" };
    const deleted = { ...prev, deletedAt: new Date() };
    const { db, calls } = makeFakeDb({
      rows: [prev],
      mutationReturns: [[deleted]],
    });
    const svc = new WidgetService(db);

    const result = await svc.delete("w-1");
    expect(result).toEqual(deleted);

    expect(calls.map((c) => c.kind)).toEqual(["select", "update"]);
    expect(calls[1].setValues).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it("hard-deletes when the table has no deletedAt column", async () => {
    const noSoftDelete = pgTable("hard_widgets", {
      id: uuid("id").primaryKey(),
      name: text("name").notNull(),
    });
    type Row = typeof noSoftDelete.$inferSelect;
    const prev: Row = { id: "h-1", name: "gone" };
    const { db, calls } = makeFakeDb({
      rows: [prev],
      mutationReturns: [[prev]],
    });

    class HardDeleteService extends DrizzleEntityService<typeof noSoftDelete> {
      protected getTable() {
        return noSoftDelete;
      }
    }
    const svc = new HardDeleteService(db);

    const result = await svc.delete("h-1");
    expect(result).toEqual(prev);

    expect(calls.map((c) => c.kind)).toEqual(["select", "delete"]);
  });

  it("throws NotFoundError when the row doesn't exist", async () => {
    const { db } = makeFakeDb({ rows: [] });
    const svc = new WidgetService(db);

    await expect(svc.delete("missing")).rejects.toThrow(/not found/);
  });

  it("calls beforeDelete (which can abort) and afterDelete", async () => {
    const prev = { id: "w-1", name: "doomed" };
    const { db } = makeFakeDb({ rows: [prev], mutationReturns: [[prev]] });

    class AbortService extends WidgetService {
      protected override getHooks(): LifecycleHooks {
        return {
          beforeDelete: () => {
            throw new Error("policy: cannot delete");
          },
        };
      }
    }
    const svc = new AbortService(db);
    await expect(svc.delete("w-1")).rejects.toThrow(/policy/);
  });

  it("auto-stamps updatedBy on soft-delete from RequestContext.userId", async () => {
    const prev = { id: "w-1", name: "doomed" };
    const { db, calls } = makeFakeDb({
      rows: [prev],
      mutationReturns: [[prev]],
    });
    const svc = new WidgetService(db);

    await runWithRequestContext({ userId: "u-killer" }, async () => {
      await svc.delete("w-1");
    });

    expect(calls[1].setValues).toMatchObject({ updatedBy: "u-killer" });
  });
});
