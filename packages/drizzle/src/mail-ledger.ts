import type {
  MailLedger,
  MailLedgerClaim,
  MailLedgerClaimResult,
  MailLedgerQuery,
  MailSendRecord,
  MailSendStatus,
} from "@sixthsummit/ship-core";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { DrizzleRepositoryError } from "./repository-error.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * The send ledger: one row per idempotency key. Include it in application
 * migrations: `export const mailSends = shipMailSendsTable();`. Columns are
 * only ever added; the delivery job never mutates `recipients`, so a consumer
 * can answer "did this person get this email" from the row alone.
 */
export function shipMailSendsTable(name = "ship_mail_sends") {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_MAIL_LEDGER_INVALID",
      `mail sends table name must be a lowercase identifier; received ${JSON.stringify(name)}`,
      { field: "table" },
    );
  }
  return pgTable(
    name,
    {
      idempotencyKey: text("idempotency_key").primaryKey(),
      mailerId: text("mailer_id").notNull(),
      message: text("message").notNull(),
      /** Recipients the application addressed, as a JSON array of strings. */
      recipients: jsonb("recipients").notNull().$type<string[]>(),
      /** Recipients handed to the provider; differs from `recipients` when intercepted. */
      deliveredTo: jsonb("delivered_to").notNull().$type<string[]>(),
      intercepted: boolean("intercepted").notNull().default(false),
      subject: text("subject").notNull(),
      status: text("status").notNull().default("sending"),
      attempts: integer("attempts").notNull().default(1),
      provider: text("provider").notNull(),
      providerMessageId: text("provider_message_id"),
      lastError: text("last_error"),
      tenantId: text("tenant_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
      sentAt: timestamp("sent_at", { withTimezone: true }),
      failedAt: timestamp("failed_at", { withTimezone: true }),
    },
    (table) => [
      index(`${name}_message_idx`).on(table.mailerId, table.message, table.createdAt),
      index(`${name}_recipients_idx`).using("gin", table.recipients),
      index(`${name}_tenant_idx`).on(table.tenantId, table.createdAt),
    ],
  );
}

export type ShipMailSendsTable = ReturnType<typeof shipMailSendsTable>;

export interface DrizzleMailLedgerDefinition<TSchema extends Record<string, unknown>> {
  readonly database: NodePgDatabase<TSchema>;
  /** Defaults to `shipMailSendsTable()`; pass the same instance used in migrations. */
  readonly table?: ShipMailSendsTable;
}

export interface DrizzleMailLedger extends MailLedger {
  readonly adapter: "drizzle";
  readonly table: ShipMailSendsTable;
}

type Row = ShipMailSendsTable["$inferSelect"];

/**
 * PostgreSQL send ledger. `claim` is one `INSERT … ON CONFLICT DO NOTHING`
 * followed, on conflict, by a conditional `UPDATE … RETURNING` that retakes a
 * `failed` row or a `sending` claim whose lease lapsed; every statement
 * commits on its own so two workers holding the same key observe each other
 * immediately. Nothing here joins an application transaction: the ledger is
 * written by the delivery job, which runs with `transaction: "none"`.
 */
export function createDrizzleMailLedger<TSchema extends Record<string, unknown>>(
  definition: DrizzleMailLedgerDefinition<TSchema>,
): DrizzleMailLedger {
  assertDefinition(definition);
  const table = definition.table ?? shipMailSendsTable();
  const database = definition.database as unknown as NodePgDatabase<Record<string, unknown>>;

  const claim = async (request: MailLedgerClaim): Promise<MailLedgerClaimResult> => {
    const inserted = await database
      .insert(table)
      .values({
        idempotencyKey: request.idempotencyKey,
        mailerId: request.mailerId,
        message: request.message,
        recipients: [...request.to],
        deliveredTo: [...request.deliveredTo],
        intercepted: request.intercepted,
        subject: request.subject,
        status: "sending",
        attempts: 1,
        provider: request.provider,
        tenantId: request.tenantId ?? null,
        createdAt: request.now,
        claimedAt: request.now,
      })
      .onConflictDoNothing({ target: table.idempotencyKey })
      .returning({ attempts: table.attempts });
    if (inserted.length > 0) return Object.freeze({ outcome: "claimed" as const, attempt: 1 });

    const staleBefore = new Date(request.now.getTime() - request.leaseMs);
    const retaken = await database
      .update(table)
      .set({
        status: "sending",
        attempts: sql`${table.attempts} + 1`,
        claimedAt: request.now,
        deliveredTo: [...request.deliveredTo],
        intercepted: request.intercepted,
        provider: request.provider,
        failedAt: null,
      })
      .where(
        and(
          eq(table.idempotencyKey, request.idempotencyKey),
          or(
            eq(table.status, "failed"),
            and(eq(table.status, "sending"), lt(table.claimedAt, staleBefore)),
          ),
        ),
      )
      .returning({ attempts: table.attempts });
    const attempt = retaken[0]?.attempts;
    if (attempt !== undefined) return Object.freeze({ outcome: "claimed" as const, attempt });

    const [existing] = await database
      .select()
      .from(table)
      .where(eq(table.idempotencyKey, request.idempotencyKey));
    if (!existing) {
      // Deleted between our statements; one more insert settles it.
      return claim(request);
    }
    const record = toRecord(existing);
    return record.status === "sent"
      ? Object.freeze({ outcome: "sent" as const, record })
      : Object.freeze({ outcome: "in-flight" as const, record });
  };

  const markSent = async (
    idempotencyKey: string,
    outcome: { readonly providerMessageId?: string; readonly now: Date },
  ) => {
    await database
      .update(table)
      .set({
        status: "sent",
        providerMessageId: outcome.providerMessageId ?? null,
        lastError: null,
        sentAt: outcome.now,
        failedAt: null,
      })
      .where(eq(table.idempotencyKey, idempotencyKey));
  };

  const markFailed = async (
    idempotencyKey: string,
    outcome: { readonly error: string; readonly now: Date },
  ) => {
    await database
      .update(table)
      .set({ status: "failed", lastError: outcome.error, failedAt: outcome.now })
      .where(and(eq(table.idempotencyKey, idempotencyKey), eq(table.status, "sending")));
  };

  const find = async (idempotencyKey: string) => {
    const [row] = await database
      .select()
      .from(table)
      .where(eq(table.idempotencyKey, idempotencyKey));
    return row ? toRecord(row) : undefined;
  };

  const list = async (query: MailLedgerQuery) => {
    const conditions = [
      query.recipient !== undefined
        ? sql`${table.recipients} @> ${JSON.stringify([query.recipient])}::jsonb`
        : undefined,
      query.mailerId !== undefined ? eq(table.mailerId, query.mailerId) : undefined,
      query.message !== undefined ? eq(table.message, query.message) : undefined,
      query.tenantId !== undefined ? eq(table.tenantId, query.tenantId) : undefined,
    ].filter((condition) => condition !== undefined);
    const rows = await database
      .select()
      .from(table)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(table.createdAt), desc(table.idempotencyKey))
      .limit(query.limit);
    return Object.freeze(rows.map(toRecord));
  };

  const cleanup = async (options: { readonly before: Date }) => {
    const deleted = await database
      .delete(table)
      .where(and(inArray(table.status, ["sent", "failed"]), lt(table.createdAt, options.before)))
      .returning({ idempotencyKey: table.idempotencyKey });
    return Object.freeze({ deleted: deleted.length });
  };

  return Object.freeze({
    kind: "ship.mail-ledger" as const,
    adapter: "drizzle" as const,
    table,
    claim,
    markSent,
    markFailed,
    find,
    list,
    cleanup,
  });
}

function toRecord(row: Row): MailSendRecord {
  return Object.freeze({
    idempotencyKey: row.idempotencyKey,
    mailerId: row.mailerId,
    message: row.message,
    to: Object.freeze([...row.recipients]),
    deliveredTo: Object.freeze([...row.deliveredTo]),
    intercepted: row.intercepted,
    subject: row.subject,
    status: row.status as MailSendStatus,
    attempts: row.attempts,
    provider: row.provider,
    ...(row.providerMessageId !== null ? { providerMessageId: row.providerMessageId } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt } : {}),
  });
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleMailLedgerDefinition<Record<string, unknown>> {
  if (typeof definition !== "object" || definition === null) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_MAIL_LEDGER_INVALID",
      "mail ledger definition must be an object",
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_MAIL_LEDGER_INVALID",
      "mail ledger definition must provide a Drizzle database",
      { field: "database" },
    );
  }
  const table = Reflect.get(definition, "table");
  if (table !== undefined && (typeof table !== "object" || table === null)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_MAIL_LEDGER_INVALID",
      "mail sends table must be created with shipMailSendsTable()",
      { field: "table" },
    );
  }
}
