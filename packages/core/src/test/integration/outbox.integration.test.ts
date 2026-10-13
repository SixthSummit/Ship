/**
 * Real-Postgres integration test for the outbox module:
 * `outbox_events` table + `OutboxEventService` + `OutboxDrainer`.
 *
 * V4_STATUS G3 slice 3 (closes G3 partial → done modulo ongoing
 * coverage growth). Builds on the harness from slices 1+2 with
 * focus on the surface that fake-DB tests can't verify:
 *
 *   - Partial indexes (`outbox_events_pending_ix` /
 *     `outbox_events_processing_ix`) actually exist with the
 *     declared WHERE clauses
 *   - The pgEnum (`outbox_event_status`) is created and rejects
 *     out-of-set values
 *   - `claimForProcessing` is concurrency-safe — competing claims
 *     against the same row are won by exactly one caller (UPDATE
 *     ... WHERE status='pending' returns only the rows the caller
 *     transitioned)
 *   - `getStatistics` GROUP BY query returns the right shape
 *   - `recoverStaleProcessing` UPDATE with the startedAt cutoff
 *     resets only stale rows, not fresh ones
 */

import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outboxEventStatus, outboxEvents } from "../../../../../modules/outbox/schema.js";
import { OutboxEventService } from "../../../../../modules/outbox/services/OutboxEventService.js";

const outboxSchema = {
  outboxEvents,
  outboxEventStatus,
} as const;

describe("outbox integration (real Postgres)", () => {
  let dbCtx: PostgresTestDb<typeof outboxSchema>;
  let service: OutboxEventService;

  beforeAll(async () => {
    dbCtx = await setupPostgresTestDb(outboxSchema);
    service = new OutboxEventService(
      dbCtx.db as unknown as ConstructorParameters<typeof OutboxEventService>[0],
    );
  }, 60_000);

  afterAll(async () => {
    if (dbCtx) await dbCtx.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(dbCtx);
  });

  // ─── Schema introspection: pgEnum + partial indexes are real ────────

  it("pgEnum 'outbox_event_status' rejects values outside the declared set", async () => {
    let thrown: { cause?: { code?: string } } | undefined;
    try {
      // Bypass Drizzle's type system to drive a raw INSERT with an
      // invalid status — we want the ENUM to reject at the SQL level.
      await dbCtx.pool.query(
        `INSERT INTO outbox_events (event_type, payload, status) VALUES ($1, $2, $3)`,
        ["test", JSON.stringify({}), "not-a-real-status"],
      );
    } catch (err) {
      thrown = err as { cause?: { code?: string } };
    }
    expect(thrown).toBeDefined();
    // SQLSTATE 22P02 = invalid_text_representation (enum miss);
    // Postgres can also throw 42704 when the string doesn't parse
    // to the type at all.
    const code = (thrown as { code?: string } | undefined)?.code;
    expect(["22P02", "42704"]).toContain(code);
  });

  it("tenant_id is a uuid column — stores a valid uuid, rejects non-uuid text", async () => {
    const tid = "12345678-1234-4234-8234-1234567890ab";
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (event_type, payload, tenant_id) VALUES ($1, $2, $3)`,
      ["tenant-uuid", JSON.stringify({}), tid],
    );
    const { rows } = await dbCtx.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM outbox_events WHERE event_type = $1`,
      ["tenant-uuid"],
    );
    expect(rows[0].tenant_id).toBe(tid);

    // Non-uuid text is rejected at the SQL boundary — proves the column is uuid,
    // not text (the A2-1 reconcile).
    let thrown: { code?: string } | undefined;
    try {
      await dbCtx.pool.query(
        `INSERT INTO outbox_events (event_type, payload, tenant_id) VALUES ($1, $2, $3)`,
        ["tenant-bad", JSON.stringify({}), "not-a-uuid"],
      );
    } catch (err) {
      thrown = err as { code?: string };
    }
    expect(thrown?.code).toBe("22P02"); // invalid_text_representation
  });

  it("partial indexes exist with the declared WHERE clauses", async () => {
    const result = await dbCtx.pool.query<{
      indexname: string;
      indexdef: string;
    }>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, ["outbox_events"]);

    const byName = new Map(result.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.has("outbox_events_pending_ix")).toBe(true);
    expect(byName.has("outbox_events_processing_ix")).toBe(true);

    // Verify the WHERE-clause text actually landed (drizzle-kit
    // sometimes simplifies the SQL; we check for the column refs that
    // matter rather than the exact bytes).
    const pendingDef = byName.get("outbox_events_pending_ix")!;
    expect(pendingDef.toLowerCase()).toContain("where");
    expect(pendingDef).toContain("'pending'");
    expect(pendingDef).toContain("'processing'");
    expect(pendingDef).toContain("published_at");

    const processingDef = byName.get("outbox_events_processing_ix")!;
    expect(processingDef.toLowerCase()).toContain("where");
    expect(processingDef).toContain("'processing'");
  });

  // ─── findReadyToPublish + claimForProcessing semantics ──────────────

  it("findReadyToPublish returns rows in FIFO order; respects scheduled retries", async () => {
    // Three pending rows with increasing createdAt.
    const aId = "11111111-1111-4111-8111-111111111111";
    const bId = "22222222-2222-4222-8222-222222222222";
    const cId = "33333333-3333-4333-8333-333333333333";

    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, created_at) VALUES
        ($1, 'a', '{}', NOW() - INTERVAL '3 minutes'),
        ($2, 'b', '{}', NOW() - INTERVAL '2 minutes'),
        ($3, 'c', '{}', NOW() - INTERVAL '1 minute')`,
      [aId, bId, cId],
    );

    const ready = await service.findReadyToPublish(10);
    expect(ready.map((r) => r.id)).toEqual([aId, bId, cId]);

    // Push 'b' into the future via nextAttemptAt; it should be excluded.
    await dbCtx.db
      .update(outboxEvents)
      .set({
        nextAttemptAt: new Date(Date.now() + 60_000),
      })
      .where(eq(outboxEvents.id, bId));

    const ready2 = await service.findReadyToPublish(10);
    expect(ready2.map((r) => r.id)).toEqual([aId, cId]);
  });

  it("claimForProcessing transitions pending → processing and increments publishAttempts", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload) VALUES ($1, 'x', '{}')`,
      [id],
    );

    const claimed = await service.claimForProcessing([id]);
    expect(claimed).toEqual([id]);

    const [row] = await dbCtx.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row.status).toBe("processing");
    expect(row.publishAttempts).toBe(1);
    expect(row.startedAt).toBeInstanceOf(Date);
  });

  it("claimForProcessing is concurrency-safe — only one of two parallel callers wins each row", async () => {
    // Seed 5 pending rows.
    const ids = [
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
    ];
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload)
       SELECT unnest($1::uuid[]), 'race', '{}'`,
      [ids],
    );

    // Two workers race for the same id set.
    const [winA, winB] = await Promise.all([
      service.claimForProcessing(ids),
      service.claimForProcessing(ids),
    ]);
    const totalClaimed = [...winA, ...winB];
    // Across both workers, every id is claimed exactly once.
    expect(new Set(totalClaimed).size).toBe(ids.length);
    expect(totalClaimed.length).toBe(ids.length);
    // No id appears in both winners (would mean both workers
    // transitioned the same row — concurrency bug).
    const intersection = winA.filter((id) => winB.includes(id));
    expect(intersection).toEqual([]);
  });

  it("claimForProcessing skips rows already in 'processing' state", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, status)
       VALUES ($1, 'x', '{}', 'processing')`,
      [id],
    );
    const claimed = await service.claimForProcessing([id]);
    expect(claimed).toEqual([]); // already taken — no transition possible
  });

  // ─── markPublished / markFailed / markForRetry ──────────────────────

  it("markPublished sets status, publishedAt; clears lastError + nextAttemptAt", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, last_error, next_attempt_at)
       VALUES ($1, 'x', '{}', 'previous failure', NOW())`,
      [id],
    );
    await service.markPublished(id);

    const [row] = await dbCtx.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row.status).toBe("published");
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeNull();
    expect(row.nextAttemptAt).toBeNull();
  });

  it("markFailed sets status='failed' + truncates very long error messages to 4096 chars", async () => {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload) VALUES ($1, 'x', '{}')`,
      [id],
    );
    const longError = "x".repeat(10_000);
    await service.markFailed(id, longError);

    const [row] = await dbCtx.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row.status).toBe("failed");
    expect((row.lastError as string).length).toBeLessThanOrEqual(4096);
    expect(row.lastError).toMatch(/\.\.\.$/);
  });

  it("markForRetry reverts to 'pending' + schedules nextAttemptAt in the future", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, status)
       VALUES ($1, 'x', '{}', 'processing')`,
      [id],
    );
    const before = Date.now();
    await service.markForRetry(id, "transient", 2);

    const [row] = await dbCtx.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("transient");
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
    expect((row.nextAttemptAt as Date).getTime()).toBeGreaterThan(before);
  });

  // ─── recoverStaleProcessing — admin tooling ─────────────────────────

  it("recoverStaleProcessing only resets rows older than the threshold", async () => {
    const staleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const freshId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    await dbCtx.pool.query(
      `INSERT INTO outbox_events (id, event_type, payload, status, started_at) VALUES
        ($1, 'stale', '{}', 'processing', NOW() - INTERVAL '60 minutes'),
        ($2, 'fresh', '{}', 'processing', NOW() - INTERVAL '1 minute')`,
      [staleId, freshId],
    );

    const result = await service.recoverStaleProcessing(30 * 60 * 1000);
    expect(result.recovered).toBe(1);

    const rows = await dbCtx.db.select().from(outboxEvents);
    const stale = rows.find((r) => r.id === staleId)!;
    const fresh = rows.find((r) => r.id === freshId)!;

    expect(stale.status).toBe("pending");
    expect(stale.startedAt).toBeNull();
    expect(stale.nextAttemptAt).toBeInstanceOf(Date);

    expect(fresh.status).toBe("processing"); // untouched
  });

  // ─── getStatistics — GROUP BY query ─────────────────────────────────

  it("getStatistics returns per-status counts; missing buckets default to 0", async () => {
    await dbCtx.pool.query(
      `INSERT INTO outbox_events (event_type, payload, status) VALUES
        ('a', '{}', 'pending'), ('b', '{}', 'pending'),
        ('c', '{}', 'processing'),
        ('d', '{}', 'published'), ('e', '{}', 'published'),
        ('f', '{}', 'published'),
        ('g', '{}', 'failed')`,
    );

    const stats = await service.getStatistics();
    expect(stats).toEqual({
      pending: 2,
      processing: 1,
      published: 3,
      failed: 1,
    });
  });

  it("getStatistics returns all-zero shape on an empty table", async () => {
    const stats = await service.getStatistics();
    expect(stats).toEqual({
      pending: 0,
      processing: 0,
      published: 0,
      failed: 0,
    });
  });
});
