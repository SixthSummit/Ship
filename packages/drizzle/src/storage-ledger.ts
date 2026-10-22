import type {
  AttachmentAttachInput,
  AttachmentDetachInput,
  AttachmentIntent,
  AttachmentIntentInput,
  AttachmentLedger,
  AttachmentLedgerHealth,
  AttachmentObject,
  AttachmentPurge,
  AttachmentVariantObject,
} from "@sixthsummit/ship-core";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { DrizzleRepositoryError } from "./repository-error.js";
import { type DrizzleTransaction, transactionForScope } from "./unit-of-work.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * Signed upload intents. Include it in application migrations:
 * `export const storageIntents = shipStorageIntentsTable();`. One row per
 * issued intent; the sweep abandons rows still `pending` past `expires_at`.
 */
export function shipStorageIntentsTable(name = "ship_storage_intents") {
  assertTableName(name, "intents");
  return pgTable(
    name,
    {
      id: uuid("id").primaryKey(),
      attachmentId: text("attachment_id").notNull(),
      key: text("key").notNull().unique(),
      contentType: text("content_type").notNull(),
      size: bigint("size", { mode: "number" }).notNull(),
      actorId: text("actor_id").notNull(),
      status: text("status").notNull().default("pending"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
      objectId: uuid("object_id"),
    },
    (table) => [
      // The sweep's scan: only pending rows, in expiry order.
      index(`${name}_expiry_idx`)
        .on(table.expiresAt)
        .where(sql`status = 'pending'`),
    ],
  );
}

/**
 * Stored objects. `uploaded` rows are completed uploads not yet attached to
 * an owner; `attached` rows belong to `(attachment_id, owner_id)`; `purging`
 * rows have a purge row owed; `purged` rows are retained as an audit trail
 * until the application's own retention policy removes them.
 */
export function shipStorageObjectsTable(name = "ship_storage_objects") {
  assertTableName(name, "objects");
  return pgTable(
    name,
    {
      id: uuid("id").primaryKey(),
      attachmentId: text("attachment_id").notNull(),
      key: text("key").notNull().unique(),
      contentType: text("content_type").notNull(),
      size: bigint("size", { mode: "number" }).notNull(),
      status: text("status").notNull().default("uploaded"),
      uploadedBy: text("uploaded_by").notNull(),
      ownerId: text("owner_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      attachedAt: timestamp("attached_at", { withTimezone: true }),
      variants: jsonb("variants").notNull().default({}),
    },
    (table) => [
      index(`${name}_owner_idx`)
        .on(table.attachmentId, table.ownerId)
        .where(sql`status = 'attached'`),
      // The sweep's second scan: uploads never attached, oldest first.
      index(`${name}_stale_idx`)
        .on(table.createdAt)
        .where(sql`status = 'uploaded'`),
    ],
  );
}

/**
 * The purge ledger: one row per object whose deletion is owed. The outbox
 * intent performs the provider delete and marks the row; a replayed intent
 * finds `purged_at` set and does nothing, which is what makes the purge
 * idempotent across at-least-once delivery.
 */
export function shipStoragePurgesTable(name = "ship_storage_purges") {
  assertTableName(name, "purges");
  return pgTable(name, {
    objectId: uuid("object_id").primaryKey(),
    keys: jsonb("keys").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  });
}

export type ShipStorageIntentsTable = ReturnType<typeof shipStorageIntentsTable>;
export type ShipStorageObjectsTable = ReturnType<typeof shipStorageObjectsTable>;
export type ShipStoragePurgesTable = ReturnType<typeof shipStoragePurgesTable>;

export interface DrizzleAttachmentLedgerDefinition<TSchema extends Record<string, unknown>> {
  readonly database: NodePgDatabase<TSchema>;
  /** Default `shipStorageIntentsTable()`; pass the instances used in migrations. */
  readonly intents?: ShipStorageIntentsTable;
  readonly objects?: ShipStorageObjectsTable;
  readonly purges?: ShipStoragePurgesTable;
}

export interface DrizzleAttachmentLedger extends AttachmentLedger {
  readonly adapter: "drizzle";
  readonly tables: {
    readonly intents: ShipStorageIntentsTable;
    readonly objects: ShipStorageObjectsTable;
    readonly purges: ShipStoragePurgesTable;
  };
}

type Executor =
  | NodePgDatabase<Record<string, unknown>>
  | DrizzleTransaction<Record<string, unknown>>;

/**
 * PostgreSQL attachment ledger. `attach()` and `detach()` join the Drizzle
 * transaction behind the executor-supplied unit-of-work scope, so the
 * ownership change and the purge row commit or roll back with the owning
 * record; the other methods run autonomously. Claims use
 * `FOR UPDATE SKIP LOCKED`, so concurrent sweepers never abandon one intent
 * twice.
 */
export function createDrizzleAttachmentLedger<TSchema extends Record<string, unknown>>(
  definition: DrizzleAttachmentLedgerDefinition<TSchema>,
): DrizzleAttachmentLedger {
  assertDefinition(definition);
  const intents = definition.intents ?? shipStorageIntentsTable();
  const objects = definition.objects ?? shipStorageObjectsTable();
  const purges = definition.purges ?? shipStoragePurgesTable();
  const database = definition.database as unknown as Executor;
  const executor = (scope: object | undefined): Executor =>
    transactionForScope<Record<string, unknown>>(scope) ?? database;

  const createIntent = async (input: AttachmentIntentInput): Promise<AttachmentIntent> => {
    const [row] = await database
      .insert(intents)
      .values({
        id: input.id,
        attachmentId: input.attachmentId,
        key: input.key,
        contentType: input.contentType,
        size: input.size,
        actorId: input.actorId,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    return toIntent(row!);
  };

  const readIntent = async (intentId: string): Promise<AttachmentIntent | undefined> => {
    const [row] = await database.select().from(intents).where(eq(intents.id, intentId));
    return row ? toIntent(row) : undefined;
  };

  const completeIntent: AttachmentLedger["completeIntent"] = async (input) =>
    database.transaction(async (transaction) => {
      const [intent] = await transaction
        .update(intents)
        .set({ status: "completed", completedAt: input.completedAt, objectId: input.objectId })
        .where(and(eq(intents.id, input.intentId), eq(intents.status, "pending")))
        .returning();
      if (!intent) return undefined;
      const [object] = await transaction
        .insert(objects)
        .values({
          id: input.objectId,
          attachmentId: intent.attachmentId,
          key: intent.key,
          contentType: input.contentType,
          size: input.size,
          status: "uploaded",
          uploadedBy: intent.actorId,
          createdAt: input.completedAt,
          variants: {},
        })
        .returning();
      return Object.freeze({ intent: toIntent(intent), object: toObject(object!) });
    });

  const claimExpiredIntents = async (
    now: Date,
    limit: number,
  ): Promise<readonly AttachmentIntent[]> => {
    const due = database
      .select({ id: intents.id })
      .from(intents)
      .where(and(eq(intents.status, "pending"), lte(intents.expiresAt, now)))
      .orderBy(asc(intents.expiresAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const rows = await database
      .update(intents)
      .set({ status: "abandoned", abandonedAt: now })
      .where(inArray(intents.id, due))
      .returning();
    return Object.freeze(rows.map(toIntent));
  };

  const readObject = async (
    scope: object | undefined,
    objectId: string,
  ): Promise<AttachmentObject | undefined> => {
    const [row] = await executor(scope).select().from(objects).where(eq(objects.id, objectId));
    return row ? toObject(row) : undefined;
  };

  const listObjects = async (
    scope: object | undefined,
    attachmentId: string,
    ownerId: string,
  ): Promise<readonly AttachmentObject[]> => {
    const rows = await executor(scope)
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.attachmentId, attachmentId),
          eq(objects.ownerId, ownerId),
          eq(objects.status, "attached"),
        ),
      )
      .orderBy(asc(objects.attachedAt), asc(objects.id));
    return Object.freeze(rows.map(toObject));
  };

  const attach = async (
    scope: object | undefined,
    input: AttachmentAttachInput,
  ): Promise<AttachmentObject | undefined> => {
    const [row] = await executor(scope)
      .update(objects)
      .set({ status: "attached", ownerId: input.ownerId, attachedAt: input.attachedAt })
      .where(
        and(
          eq(objects.id, input.objectId),
          eq(objects.attachmentId, input.attachmentId),
          eq(objects.status, "uploaded"),
        ),
      )
      .returning();
    return row ? toObject(row) : undefined;
  };

  const requestPurges = async (
    db: Executor,
    rows: readonly (typeof objects)["$inferSelect"][],
    requestedAt: Date,
  ): Promise<void> => {
    if (rows.length === 0) return;
    await db
      .insert(purges)
      .values(
        rows.map((row) => ({
          objectId: row.id,
          keys: purgeKeys(row),
          requestedAt,
        })),
      )
      .onConflictDoNothing({ target: purges.objectId });
  };

  const detach = async (
    scope: object | undefined,
    input: AttachmentDetachInput,
  ): Promise<readonly AttachmentObject[]> => {
    const db = executor(scope);
    const rows = await db
      .update(objects)
      .set({ status: "purging" })
      .where(
        and(
          eq(objects.attachmentId, input.attachmentId),
          eq(objects.ownerId, input.ownerId),
          eq(objects.status, "attached"),
          input.objectId === undefined ? undefined : eq(objects.id, input.objectId),
        ),
      )
      .returning();
    await requestPurges(db, rows, input.requestedAt);
    return Object.freeze(rows.map(toObject));
  };

  const claimStaleObjects = async (
    cutoff: Date,
    limit: number,
  ): Promise<readonly AttachmentObject[]> =>
    database.transaction(async (transaction) => {
      const stale = transaction
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.status, "uploaded"), lte(objects.createdAt, cutoff)))
        .orderBy(asc(objects.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const rows = await transaction
        .update(objects)
        .set({ status: "purging" })
        .where(inArray(objects.id, stale))
        .returning();
      await requestPurges(transaction, rows, new Date());
      return Object.freeze(rows.map(toObject));
    });

  const recordVariant = async (
    objectId: string,
    name: string,
    variant: AttachmentVariantObject,
  ): Promise<void> => {
    const patch = JSON.stringify({ [name]: variant });
    await database
      .update(objects)
      .set({ variants: sql`${objects.variants} || ${patch}::jsonb` })
      .where(eq(objects.id, objectId));
  };

  const readPurge = async (objectId: string): Promise<AttachmentPurge | undefined> => {
    const [row] = await database.select().from(purges).where(eq(purges.objectId, objectId));
    return row ? toPurge(row) : undefined;
  };

  const markPurged = async (objectId: string, purgedAt: Date): Promise<boolean> =>
    database.transaction(async (transaction) => {
      const rows = await transaction
        .update(purges)
        .set({ purgedAt, attempts: sql`${purges.attempts} + 1` })
        .where(and(eq(purges.objectId, objectId), isNull(purges.purgedAt)))
        .returning({ objectId: purges.objectId });
      if (rows.length === 0) return false;
      await transaction.update(objects).set({ status: "purged" }).where(eq(objects.id, objectId));
      return true;
    });

  const health = async (): Promise<AttachmentLedgerHealth> => {
    try {
      const [row] = await database
        .select({ pending: sql<number>`count(*)::int` })
        .from(purges)
        .where(isNull(purges.purgedAt));
      return Object.freeze({ available: true, detail: `${row?.pending ?? 0} purges owed` });
    } catch (error) {
      return Object.freeze({
        available: false,
        detail: error instanceof Error ? error.message : "ledger query failed",
      });
    }
  };

  return Object.freeze({
    kind: "ship.attachment-ledger" as const,
    adapter: "drizzle" as const,
    tables: Object.freeze({ intents, objects, purges }),
    createIntent,
    readIntent,
    completeIntent,
    claimExpiredIntents,
    readObject,
    listObjects,
    attach,
    detach,
    claimStaleObjects,
    recordVariant,
    readPurge,
    markPurged,
    health,
  });
}

function purgeKeys(row: ShipStorageObjectsTable["$inferSelect"]): string[] {
  const variants = (row.variants ?? {}) as Record<string, AttachmentVariantObject>;
  return [row.key, ...Object.values(variants).map((variant) => variant.key)];
}

function toIntent(row: ShipStorageIntentsTable["$inferSelect"]): AttachmentIntent {
  return Object.freeze({
    id: row.id,
    attachmentId: row.attachmentId,
    key: row.key,
    contentType: row.contentType,
    size: Number(row.size),
    actorId: row.actorId,
    status: row.status as AttachmentIntent["status"],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.abandonedAt ? { abandonedAt: row.abandonedAt } : {}),
    ...(row.objectId ? { objectId: row.objectId } : {}),
  });
}

function toObject(row: ShipStorageObjectsTable["$inferSelect"]): AttachmentObject {
  return Object.freeze({
    id: row.id,
    attachmentId: row.attachmentId,
    key: row.key,
    contentType: row.contentType,
    size: Number(row.size),
    status: row.status as AttachmentObject["status"],
    uploadedBy: row.uploadedBy,
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    createdAt: row.createdAt,
    ...(row.attachedAt ? { attachedAt: row.attachedAt } : {}),
    variants: Object.freeze({
      ...((row.variants ?? {}) as Record<string, AttachmentVariantObject>),
    }),
  });
}

function toPurge(row: ShipStoragePurgesTable["$inferSelect"]): AttachmentPurge {
  return Object.freeze({
    objectId: row.objectId,
    keys: Object.freeze([...(row.keys as string[])]),
    requestedAt: row.requestedAt,
    ...(row.purgedAt ? { purgedAt: row.purgedAt } : {}),
    attempts: row.attempts,
  });
}

function assertTableName(name: string, table: string): void {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_STORAGE_LEDGER_INVALID",
      `storage ${table} table name must be a lowercase identifier; received ${JSON.stringify(name)}`,
      { field: "table" },
    );
  }
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleAttachmentLedgerDefinition<Record<string, unknown>> {
  if (typeof definition !== "object" || definition === null) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_STORAGE_LEDGER_INVALID",
      "attachment ledger definition must be an object",
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_STORAGE_LEDGER_INVALID",
      "attachment ledger requires a Drizzle node-postgres database",
      { field: "database" },
    );
  }
}
