import { DrizzleEntityService } from "@sixthsummit/ship-api/app/services/DrizzleEntityService";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the drainer needs row-level locking + atomic `sql` status transitions that QueryOptions can't express
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  computeNextAttempt,
  type OutboxEvent,
  type OutboxEventStatus,
  outboxEvents,
} from "../schema.js";

/**
 * v4 `OutboxEventService` — extends `DrizzleEntityService` for CRUD
 * + the outbox-specific lifecycle transitions the drain worker needs.
 *
 * Surface inherited from the base:
 *   - `get` / `getAll` / `list` / `count` / `create` / `update` /
 *     `delete` with soft-delete + audit-column auto-stamping.
 *
 * Domain-specific methods added here:
 *
 *   - `findReadyToPublish(limit)` — paginated query of rows where
 *     status='pending' AND publishedAt IS NULL AND
 *     (nextAttemptAt IS NULL OR nextAttemptAt <= now). FIFO ordered
 *     by `(createdAt, id)`. Driven by the drain worker.
 *
 *   - `claimForProcessing(ids[])` — atomic status transition from
 *     'pending' to 'processing' for the listed ids, incrementing
 *     `publishAttempts` and stamping `startedAt`. Returns only the
 *     ids that actually transitioned (compete with concurrent drain
 *     workers safely).
 *
 *   - `markPublished(id)` — terminal success transition.
 *
 *   - `markFailed(id, error)` — terminal failure (no more retries).
 *     Used by the drain worker when `hasExhaustedRetries()` is true
 *     after a failure.
 *
 *   - `markForRetry(id, error, attempts)` — non-terminal failure;
 *     reverts status to 'pending', stamps `lastError`, and schedules
 *     `nextAttemptAt` via the exponential-backoff helper.
 *
 *   - `recoverStaleProcessing(staleThresholdMs)` — admin tooling:
 *     finds rows stuck in 'processing' for longer than the threshold
 *     (worker died mid-publish) and resets them to 'pending' so the
 *     next drain picks them up.
 *
 * The drain orchestration logic itself (loop, batching, error
 * handling, observability) lands in a separate `OutboxDrainer` class
 * in a follow-up commit; the service only owns DB transitions.
 */
export class OutboxEventService extends DrizzleEntityService<
  typeof outboxEvents,
  { outboxEvents: typeof outboxEvents }
> {
  protected getTable() {
    return outboxEvents;
  }

  protected override getDefaultSearchFields(): readonly string[] {
    return ["eventType", "correlationId"];
  }

  /**
   * Read up to `limit` rows that are ready to publish, ordered FIFO.
   * The pending partial index covers this query.
   */
  async findReadyToPublish(limit: number = 100, now: Date = new Date()): Promise<OutboxEvent[]> {
    const rows = await this.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, "pending"),
          isNull(outboxEvents.publishedAt),
          or(isNull(outboxEvents.nextAttemptAt), lte(outboxEvents.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit);
    return rows as OutboxEvent[];
  }

  /**
   * Atomically transition the listed rows from 'pending' to
   * 'processing'. Increments publishAttempts and stamps startedAt.
   * Returns only the ids that actually transitioned — concurrent
   * drain workers compete safely; whichever worker's UPDATE wins gets
   * the row.
   */
  async claimForProcessing(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    const rows = await this.db
      .update(outboxEvents)
      .set({
        status: "processing",
        startedAt: now,
        publishAttempts: sql`${outboxEvents.publishAttempts} + 1`,
        updatedAt: now,
      } as never)
      .where(
        and(
          // Inline as one IN clause to avoid one update-per-id round trip.
          sql`${outboxEvents.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[])`,
          eq(outboxEvents.status, "pending"),
        ),
      )
      .returning({ id: outboxEvents.id as never });
    return (rows as Array<{ id: string }>).map((r) => r.id);
  }

  async markPublished(id: string): Promise<OutboxEvent | null> {
    const now = new Date();
    const [row] = await this.db
      .update(outboxEvents)
      .set({
        status: "published",
        publishedAt: now,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: now,
      } as never)
      .where(eq(outboxEvents.id, id))
      .returning();
    return (row as OutboxEvent | undefined) ?? null;
  }

  async markFailed(id: string, error: string): Promise<OutboxEvent | null> {
    const now = new Date();
    const [row] = await this.db
      .update(outboxEvents)
      .set({
        status: "failed",
        lastError: truncateError(error),
        nextAttemptAt: null,
        updatedAt: now,
      } as never)
      .where(eq(outboxEvents.id, id))
      .returning();
    return (row as OutboxEvent | undefined) ?? null;
  }

  /**
   * Non-terminal failure: schedule a retry with exponential backoff
   * and revert status to 'pending' so the next drain picks it up.
   * Caller owns the attempt-counting logic — typically calls
   * `markForRetry` only when `hasExhaustedRetries(event)` is false.
   */
  async markForRetry(id: string, error: string, attempts: number): Promise<OutboxEvent | null> {
    const now = new Date();
    const nextAt = computeNextAttempt(attempts);
    const [row] = await this.db
      .update(outboxEvents)
      .set({
        status: "pending",
        lastError: truncateError(error),
        nextAttemptAt: nextAt,
        publishedAt: null,
        updatedAt: now,
      } as never)
      .where(eq(outboxEvents.id, id))
      .returning();
    return (row as OutboxEvent | undefined) ?? null;
  }

  /**
   * Admin tooling — find rows stuck in 'processing' beyond the
   * threshold and reset them to 'pending' so the next drain picks
   * them up. Returns the count reset (callers report it).
   */
  async recoverStaleProcessing(
    staleThresholdMs: number = 30 * 60 * 1_000,
  ): Promise<{ recovered: number }> {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const now = new Date();
    const rows = await this.db
      .update(outboxEvents)
      .set({
        status: "pending",
        startedAt: null,
        nextAttemptAt: now,
        updatedAt: now,
      } as never)
      .where(and(eq(outboxEvents.status, "processing"), lte(outboxEvents.startedAt, cutoff)))
      .returning({ id: outboxEvents.id as never });
    return { recovered: (rows as Array<{ id: string }>).length };
  }

  /**
   * Aggregate counts by status — used by the stats endpoint and by
   * monitoring dashboards. Returns 0 for missing buckets so the
   * shape stays stable.
   */
  async getStatistics(): Promise<Record<OutboxEventStatus, number>> {
    const rows = (await this.db
      .select({
        status: outboxEvents.status,
        count: sql<number>`count(*)::int`,
      })
      .from(outboxEvents)
      .groupBy(outboxEvents.status)) as Array<{
      status: OutboxEventStatus;
      count: number;
    }>;
    const stats: Record<OutboxEventStatus, number> = {
      pending: 0,
      processing: 0,
      published: 0,
      failed: 0,
    };
    for (const row of rows) stats[row.status] = row.count;
    return stats;
  }
}

const MAX_ERROR_LENGTH = 4096;
function truncateError(message: string): string {
  if (message.length <= MAX_ERROR_LENGTH) return message;
  return message.slice(0, MAX_ERROR_LENGTH - 3) + "...";
}
