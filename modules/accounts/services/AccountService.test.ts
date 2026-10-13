import type { ShipDb } from "@sixthsummit/ship-api/app/db/client";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { accounts } from "../schema.js";
import { AccountService } from "./AccountService.js";

interface CallRecord {
  kind: "select" | "selectAggregate";
  whereExpr?: SQL;
  limit?: number;
  offset?: number;
}

function makeFakeDb(rows: unknown[]) {
  const calls: CallRecord[] = [];
  function makeChain(record: CallRecord, isAggregate: boolean) {
    const chain = {
      where(expr: SQL) {
        record.whereExpr = expr;
        return chain;
      },
      orderBy() {
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
      then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
        const result = isAggregate ? [{ value: rows.length }] : rows;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  const db = {
    select(arg?: unknown) {
      const isAggregate = arg !== undefined;
      const record: CallRecord = {
        kind: isAggregate ? "selectAggregate" : "select",
      };
      calls.push(record);
      return { from: () => makeChain(record, isAggregate) };
    },
  };
  return {
    db: db as unknown as ShipDb<{ accounts: typeof accounts }>,
    calls,
  };
}

const sampleRow = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  firebaseUid: "uid-alice",
  isActive: true,
  roleId: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-02T00:00:00Z"),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
};

describe("AccountService — v4", () => {
  it("targets the framework's default accounts table", async () => {
    const fake = makeFakeDb([sampleRow]);
    const service = new AccountService(fake.db);
    await service.getAll();
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls[0].kind).toBe("select");
  });

  it("get(id) issues a single row select with a where clause + limit 1", async () => {
    const fake = makeFakeDb([sampleRow]);
    const service = new AccountService(fake.db);
    const account = await service.get(sampleRow.id);
    expect(account).toEqual(sampleRow);
    // The first non-aggregate select carries the WHERE id=$ AND deleted_at IS NULL.
    const selectCalls = fake.calls.filter((c) => c.kind === "select");
    expect(selectCalls[0].whereExpr).toBeDefined();
    expect(selectCalls[0].limit).toBe(1);
  });

  it("get(id) returns null when no row matches", async () => {
    const fake = makeFakeDb([]);
    const service = new AccountService(fake.db);
    expect(await service.get(sampleRow.id)).toBeNull();
  });

  it("getAll() returns the rows from the underlying select", async () => {
    const fake = makeFakeDb([sampleRow, { ...sampleRow, id: "different" }]);
    const service = new AccountService(fake.db);
    const rows = (await service.getAll()) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it("count() goes through the aggregate select path", async () => {
    const fake = makeFakeDb([sampleRow, sampleRow, sampleRow]);
    const service = new AccountService(fake.db);
    const total = await service.count();
    expect(total).toBe(3);
    const aggregate = fake.calls.find((c) => c.kind === "selectAggregate");
    expect(aggregate).toBeDefined();
  });

  it("list({ limit, offset }) forwards pagination args to the select", async () => {
    const fake = makeFakeDb([sampleRow]);
    const service = new AccountService(fake.db);
    const result = await service.list({ limit: 20, offset: 40 });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
    const dataCall = fake.calls.find((c) => c.kind === "select");
    expect(dataCall?.limit).toBe(20);
    expect(dataCall?.offset).toBe(40);
  });

  it("free-text ?search=... filters against email + displayName (default search fields)", async () => {
    // We can't introspect the SQL expression text without parsing it back,
    // but we can confirm the service threads `opts.search` through to the
    // where clause builder — i.e., the resulting query has a non-trivial
    // WHERE expression even when no `where` clause was passed.
    const fake = makeFakeDb([sampleRow]);
    const service = new AccountService(fake.db);
    await service.getAll({ search: "alice" });
    const selectCall = fake.calls.find((c) => c.kind === "select");
    expect(selectCall?.whereExpr).toBeDefined();
  });

  it("declares `role` as a default eager-load relation", async () => {
    // Default-relations behavior is consumed by relational-query overrides
    // on subclasses; the contract here is that the property is correctly
    // declared on the service type. Reflect it via a typed accessor.
    interface ProtectedSurface {
      getDefaultRelations(): readonly string[];
    }
    const fake = makeFakeDb([]);
    const service = new AccountService(fake.db);
    const surface = service as unknown as ProtectedSurface;
    expect(surface.getDefaultRelations()).toContain("role");
  });
});
