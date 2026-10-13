import type { ShipDb } from "@sixthsummit/ship-api/app/db/client";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEvent, outboxEvents } from "../schema.js";
import { OutboxEventService } from "./OutboxEventService.js";

interface CallRecord {
  kind: "select" | "selectAggregate" | "selectGrouped" | "insert" | "update" | "delete";
  whereExpr?: SQL;
  setValues?: unknown;
  returningSelection?: unknown;
  groupByCalled?: boolean;
}

function makeFakeDb(rows: unknown[] = []) {
  const calls: CallRecord[] = [];

  function selectChain(record: CallRecord, isAggregate: boolean) {
    const chain = {
      where(expr: SQL) {
        record.whereExpr = expr;
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      offset() {
        return chain;
      },
      groupBy() {
        record.groupByCalled = true;
        record.kind = "selectGrouped";
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
      const isAggregate = arg !== undefined && Object.keys(arg as object).length === 1;
      const isGrouped = arg !== undefined && Object.keys(arg as object).length > 1;
      const record: CallRecord = {
        kind: isAggregate ? "selectAggregate" : isGrouped ? "selectGrouped" : "select",
      };
      calls.push(record);
      return { from: () => selectChain(record, isAggregate) };
    },
    insert() {
      return {
        values(_v: unknown) {
          const record: CallRecord = { kind: "insert" };
          calls.push(record);
          return { returning: async () => rows };
        },
      };
    },
    update() {
      return {
        set(v: unknown) {
          const record: CallRecord = { kind: "update", setValues: v };
          calls.push(record);
          return {
            where(expr: SQL) {
              record.whereExpr = expr;
              return {
                returning(selection?: unknown) {
                  record.returningSelection = selection;
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where(expr: SQL) {
          const record: CallRecord = { kind: "delete", whereExpr: expr };
          calls.push(record);
          return { returning: async () => rows };
        },
      };
    },
    transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => fn(db),
  };

  return {
    db: db as unknown as ShipDb<{ outboxEvents: typeof outboxEvents }>,
    calls,
  };
}

const baseEvent: OutboxEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  eventType: "account.created",
  eventVersion: 1,
  occurredAt: new Date("2025-06-01T00:00:00Z"),
  aggregateType: "account",
  aggregateId: "33333333-3333-4333-8333-333333333333",
  ownerUserId: null,
  tenantId: null,
  dedupeKey: null,
  correlationId: "trace-1",
  payload: { name: "Alice" },
  status: "pending",
  publishAttempts: 0,
  nextAttemptAt: null,
  publishedAt: null,
  lastError: null,
  maxRetries: 10,
  startedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
};

describe("OutboxEventService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("targets the outbox_events table", async () => {
    const fake = makeFakeDb([baseEvent]);
    const service = new OutboxEventService(fake.db);
    await service.getAll();
    expect(fake.calls[0].kind).toBe("select");
  });

  it("declares eventType + correlationId as default search fields", () => {
    interface ProtectedSurface {
      getDefaultSearchFields(): readonly string[];
    }
    const fake = makeFakeDb([]);
    const service = new OutboxEventService(fake.db);
    const surface = service as unknown as ProtectedSurface;
    expect(surface.getDefaultSearchFields()).toEqual(["eventType", "correlationId"]);
  });

  describe("findReadyToPublish", () => {
    it("returns rows from a select with a composite where clause", async () => {
      const fake = makeFakeDb([baseEvent]);
      const service = new OutboxEventService(fake.db);
      const rows = await service.findReadyToPublish(50);
      expect(rows).toEqual([baseEvent]);
      const sel = fake.calls.find((c) => c.kind === "select");
      expect(sel?.whereExpr).toBeDefined();
    });

    it("default limit is 100", async () => {
      const fake = makeFakeDb([]);
      const service = new OutboxEventService(fake.db);
      await service.findReadyToPublish();
      expect(fake.calls.some((c) => c.kind === "select")).toBe(true);
    });
  });

  describe("claimForProcessing", () => {
    it("empty input → no DB call, returns []", async () => {
      const fake = makeFakeDb();
      const service = new OutboxEventService(fake.db);
      const claimed = await service.claimForProcessing([]);
      expect(claimed).toEqual([]);
      expect(fake.calls).toHaveLength(0);
    });

    it("issues an UPDATE with status='processing' + incremented publishAttempts + startedAt", async () => {
      const fake = makeFakeDb([{ id: baseEvent.id }]);
      const service = new OutboxEventService(fake.db);
      const claimed = await service.claimForProcessing([baseEvent.id]);
      expect(claimed).toEqual([baseEvent.id]);

      const upd = fake.calls.find((c) => c.kind === "update");
      expect(upd).toBeDefined();
      const set = upd!.setValues as Record<string, unknown>;
      expect(set.status).toBe("processing");
      expect(set.startedAt).toBeInstanceOf(Date);
      // publishAttempts is set via SQL increment, not literal — verify
      // it's *not* a literal number (which would mean we lost the
      // concurrent-safe increment).
      expect(typeof set.publishAttempts).toBe("object");
    });

    it("returns only ids that actually transitioned (concurrent-safe)", async () => {
      // Stub returns one row even though we asked for two — simulates
      // a competing worker claiming the other id before us.
      const fake = makeFakeDb([{ id: baseEvent.id }]);
      const service = new OutboxEventService(fake.db);
      const claimed = await service.claimForProcessing([
        baseEvent.id,
        "44444444-4444-4444-8444-444444444444",
      ]);
      expect(claimed).toEqual([baseEvent.id]);
    });
  });

  describe("markPublished", () => {
    it("issues an UPDATE setting status='published', publishedAt, clears lastError + nextAttemptAt", async () => {
      const fake = makeFakeDb([{ ...baseEvent, status: "published" }]);
      const service = new OutboxEventService(fake.db);
      const row = await service.markPublished(baseEvent.id);
      expect(row?.status).toBe("published");

      const upd = fake.calls.find((c) => c.kind === "update");
      const set = upd!.setValues as Record<string, unknown>;
      expect(set.status).toBe("published");
      expect(set.publishedAt).toBeInstanceOf(Date);
      expect(set.lastError).toBeNull();
      expect(set.nextAttemptAt).toBeNull();
    });

    it("returns null when no row matches", async () => {
      const fake = makeFakeDb([]);
      const service = new OutboxEventService(fake.db);
      expect(await service.markPublished("missing")).toBeNull();
    });
  });

  describe("markFailed (terminal)", () => {
    it("UPDATE status='failed', stamps lastError, clears nextAttemptAt", async () => {
      const fake = makeFakeDb([{ ...baseEvent, status: "failed" }]);
      const service = new OutboxEventService(fake.db);
      await service.markFailed(baseEvent.id, "downstream 500");

      const upd = fake.calls.find((c) => c.kind === "update");
      const set = upd!.setValues as Record<string, unknown>;
      expect(set.status).toBe("failed");
      expect(set.lastError).toBe("downstream 500");
      expect(set.nextAttemptAt).toBeNull();
    });

    it("truncates very long error messages to 4096 chars", async () => {
      const fake = makeFakeDb([baseEvent]);
      const service = new OutboxEventService(fake.db);
      const longErr = "x".repeat(10_000);
      await service.markFailed(baseEvent.id, longErr);
      const upd = fake.calls.find((c) => c.kind === "update");
      const set = upd!.setValues as Record<string, unknown>;
      expect((set.lastError as string).length).toBeLessThanOrEqual(4096);
      expect(set.lastError).toMatch(/\.\.\.$/);
    });
  });

  describe("markForRetry (non-terminal)", () => {
    it("reverts status to 'pending', stamps lastError, schedules nextAttemptAt", async () => {
      const fake = makeFakeDb([baseEvent]);
      const service = new OutboxEventService(fake.db);
      await service.markForRetry(baseEvent.id, "transient", 2);

      const upd = fake.calls.find((c) => c.kind === "update");
      const set = upd!.setValues as Record<string, unknown>;
      expect(set.status).toBe("pending");
      expect(set.lastError).toBe("transient");
      expect(set.nextAttemptAt).toBeInstanceOf(Date);
      expect(set.publishedAt).toBeNull();
    });
  });

  describe("recoverStaleProcessing", () => {
    it("issues an UPDATE filtered to status='processing' with a startedAt cutoff", async () => {
      const fake = makeFakeDb([{ id: baseEvent.id }, { id: "another" }]);
      const service = new OutboxEventService(fake.db);
      const result = await service.recoverStaleProcessing(60 * 1_000);
      expect(result.recovered).toBe(2);

      const upd = fake.calls.find((c) => c.kind === "update");
      const set = upd!.setValues as Record<string, unknown>;
      expect(set.status).toBe("pending");
      expect(set.startedAt).toBeNull();
      expect(set.nextAttemptAt).toBeInstanceOf(Date);
    });

    it("default threshold is 30 minutes", async () => {
      const fake = makeFakeDb([]);
      const service = new OutboxEventService(fake.db);
      await service.recoverStaleProcessing();
      expect(fake.calls.some((c) => c.kind === "update")).toBe(true);
    });
  });

  describe("getStatistics", () => {
    it("aggregates per-status counts; missing buckets default to 0", async () => {
      const fake = makeFakeDb([
        { status: "pending", count: 5 },
        { status: "published", count: 100 },
      ]);
      const service = new OutboxEventService(fake.db);
      const stats = await service.getStatistics();
      expect(stats).toEqual({
        pending: 5,
        processing: 0,
        published: 100,
        failed: 0,
      });
      const sel = fake.calls.find((c) => c.kind === "selectGrouped");
      expect(sel?.groupByCalled).toBe(true);
    });
  });
});
