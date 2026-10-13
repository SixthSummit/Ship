import type { ShipDb } from "@sixthsummit/ship-api/app/db/client";
import { type NewOutboxEvent, type OutboxEvent, outboxEvents } from "./schema.js";

/**
 * Producer-side helper for the transactional outbox pattern.
 *
 * Domain operations call `emitter.emit(...)` *inside the same
 * transaction* as the business write. Postgres atomicity guarantees
 * either both commit or neither — the outbox row is never orphaned
 * from the domain change, and the domain change is never published
 * without an outbox row to drain.
 *
 * Usage:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const account = await accountService.create({...}, { tx });
 *   await emitter.emit({
 *     eventType: "account.created",
 *     aggregateType: "account",
 *     aggregateId: account.id,
 *     payload: { id: account.id, email: account.email },
 *   }, { tx });
 * });
 * ```
 *
 * The drain worker (`OutboxDrainer`) picks up the row asynchronously
 * and dispatches it to the registered `EventHandler`s. Producers
 * never see the dispatch chain — they just write the event.
 *
 * Why a class instead of a free function: the emitter is constructed
 * once per app with the framework's `db` client; consumers inject it
 * into services / route handlers via the `deps` parameter.
 */
export class OutboxEventEmitter<
  TSchema extends Record<string, unknown> = { outboxEvents: typeof outboxEvents },
> {
  constructor(private readonly db: ShipDb<TSchema>) {}

  /**
   * Append an event to the outbox. Pass a transaction client (`tx`)
   * via `opts.tx` to atomically pair the event with a domain write —
   * **strongly recommended**. Without `tx`, the event is appended in
   * its own implicit transaction and could decouple from the domain
   * write (defeats the purpose of the outbox pattern).
   */
  async emit(input: EmitEventInput, opts: EmitEventOptions = {}): Promise<OutboxEvent> {
    const dbClient = (opts.tx ?? this.db) as unknown as ShipDb<TSchema>;
    const values: NewOutboxEvent = {
      eventType: input.eventType,
      eventVersion: input.eventVersion ?? 1,
      occurredAt: input.occurredAt ?? new Date(),
      aggregateType: input.aggregateType ?? null,
      aggregateId: input.aggregateId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      tenantId: input.tenantId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      correlationId: input.correlationId ?? null,
      payload: input.payload,
      maxRetries: input.maxRetries ?? 10,
    };
    const inserter = dbClient as unknown as {
      insert: (table: typeof outboxEvents) => {
        values: (v: unknown) => { returning: () => Promise<OutboxEvent[]> };
      };
    };
    const [row] = await inserter.insert(outboxEvents).values(values).returning();
    return row;
  }
}

export interface EmitEventInput {
  /** Domain event type — matches a registered handler's `type`. */
  eventType: string;
  /** Schema version for the payload. Bump when payload shape changes. */
  eventVersion?: number;
  /** When the domain operation occurred. Defaults to `now()`. */
  occurredAt?: Date;
  /** Aggregate type ("account", "post", ...). */
  aggregateType?: string | null;
  /** Aggregate id within `aggregateType`. */
  aggregateId?: string | null;
  /** Owner user id (typically `accounts.id`). */
  ownerUserId?: string | null;
  /** Multi-tenant scope. */
  tenantId?: string | null;
  /** Stable dedup key for upstream-deduplication. */
  dedupeKey?: string | null;
  /** Trace correlation id. */
  correlationId?: string | null;
  /** Event payload. Consumer-shaped JSON. */
  payload: Record<string, unknown>;
  /** Override the default 10-attempt retry budget. */
  maxRetries?: number;
}

export interface EmitEventOptions {
  /**
   * Transaction client to participate in. Pass the same `tx` you're
   * using for the domain write so the outbox row commits atomically
   * with the business data. Without `tx`, the event is appended in
   * its own transaction — usable for fire-and-forget signals where
   * the outbox semantics don't matter.
   */
  tx?: unknown;
}
