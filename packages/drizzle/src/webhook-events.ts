import type {
  StoredWebhookEvent,
  WebhookEventCleanupRequest,
  WebhookEventCleanupResult,
  WebhookEventInput,
  WebhookEventStore,
} from "@sixthsummit/ship-core";
import { and, eq, inArray, like, lt, notExists, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { customType, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ShipIdempotencyTable } from "./idempotency.js";
import type { ShipOutboxTable } from "./outbox.js";
import { DrizzleRepositoryError } from "./repository-error.js";
import { type DrizzleTransaction, transactionForScope } from "./unit-of-work.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

/** Exact request bytes; `pg` returns `bytea` as a Buffer, which is a Uint8Array view. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

/**
 * The durable raw-event table for enqueue-mode webhooks. Include it in
 * application migrations: `export const webhookEvents = shipWebhookEventsTable();`.
 * Headers are stored already redacted by the kernel; the body is byte-exact.
 */
export function shipWebhookEventsTable(name = "ship_webhook_events") {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_WEBHOOK_EVENTS_INVALID",
      `webhook events table name must be a lowercase identifier; received ${JSON.stringify(name)}`,
      { field: "table" },
    );
  }
  return pgTable(
    name,
    {
      id: uuid("id").primaryKey(),
      webhookId: text("webhook_id").notNull(),
      provider: text("provider").notNull(),
      providerEventId: text("provider_event_id"),
      requestId: text("request_id").notNull(),
      receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
      contentType: text("content_type"),
      headers: jsonb("headers").notNull(),
      body: bytea("body").notNull(),
      outboxRecordId: uuid("outbox_record_id"),
    },
    (table) => [index(`${name}_retention_idx`).on(table.webhookId, table.receivedAt)],
  );
}

export type ShipWebhookEventsTable = ReturnType<typeof shipWebhookEventsTable>;

export interface DrizzleWebhookEventStoreDefinition<TSchema extends Record<string, unknown>> {
  readonly database: NodePgDatabase<TSchema>;
  /** Defaults to `shipWebhookEventsTable()`; pass the same instance used in migrations. */
  readonly table?: ShipWebhookEventsTable;
  /** The outbox table the linked intents live in; required for cleanup to retain undispatched events. */
  readonly outboxTable?: ShipOutboxTable;
  /** The idempotency table whose expired webhook claims cleanup deletes. */
  readonly idempotencyTable?: ShipIdempotencyTable;
}

export interface DrizzleWebhookEventStore extends WebhookEventStore {
  readonly adapter: "drizzle";
  readonly table: ShipWebhookEventsTable;
}

type Executor =
  | NodePgDatabase<Record<string, unknown>>
  | DrizzleTransaction<Record<string, unknown>>;

/**
 * PostgreSQL webhook event store. `record()` and `link()` join the Drizzle
 * transaction behind the executor-supplied unit-of-work scope, so the event,
 * its outbox intent and the idempotency claim commit or roll back together.
 * `cleanup()` never deletes an event whose linked outbox record is still
 * pending or claimed.
 */
export function createDrizzleWebhookEventStore<TSchema extends Record<string, unknown>>(
  definition: DrizzleWebhookEventStoreDefinition<TSchema>,
): DrizzleWebhookEventStore {
  assertDefinition(definition);
  const table = definition.table ?? shipWebhookEventsTable();
  const database = definition.database as unknown as Executor;
  const outboxTable = definition.outboxTable;
  const idempotencyTable = definition.idempotencyTable;

  const requireTransaction = (scope: object, action: string) => {
    const transaction = transactionForScope<Record<string, unknown>>(scope);
    if (!transaction) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_WEBHOOK_EVENTS_SCOPE_INVALID",
        `webhook events can only ${action} inside a Drizzle unit-of-work scope`,
        { field: action },
      );
    }
    return transaction;
  };

  const record = async (scope: object, event: WebhookEventInput): Promise<void> => {
    await requireTransaction(scope, "record")
      .insert(table)
      .values({
        id: event.id,
        webhookId: event.webhookId,
        provider: event.provider,
        providerEventId: event.providerEventId ?? null,
        requestId: event.requestId,
        receivedAt: event.receivedAt,
        contentType: event.contentType ?? null,
        headers: event.headers as Record<string, string>,
        body: event.body,
      });
  };

  const link = async (scope: object, eventId: string, outboxRecordId: string): Promise<void> => {
    await requireTransaction(scope, "link")
      .update(table)
      .set({ outboxRecordId })
      .where(eq(table.id, eventId));
  };

  const read = async (eventId: string): Promise<StoredWebhookEvent | undefined> => {
    const [row] = await database.select().from(table).where(eq(table.id, eventId));
    return row ? toEvent(row) : undefined;
  };

  const cleanup = async (
    request: WebhookEventCleanupRequest,
  ): Promise<WebhookEventCleanupResult> => {
    const retained = outboxTable
      ? notExists(
          database
            .select({ id: outboxTable.id })
            .from(outboxTable)
            .where(
              and(
                eq(outboxTable.id, table.outboxRecordId),
                inArray(outboxTable.status, ["pending", "claimed"]),
              ),
            ),
        )
      : undefined;
    const deleted = await database
      .delete(table)
      .where(
        and(
          eq(table.webhookId, request.webhookId),
          lt(table.receivedAt, request.eventsBefore),
          retained ? or(sql`${table.outboxRecordId} is null`, retained) : undefined,
        ),
      )
      .returning({ id: table.id });
    let claimsDeleted = 0;
    if (idempotencyTable) {
      const claims = await database
        .delete(idempotencyTable)
        .where(
          and(
            like(idempotencyTable.key, `${escapeLike(request.claimKeyPrefix)}%`),
            lt(idempotencyTable.expiresAt, request.claimsBefore),
          ),
        )
        .returning({ key: idempotencyTable.key });
      claimsDeleted = claims.length;
    }
    return Object.freeze({ eventsDeleted: deleted.length, claimsDeleted });
  };

  return Object.freeze({
    kind: "ship.webhook-event-store" as const,
    adapter: "drizzle" as const,
    table,
    record,
    link,
    read,
    cleanup,
  });
}

function toEvent(row: ShipWebhookEventsTable["$inferSelect"]): StoredWebhookEvent {
  return Object.freeze({
    id: row.id,
    webhookId: row.webhookId,
    provider: row.provider,
    ...(row.providerEventId !== null ? { providerEventId: row.providerEventId } : {}),
    requestId: row.requestId,
    receivedAt: row.receivedAt,
    ...(row.contentType !== null ? { contentType: row.contentType } : {}),
    headers: Object.freeze({ ...(row.headers as Record<string, string>) }),
    body: row.body,
    ...(row.outboxRecordId !== null ? { outboxRecordId: row.outboxRecordId } : {}),
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleWebhookEventStoreDefinition<Record<string, unknown>> {
  if (typeof definition !== "object" || definition === null) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_WEBHOOK_EVENTS_INVALID",
      "webhook event store definition must be an object",
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_WEBHOOK_EVENTS_INVALID",
      "webhook event store definition must provide a Drizzle database",
      { field: "database" },
    );
  }
  for (const field of ["table", "outboxTable", "idempotencyTable"]) {
    const value = Reflect.get(definition, field);
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_WEBHOOK_EVENTS_INVALID",
        `webhook event store ${field} must be a Drizzle table`,
        { field },
      );
    }
  }
}
