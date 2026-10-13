import type { ShipDb } from "@sixthsummit/ship-api/app/db/client";
import { describe, expect, it } from "vitest";
import { OutboxEventEmitter } from "./EventEmitter.js";
import type { OutboxEvent, outboxEvents } from "./schema.js";

function makeFakeDb() {
  const inserts: Array<{
    table: unknown;
    values: unknown;
  }> = [];
  const db = {
    insert(table: unknown) {
      return {
        values(v: unknown) {
          inserts.push({ table, values: v });
          const created: OutboxEvent = {
            id: "11111111-1111-4111-8111-111111111111",
            eventId: "22222222-2222-4222-8222-222222222222",
            ...(v as Record<string, unknown>),
            status: "pending",
            publishAttempts: 0,
            nextAttemptAt: null,
            publishedAt: null,
            lastError: null,
            startedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            createdBy: null,
            updatedBy: null,
          } as OutboxEvent;
          return { returning: async () => [created] };
        },
      };
    },
  };
  return {
    db: db as unknown as ShipDb<{ outboxEvents: typeof outboxEvents }>,
    inserts,
  };
}

describe("OutboxEventEmitter", () => {
  it("inserts a row with the supplied event fields", async () => {
    const fake = makeFakeDb();
    const emitter = new OutboxEventEmitter(fake.db);
    const row = await emitter.emit({
      eventType: "account.created",
      aggregateType: "account",
      aggregateId: "33333333-3333-4333-8333-333333333333",
      ownerUserId: "44444444-4444-4444-8444-444444444444",
      payload: { id: "33333333-3333-4333-8333-333333333333", email: "a@b.test" },
      correlationId: "trace-1",
    });
    expect(fake.inserts).toHaveLength(1);
    const inserted = fake.inserts[0].values as Record<string, unknown>;
    expect(inserted.eventType).toBe("account.created");
    expect(inserted.aggregateType).toBe("account");
    expect(inserted.payload).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      email: "a@b.test",
    });
    expect(inserted.correlationId).toBe("trace-1");
    expect(row.eventType).toBe("account.created");
  });

  it("defaults eventVersion to 1, maxRetries to 10, occurredAt to now", async () => {
    const fake = makeFakeDb();
    const emitter = new OutboxEventEmitter(fake.db);
    const before = Date.now();
    await emitter.emit({
      eventType: "x",
      payload: {},
    });
    const after = Date.now();
    const inserted = fake.inserts[0].values as Record<string, unknown>;
    expect(inserted.eventVersion).toBe(1);
    expect(inserted.maxRetries).toBe(10);
    expect(inserted.occurredAt).toBeInstanceOf(Date);
    const occurredAt = (inserted.occurredAt as Date).getTime();
    expect(occurredAt).toBeGreaterThanOrEqual(before);
    expect(occurredAt).toBeLessThanOrEqual(after);
  });

  it("respects explicit eventVersion / maxRetries / occurredAt", async () => {
    const fake = makeFakeDb();
    const emitter = new OutboxEventEmitter(fake.db);
    const t = new Date("2025-06-01T00:00:00Z");
    await emitter.emit({
      eventType: "x",
      eventVersion: 3,
      occurredAt: t,
      maxRetries: 5,
      payload: {},
    });
    const inserted = fake.inserts[0].values as Record<string, unknown>;
    expect(inserted.eventVersion).toBe(3);
    expect(inserted.maxRetries).toBe(5);
    expect(inserted.occurredAt).toBe(t);
  });

  it("nulls out optional fields when not supplied", async () => {
    const fake = makeFakeDb();
    const emitter = new OutboxEventEmitter(fake.db);
    await emitter.emit({ eventType: "x", payload: {} });
    const inserted = fake.inserts[0].values as Record<string, unknown>;
    expect(inserted.aggregateType).toBeNull();
    expect(inserted.aggregateId).toBeNull();
    expect(inserted.ownerUserId).toBeNull();
    expect(inserted.tenantId).toBeNull();
    expect(inserted.dedupeKey).toBeNull();
    expect(inserted.correlationId).toBeNull();
  });

  it("uses opts.tx when supplied (atomic with caller's domain write)", async () => {
    const baseFake = makeFakeDb();
    const txFake = makeFakeDb();
    const emitter = new OutboxEventEmitter(baseFake.db);

    await emitter.emit({ eventType: "x", payload: {} }, { tx: txFake.db });

    // Insert went through the tx, NOT the base db.
    expect(txFake.inserts).toHaveLength(1);
    expect(baseFake.inserts).toHaveLength(0);
  });

  it("falls back to the base db when no tx is supplied", async () => {
    const baseFake = makeFakeDb();
    const emitter = new OutboxEventEmitter(baseFake.db);
    await emitter.emit({ eventType: "x", payload: {} });
    expect(baseFake.inserts).toHaveLength(1);
  });
});
