import type {
  IdempotencyClaim,
  IdempotencyContext,
  IdempotencyStore,
} from "@sixthsummit/ship-core";
import { and, eq, gt, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { DrizzleRepositoryError } from "./repository-error.js";
import { type DrizzleTransaction, transactionForScope } from "./unit-of-work.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

/** Idempotency key table. Include it in application migrations. */
export function shipIdempotencyTable(name = "ship_idempotency_keys") {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_IDEMPOTENCY_INVALID",
      `idempotency table name must be a lowercase identifier; received ${JSON.stringify(name)}`,
      { field: "table" },
    );
  }
  return pgTable(name, {
    key: text("key").primaryKey(),
    status: text("status").notNull().default("in-flight"),
    result: jsonb("result"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  });
}

export type ShipIdempotencyTable = ReturnType<typeof shipIdempotencyTable>;

export interface DrizzleIdempotencyStoreDefinition<TSchema extends Record<string, unknown>> {
  readonly database: NodePgDatabase<TSchema>;
  readonly table?: ShipIdempotencyTable;
}

export interface DrizzleIdempotencyStore extends IdempotencyStore {
  readonly adapter: "drizzle";
  readonly table: ShipIdempotencyTable;
}

type Executor =
  | NodePgDatabase<Record<string, unknown>>
  | DrizzleTransaction<Record<string, unknown>>;

/**
 * PostgreSQL idempotency store.
 *
 * Outside a transaction (`transaction: "none"` operations) every call commits
 * on its own, so a concurrent caller observes `in-flight` immediately. Inside a
 * `read`/`write` operation the executor passes the unit-of-work scope and the
 * store joins that transaction: the claim row and the stored result commit or
 * roll back atomically with the business change, and a concurrent claim on the
 * same key blocks on the primary-key index until the first transaction ends,
 * then observes `duplicate` (after commit) or `claimed` (after rollback).
 */
export function createDrizzleIdempotencyStore<TSchema extends Record<string, unknown>>(
  definition: DrizzleIdempotencyStoreDefinition<TSchema>,
): DrizzleIdempotencyStore {
  assertDefinition(definition);
  const table = definition.table ?? shipIdempotencyTable();
  const database = definition.database as unknown as Executor;
  const executor = (context: IdempotencyContext): Executor =>
    transactionForScope<Record<string, unknown>>(context.scope) ?? database;

  const claim = async (
    key: string,
    ttlMs: number,
    context: IdempotencyContext,
  ): Promise<IdempotencyClaim> => {
    const db = executor(context);
    const expiresAt = new Date(context.now.getTime() + ttlMs);
    const inserted = await db
      .insert(table)
      .values({ key, status: "in-flight", expiresAt, createdAt: context.now })
      .onConflictDoNothing({ target: table.key })
      .returning({ key: table.key });
    if (inserted.length > 0) return "claimed";
    const reclaimed = await db
      .update(table)
      .set({
        status: "in-flight",
        result: null,
        expiresAt,
        createdAt: context.now,
        completedAt: null,
      })
      .where(and(eq(table.key, key), lte(table.expiresAt, context.now)))
      .returning({ key: table.key });
    if (reclaimed.length > 0) return "claimed";
    const [existing] = await db
      .select({ status: table.status })
      .from(table)
      .where(eq(table.key, key));
    return existing?.status === "completed" ? "duplicate" : "in-flight";
  };

  const complete = async (key: string, result: unknown, context: IdempotencyContext) => {
    await executor(context)
      .update(table)
      .set({
        status: "completed",
        result: result as Record<string, unknown>,
        completedAt: context.now,
      })
      .where(eq(table.key, key));
  };

  const release = async (key: string, context: IdempotencyContext) => {
    await executor(context)
      .delete(table)
      .where(and(eq(table.key, key), eq(table.status, "in-flight")));
  };

  const readResult = async (key: string, context: IdempotencyContext) => {
    const [row] = await executor(context)
      .select({ result: table.result })
      .from(table)
      .where(
        and(eq(table.key, key), eq(table.status, "completed"), gt(table.expiresAt, context.now)),
      );
    return row?.result ?? undefined;
  };

  return Object.freeze({
    kind: "ship.idempotency-store" as const,
    adapter: "drizzle" as const,
    table,
    claim,
    complete,
    release,
    readResult,
  });
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleIdempotencyStoreDefinition<Record<string, unknown>> {
  if (typeof definition !== "object" || definition === null) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_IDEMPOTENCY_INVALID",
      "idempotency store definition must be an object",
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_IDEMPOTENCY_INVALID",
      "idempotency store definition must provide a Drizzle database",
      { field: "database" },
    );
  }
  const table = Reflect.get(definition, "table");
  if (table !== undefined && (typeof table !== "object" || table === null)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_IDEMPOTENCY_INVALID",
      "idempotency table must be created with shipIdempotencyTable()",
      { field: "table" },
    );
  }
}
