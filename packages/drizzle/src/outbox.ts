import type {
  AnyOutbox,
  OutboxBackend,
  OutboxCleanupResult,
  OutboxFailureDisposition,
  OutboxHealth,
  OutboxIntentInput,
  OutboxRecord,
  OutboxRecordQuery,
  OutboxRecordResult,
  OutboxRecordStatus,
  OutboxRetention,
} from "@sixthsummit/ship-core";
import { isOutbox } from "@sixthsummit/ship-core";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DrizzleRepositoryError } from "./repository-error.js";
import { type DrizzleTransaction, transactionForScope } from "./unit-of-work.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * The durable intent table. Include it in application migrations:
 * `export const outbox = shipOutboxTable();`. One table can serve several
 * outboxes; rows are partitioned by `outbox_id`.
 */
export function shipOutboxTable(name = "ship_outbox") {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_OUTBOX_INVALID",
      `outbox table name must be a lowercase identifier; received ${JSON.stringify(name)}`,
      { field: "table" },
    );
  }
  return pgTable(
    name,
    {
      id: uuid("id").defaultRandom().primaryKey(),
      outboxId: text("outbox_id").notNull(),
      intentId: text("intent_id").notNull(),
      payload: jsonb("payload").notNull(),
      dedupeKey: text("dedupe_key"),
      status: text("status").notNull().default("pending"),
      attempts: integer("attempts").notNull().default(0),
      availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
      leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
      lastError: text("last_error"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
      discardedAt: timestamp("discarded_at", { withTimezone: true }),
      discardReason: text("discard_reason"),
    },
    (table) => [
      uniqueIndex(`${name}_dedupe_idx`).on(table.outboxId, table.intentId, table.dedupeKey),
      index(`${name}_due_idx`).on(table.outboxId, table.status, table.availableAt),
      // The claim's two ordered scans (SAPI-114). Each partial index holds
      // only the rows one claim branch can return, in the order the claim
      // takes them, so a batch reads about `batchSize` index entries whatever
      // the backlog instead of sorting every due row.
      index(`${name}_pending_idx`)
        .on(table.outboxId, table.availableAt, table.createdAt)
        .where(sql`status = 'pending'`),
      index(`${name}_lease_idx`)
        .on(table.outboxId, table.leaseExpiresAt)
        .where(sql`status = 'claimed'`),
    ],
  );
}

export type ShipOutboxTable = ReturnType<typeof shipOutboxTable>;

export interface DrizzleOutboxDefinition<TSchema extends Record<string, unknown>> {
  readonly outbox: AnyOutbox;
  /** Retained privately for dispatcher, management and cleanup statements. */
  readonly database: NodePgDatabase<TSchema>;
  /** Defaults to `shipOutboxTable()`; pass the same instance used in migrations. */
  readonly table?: ShipOutboxTable;
}

export interface DrizzleOutbox extends OutboxBackend {
  readonly adapter: "drizzle";
  readonly table: ShipOutboxTable;
}

type Executor =
  | NodePgDatabase<Record<string, unknown>>
  | DrizzleTransaction<Record<string, unknown>>;

/**
 * Durable PostgreSQL outbox backend. `record()` joins the Drizzle transaction
 * behind the executor-supplied unit-of-work scope so intents commit or roll
 * back with the business change; claims use `FOR UPDATE SKIP LOCKED` so
 * concurrent dispatchers never perform the same record while a lease holds.
 */
export function createDrizzleOutbox<TSchema extends Record<string, unknown>>(
  definition: DrizzleOutboxDefinition<TSchema>,
): DrizzleOutbox {
  assertDefinition(definition);
  const table = definition.table ?? shipOutboxTable();
  const database = definition.database as unknown as Executor;
  const outboxId = definition.outbox.id;

  const record = async (
    scope: object,
    intents: readonly OutboxIntentInput[],
  ): Promise<readonly OutboxRecordResult[]> => {
    const transaction = transactionForScope<Record<string, unknown>>(scope);
    if (!transaction) {
      throw new DrizzleRepositoryError(
        "SHIP_DRIZZLE_OUTBOX_SCOPE_INVALID",
        `outbox ${JSON.stringify(outboxId)} can only record intents inside a Drizzle unit-of-work scope`,
        { repositoryId: outboxId },
      );
    }
    const results: OutboxRecordResult[] = [];
    for (const intent of intents) {
      const inserted = await transaction
        .insert(table)
        .values({
          outboxId,
          intentId: intent.intentId,
          payload: intent.payload as Record<string, unknown>,
          dedupeKey: intent.dedupeKey ?? null,
          availableAt: intent.availableAt,
        })
        .onConflictDoNothing({ target: [table.outboxId, table.intentId, table.dedupeKey] })
        .returning({ id: table.id });
      const row = inserted[0];
      results.push(
        row
          ? Object.freeze({ recordId: row.id, deduplicated: false })
          : Object.freeze({ deduplicated: true }),
      );
    }
    return Object.freeze(results);
  };

  /**
   * Claims in two ordered statements rather than one `OR`: PostgreSQL cannot
   * return an `OR` of two status predicates in index order, so the single
   * statement sorted every due row before `LIMIT` and its cost grew with the
   * backlog (SAPI-114). Lease-expired claims are retaken first so a sustained
   * pending backlog cannot starve them, then pending rows fill the remainder;
   * each statement is an index scan with `LIMIT` and `SKIP LOCKED`, and each
   * is atomic on its own, so two dispatchers still never claim one row twice.
   */
  const claimMatching = async (
    now: Date,
    batchSize: number,
    leaseMs: number,
    intentFilter?: SQL,
  ): Promise<readonly OutboxRecord[]> => {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const claim = async (condition: SQL, limit: number) => {
      const due = database
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.outboxId, outboxId), intentFilter, condition))
        .orderBy(asc(table.availableAt), asc(table.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      return database
        .update(table)
        .set({ status: "claimed", leaseExpiresAt })
        .where(inArray(table.id, due))
        .returning();
    };
    const expired = await claim(
      and(eq(table.status, "claimed"), lte(table.leaseExpiresAt, now)) as SQL,
      batchSize,
    );
    const remaining = batchSize - expired.length;
    const pending =
      remaining > 0
        ? await claim(
            and(eq(table.status, "pending"), lte(table.availableAt, now)) as SQL,
            remaining,
          )
        : [];
    return Object.freeze(
      [...expired, ...pending]
        .map(toRecord)
        .sort(
          (left, right) =>
            left.availableAt.getTime() - right.availableAt.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime(),
        ),
    );
  };

  const claimDue = async (
    now: Date,
    batchSize: number,
    leaseMs: number,
    intentIds?: readonly string[],
  ): Promise<readonly OutboxRecord[]> => {
    if (intentIds !== undefined && intentIds.length === 0) return Object.freeze([]);
    return claimMatching(
      now,
      batchSize,
      leaseMs,
      intentIds ? inArray(table.intentId, [...intentIds]) : undefined,
    );
  };

  const claimUnknownDue = async (
    now: Date,
    batchSize: number,
    leaseMs: number,
    knownIntentIds: readonly string[],
  ): Promise<readonly OutboxRecord[]> =>
    claimMatching(
      now,
      batchSize,
      leaseMs,
      knownIntentIds.length > 0 ? notInArray(table.intentId, [...knownIntentIds]) : undefined,
    );

  const complete = async (recordId: string, now: Date): Promise<void> => {
    await database
      .update(table)
      .set({ status: "completed", completedAt: now, leaseExpiresAt: null })
      .where(
        and(eq(table.id, recordId), eq(table.outboxId, outboxId), eq(table.status, "claimed")),
      );
  };

  const fail = async (
    recordId: string,
    error: string,
    disposition: OutboxFailureDisposition,
    now: Date,
  ): Promise<void> => {
    await database
      .update(table)
      .set({
        attempts: sql`${table.attempts} + 1`,
        lastError: error,
        leaseExpiresAt: null,
        ...("deadLetter" in disposition
          ? { status: "dead-lettered", deadLetteredAt: now }
          : { status: "pending", availableAt: disposition.retryAt }),
      })
      .where(
        and(eq(table.id, recordId), eq(table.outboxId, outboxId), eq(table.status, "claimed")),
      );
  };

  const listDeadLettered = async ({ limit }: { readonly limit: number }) => {
    const rows = await database
      .select()
      .from(table)
      .where(and(eq(table.outboxId, outboxId), eq(table.status, "dead-lettered")))
      .orderBy(asc(table.deadLetteredAt), asc(table.createdAt))
      .limit(limit);
    return Object.freeze(rows.map(toRecord));
  };

  const findRecord = async (recordId: string): Promise<OutboxRecord | undefined> => {
    const rows = await database
      .select()
      .from(table)
      .where(and(eq(table.id, recordId), eq(table.outboxId, outboxId)))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  };

  const listRecords = async (query: OutboxRecordQuery): Promise<readonly OutboxRecord[]> => {
    const rows = await database
      .select()
      .from(table)
      .where(
        and(
          eq(table.outboxId, outboxId),
          query.status !== undefined ? eq(table.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(query.limit);
    return Object.freeze(rows.map(toRecord));
  };

  const retry = async (recordId: string, now: Date) => {
    const rows = await database
      .update(table)
      .set({ status: "pending", availableAt: now, deadLetteredAt: null, leaseExpiresAt: null })
      .where(
        and(
          eq(table.id, recordId),
          eq(table.outboxId, outboxId),
          eq(table.status, "dead-lettered"),
        ),
      )
      .returning();
    return rows[0] ? toRecord(rows[0]) : undefined;
  };

  const discard = async (recordId: string, reason: string, now: Date) => {
    const rows = await database
      .update(table)
      .set({ status: "discarded", discardedAt: now, discardReason: reason })
      .where(
        and(
          eq(table.id, recordId),
          eq(table.outboxId, outboxId),
          eq(table.status, "dead-lettered"),
        ),
      )
      .returning();
    return rows[0] ? toRecord(rows[0]) : undefined;
  };

  const cleanup = async (retention: OutboxRetention, now: Date): Promise<OutboxCleanupResult> => {
    const completed = await database
      .delete(table)
      .where(
        and(
          eq(table.outboxId, outboxId),
          eq(table.status, "completed"),
          isNotNull(table.completedAt),
          lte(table.completedAt, new Date(now.getTime() - retention.completedMs)),
        ),
      )
      .returning({ id: table.id });
    const deadLettered = await database
      .delete(table)
      .where(
        and(
          eq(table.outboxId, outboxId),
          or(
            and(
              eq(table.status, "dead-lettered"),
              lte(table.deadLetteredAt, new Date(now.getTime() - retention.deadLetteredMs)),
            ),
            and(
              eq(table.status, "discarded"),
              lte(table.discardedAt, new Date(now.getTime() - retention.deadLetteredMs)),
            ),
          ),
        ),
      )
      .returning({ id: table.id });
    return Object.freeze({
      completedDeleted: completed.length,
      deadLetteredDeleted: deadLettered.length,
    });
  };

  const health = async (now: Date): Promise<OutboxHealth> => {
    const [row] = await database
      .select({
        pending: sql<number>`count(*) filter (where ${table.status} = 'pending')::int`,
        claimed: sql<number>`count(*) filter (where ${table.status} = 'claimed' and ${table.leaseExpiresAt} > ${now})::int`,
        deadLettered: sql<number>`count(*) filter (where ${table.status} = 'dead-lettered')::int`,
        oldestPendingAt:
          sql<Date | null>`min(${table.availableAt}) filter (where ${table.status} = 'pending')`.mapWith(
            table.availableAt,
          ),
      })
      .from(table)
      .where(eq(table.outboxId, outboxId));
    return Object.freeze({
      pending: row?.pending ?? 0,
      claimed: row?.claimed ?? 0,
      deadLettered: row?.deadLettered ?? 0,
      ...(row?.oldestPendingAt ? { oldestPendingAt: row.oldestPendingAt } : {}),
    });
  };

  return Object.freeze({
    kind: "ship.outbox-backend" as const,
    adapter: "drizzle" as const,
    outboxId,
    table,
    record,
    claimDue,
    claimUnknownDue,
    complete,
    fail,
    listDeadLettered,
    findRecord,
    listRecords,
    retry,
    discard,
    cleanup,
    health,
  });
}

function toRecord(row: ShipOutboxTable["$inferSelect"]): OutboxRecord {
  return Object.freeze({
    id: row.id,
    outboxId: row.outboxId,
    intentId: row.intentId,
    payload: row.payload,
    ...(row.dedupeKey !== null ? { dedupeKey: row.dedupeKey } : {}),
    status: row.status as OutboxRecordStatus,
    attempts: row.attempts,
    availableAt: row.availableAt,
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.deadLetteredAt ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(row.discardedAt ? { discardedAt: row.discardedAt } : {}),
    ...(row.discardReason !== null ? { discardReason: row.discardReason } : {}),
  });
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleOutboxDefinition<Record<string, unknown>> {
  if (typeof definition !== "object" || definition === null) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_OUTBOX_INVALID",
      "outbox definition must be an object",
    );
  }
  const outbox = Reflect.get(definition, "outbox");
  if (!isOutbox(outbox)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_OUTBOX_INVALID",
      "outbox definition must reference an outbox created by defineOutbox()",
      { field: "outbox" },
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_OUTBOX_INVALID",
      "outbox definition must provide a Drizzle database",
      { field: "database", repositoryId: outbox.id },
    );
  }
  const table = Reflect.get(definition, "table");
  if (table !== undefined && (typeof table !== "object" || table === null)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_OUTBOX_INVALID",
      "outbox table must be created with shipOutboxTable()",
      { field: "table", repositoryId: outbox.id },
    );
  }
}
