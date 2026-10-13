import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * v4 transactional outbox table — ports v3's `OutboxEvent` TypeORM
 * entity. Implements the outbox pattern: domain operations write
 * events to this table inside the same transaction as the business
 * data; a separate worker drains pending rows and publishes to
 * downstream systems (queue, webhook, log, etc.) with at-least-once
 * delivery and exponential backoff on failure.
 *
 * Key v4 differences from v3:
 *
 *   - `id` switches from `bigint identity` to `uuid` for consistency
 *     with the rest of the v4 framework. FIFO ordering uses the
 *     `(created_at, event_id)` index instead of monotonic bigint
 *     incrementing.
 *
 *   - `status` becomes a Postgres `pgEnum` instead of a raw text
 *     column. Type-checked at the SQL boundary; cheaper indexes than
 *     text comparison.
 *
 *   - Partial indexes preserved for the hot drain queries — the
 *     `pending` index covers only rows that haven't been published,
 *     and the `processing` index covers only in-flight rows. Both
 *     are tiny relative to the full table and stay fast as the
 *     published-events table grows.
 *
 *   - Audit columns (`createdAt` / `updatedAt` / `deletedAt` /
 *     `createdBy` / `updatedBy`) standardized via `baseFields`. v3
 *     had createdAt + updatedAt only; v4 uniformity is worth the
 *     extra (nullable) columns.
 *
 * The v3 `Job` entity + JobController + job-queue subsystem are
 * intentionally NOT ported. v4's BullMQ machinery (`defineJob` +
 * `JobRegistry` from alpha-2 step 12) is the canonical job substrate;
 * porting v3's competing TypeORM-backed queue would create two
 * conflicting source-of-truth queues. Migration guide: move each
 * v3 Job processor to a `defineJob({ queue, name, processor })` call.
 */

export const outboxEventStatus = pgEnum("outbox_event_status", [
  "pending",
  "processing",
  "published",
  "failed",
]);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * External identifier for the event — the value downstream
     * consumers see. Distinct from `id` to allow re-publishing the
     * same logical event under a new row when a permanent failure
     * gets manually resolved.
     */
    eventId: uuid("event_id").notNull().defaultRandom(),

    /**
     * Domain event type ("account.created", "post.published", ...).
     * Matches the consumer's `EventType` discriminated union.
     */
    eventType: text("event_type").notNull(),

    /** Schema version for the payload. Bump when the payload shape changes. */
    eventVersion: integer("event_version").notNull().default(1),

    /** When the domain operation occurred (may differ from `createdAt`). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),

    /** Aggregate type (entity-class identifier) the event belongs to. */
    aggregateType: text("aggregate_type"),

    /** Aggregate id within `aggregateType`. UUID-shaped string for v4. */
    aggregateId: uuid("aggregate_id"),

    /** Owner of the aggregate (typically `accounts.id`). */
    ownerUserId: uuid("owner_user_id"),

    /**
     * Multi-tenant scoping (A2-1: `uuid` to match `RequestContext.tenantId` and
     * every other v4 id). Nullable — the outbox also carries system/global
     * events with no tenant. No FK: the outbox module doesn't own a `tenants`
     * table, and system events legitimately have a null tenant.
     */
    tenantId: uuid("tenant_id"),

    /**
     * Stable key for upstream-deduplication. Set by the producer when
     * the same logical event might be enqueued twice (idempotency
     * boundary).
     */
    dedupeKey: text("dedupe_key"),

    /** Trace correlation id — flows through to downstream telemetry. */
    correlationId: varchar("correlation_id", { length: 255 }),

    /** Event payload. Consumer-shaped JSON. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    /** Lifecycle state — see the `outboxEventStatus` enum. */
    status: outboxEventStatus("status").notNull().default("pending"),

    /** Number of publish attempts that have been made (incl. failed). */
    publishAttempts: integer("publish_attempts").notNull().default(0),

    /** When the next retry should fire. Null when not scheduled. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),

    /** When the publish succeeded. Null until then. */
    publishedAt: timestamp("published_at", { withTimezone: true }),

    /** Last failure message (truncated to a reasonable length by callers). */
    lastError: text("last_error"),

    /** Maximum number of attempts before giving up and marking failed. */
    maxRetries: integer("max_retries").notNull().default(10),

    /** When the most recent attempt started. */
    startedAt: timestamp("started_at", { withTimezone: true }),

    ...baseFields,
  },
  (table) => [
    // Hot drain query: rows pending or processing that haven't been
    // published yet, ordered by next-attempt → created. Partial index
    // stays small relative to the full table even after years of
    // published events accumulate.
    index("outbox_events_pending_ix")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`status IN ('pending','processing') AND published_at IS NULL`),
    index("outbox_events_type_ix").on(table.eventType, table.createdAt),
    index("outbox_events_owner_ix").on(table.ownerUserId),
    index("outbox_events_status_ix").on(table.status),
    // Stale-processing recovery: only rows in processing state. Tiny
    // index — most events don't get stuck in processing.
    index("outbox_events_processing_ix")
      .on(table.startedAt)
      .where(sql`status = 'processing'`),
    // Aggregate-scoped lookups (e.g., "all events for this account").
    index("outbox_events_aggregate_ix").on(table.aggregateType, table.aggregateId),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type OutboxEventStatus = (typeof outboxEventStatus.enumValues)[number];

// ─── Status helpers (pure functions) ──────────────────────────────────
//
// v3 had these as instance methods on the TypeORM entity class. v4
// rows are plain objects; status logic moves to module-level pure
// functions the service / drain worker calls on the row.

/**
 * True when a pending event is ready to publish: status is `pending`,
 * no publishedAt set, and (if scheduled) the next-attempt time has
 * passed. The drain query also filters by index — this helper is for
 * service-layer assertions and tests.
 */
export function isReadyForPublish(
  event: Pick<OutboxEvent, "status" | "publishedAt" | "nextAttemptAt">,
  now: Date = new Date(),
): boolean {
  if (event.status !== "pending") return false;
  if (event.publishedAt) return false;
  if (event.nextAttemptAt && event.nextAttemptAt > now) return false;
  return true;
}

export function hasExhaustedRetries(
  event: Pick<OutboxEvent, "publishAttempts" | "maxRetries">,
): boolean {
  return event.publishAttempts >= event.maxRetries;
}

/**
 * Compute the next-attempt time using exponential backoff with jitter.
 * `baseMs * 2^(attempts - 1)` capped at `maxMs`. Used by the drain
 * worker when a publish fails and the event is still under the retry
 * budget.
 */
export function computeNextAttempt(
  attempts: number,
  baseMs: number = 1_000,
  maxMs: number = 60 * 60 * 1_000,
): Date {
  const exponential = baseMs * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, maxMs);
  // ±20% jitter to avoid thundering-herd on retries.
  const jittered = capped * (0.8 + Math.random() * 0.4);
  return new Date(Date.now() + jittered);
}
