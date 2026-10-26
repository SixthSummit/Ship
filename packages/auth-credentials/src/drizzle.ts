import { and, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
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
import { InvalidCredentialAuthDefinitionError } from "./errors.js";
import type {
  AuthAccount,
  AuthAccountPatch,
  AuthAuditEvent,
  AuthAuditQuery,
  AuthMfaSecret,
  AuthSession,
  AuthSessionMfaState,
  AuthToken,
  AuthTokenPurpose,
  CreateAccountResult,
  CredentialStore,
} from "./store.js";
import { normalizeEmail } from "./store.js";

const PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * The seven tables the package owns, created from schema source and applied
 * by the application's gated migration step (`drizzle-kit generate`, never at
 * boot). Spread the result into the application schema:
 * `export const { authAccounts, ... } = shipAuthTables();`. Columns are only
 * ever added; nothing here stores a password, a token or a TOTP secret in the
 * clear.
 */
export function shipAuthTables(prefix = "ship_auth") {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_STORE_INVALID",
      `auth table prefix must be a lowercase identifier; received ${JSON.stringify(prefix)}`,
      { field: "prefix" },
    );
  }
  const authAccounts = pgTable(
    `${prefix}_accounts`,
    {
      id: uuid("id").defaultRandom().primaryKey(),
      email: text("email").notNull(),
      name: text("name"),
      status: text("status").notNull().default("active"),
      roles: jsonb("roles").notNull().$type<string[]>().default([]),
      emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
      failedAttempts: integer("failed_attempts").notNull().default(0),
      lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
      lockedUntil: timestamp("locked_until", { withTimezone: true }),
      sessionsInvalidBefore: timestamp("sessions_invalid_before", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    },
    (table) => [uniqueIndex(`${prefix}_accounts_email_idx`).on(table.email)],
  );
  const authCredentials = pgTable(`${prefix}_credentials`, {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => authAccounts.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    algorithm: text("algorithm").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  });
  const authTokens = pgTable(
    `${prefix}_tokens`,
    {
      id: uuid("id").defaultRandom().primaryKey(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => authAccounts.id, { onDelete: "cascade" }),
      purpose: text("purpose").notNull(),
      tokenHash: text("token_hash").notNull(),
      payload: jsonb("payload").$type<Record<string, string>>(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      consumedAt: timestamp("consumed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table) => [
      uniqueIndex(`${prefix}_tokens_hash_idx`).on(table.tokenHash),
      index(`${prefix}_tokens_account_idx`).on(table.accountId, table.purpose),
    ],
  );
  const authMfaSecrets = pgTable(`${prefix}_mfa_secrets`, {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => authAccounts.id, { onDelete: "cascade" }),
    secretCiphertext: text("secret_ciphertext").notNull(),
    keyId: text("key_id").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    lastUsedStep: integer("last_used_step"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  });
  const authRecoveryCodes = pgTable(
    `${prefix}_recovery_codes`,
    {
      id: uuid("id").defaultRandom().primaryKey(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => authAccounts.id, { onDelete: "cascade" }),
      codeHash: text("code_hash").notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table) => [index(`${prefix}_recovery_codes_account_idx`).on(table.accountId, table.codeHash)],
  );
  const authSessions = pgTable(
    `${prefix}_sessions`,
    {
      id: uuid("id").defaultRandom().primaryKey(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => authAccounts.id, { onDelete: "cascade" }),
      tokenHash: text("token_hash").notNull(),
      mfaState: text("mfa_state").notNull().default("none"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedReason: text("revoked_reason"),
      ip: text("ip"),
      userAgent: text("user_agent"),
    },
    (table) => [
      uniqueIndex(`${prefix}_sessions_hash_idx`).on(table.tokenHash),
      index(`${prefix}_sessions_account_idx`).on(table.accountId, table.createdAt),
    ],
  );
  // No foreign key: audit rows outlive the account they describe.
  const authAuditEvents = pgTable(
    `${prefix}_audit_events`,
    {
      id: uuid("id").defaultRandom().primaryKey(),
      event: text("event").notNull(),
      outcome: text("outcome").notNull(),
      accountId: uuid("account_id"),
      sessionId: uuid("session_id"),
      requestId: text("request_id").notNull(),
      ip: text("ip"),
      userAgent: text("user_agent"),
      details: jsonb("details").$type<Record<string, string | number | boolean>>(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table) => [
      index(`${prefix}_audit_account_idx`).on(table.accountId, table.createdAt),
      index(`${prefix}_audit_event_idx`).on(table.event, table.createdAt),
    ],
  );
  return {
    authAccounts,
    authCredentials,
    authTokens,
    authMfaSecrets,
    authRecoveryCodes,
    authSessions,
    authAuditEvents,
  };
}

export type ShipAuthTables = ReturnType<typeof shipAuthTables>;

export interface DrizzleCredentialStoreDefinition<TSchema extends Record<string, unknown>> {
  readonly database: NodePgDatabase<TSchema>;
  /** Defaults to `shipAuthTables()`; pass the same instance used in migrations. */
  readonly tables?: ShipAuthTables;
}

export interface DrizzleCredentialStore extends CredentialStore {
  readonly adapter: "drizzle";
  readonly tables: ShipAuthTables;
}

type Database = NodePgDatabase<Record<string, unknown>>;
type AccountRow = ShipAuthTables["authAccounts"]["$inferSelect"];
type TokenRow = ShipAuthTables["authTokens"]["$inferSelect"];
type SecretRow = ShipAuthTables["authMfaSecrets"]["$inferSelect"];
type SessionRow = ShipAuthTables["authSessions"]["$inferSelect"];
type AuditRow = ShipAuthTables["authAuditEvents"]["$inferSelect"];

/**
 * PostgreSQL credential store. Every once-only transition (consuming a token,
 * a recovery code or a TOTP step, revoking a session) is one conditional
 * `UPDATE … RETURNING`, so two concurrent requests holding the same secret
 * cannot both win; account + credential creation is one transaction.
 */
export function createDrizzleCredentialStore<TSchema extends Record<string, unknown>>(
  definition: DrizzleCredentialStoreDefinition<TSchema>,
): DrizzleCredentialStore {
  assertDefinition(definition);
  const tables = definition.tables ?? shipAuthTables();
  const database = definition.database as unknown as Database;
  const {
    authAccounts,
    authCredentials,
    authTokens,
    authMfaSecrets,
    authRecoveryCodes,
    authSessions,
    authAuditEvents,
  } = tables;

  const liveToken = (input: { tokenHash: string; purpose: AuthTokenPurpose; now: Date }) =>
    and(
      eq(authTokens.tokenHash, input.tokenHash),
      eq(authTokens.purpose, input.purpose),
      isNull(authTokens.consumedAt),
      gt(authTokens.expiresAt, input.now),
    );

  const store: DrizzleCredentialStore = {
    kind: "ship.credential-store",
    adapter: "drizzle",
    tables,

    async createAccount(input): Promise<CreateAccountResult> {
      const email = normalizeEmail(input.email);
      try {
        return await database.transaction(async (tx) => {
          const [row] = await tx
            .insert(authAccounts)
            .values({
              email,
              name: input.name ?? null,
              status: "active",
              roles: [...input.roles],
              emailVerifiedAt: input.emailVerifiedAt ?? null,
              failedAttempts: 0,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning();
          if (!row) throw new Error("account insert returned no row");
          await tx.insert(authCredentials).values({
            accountId: row.id,
            passwordHash: input.passwordHash,
            algorithm: input.algorithm,
            updatedAt: input.now,
          });
          return { ok: true as const, account: toAccount(row) };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, reason: "email-taken" };
        throw error;
      }
    },
    async findAccount(id) {
      if (!isUuid(id)) return undefined;
      const [row] = await database.select().from(authAccounts).where(eq(authAccounts.id, id));
      return row ? toAccount(row) : undefined;
    },
    async findAccountByEmail(email) {
      const [row] = await database
        .select()
        .from(authAccounts)
        .where(eq(authAccounts.email, normalizeEmail(email)));
      return row ? toAccount(row) : undefined;
    },
    async updateAccount(id, patch: AuthAccountPatch, now) {
      if (!isUuid(id)) return { ok: false, reason: "not-found" };
      try {
        const [row] = await database
          .update(authAccounts)
          .set({
            ...(patch.email !== undefined ? { email: normalizeEmail(patch.email) } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.roles !== undefined ? { roles: [...patch.roles] } : {}),
            ...(patch.emailVerifiedAt !== undefined
              ? { emailVerifiedAt: patch.emailVerifiedAt }
              : {}),
            ...(patch.failedAttempts !== undefined ? { failedAttempts: patch.failedAttempts } : {}),
            ...(patch.lastFailedAt !== undefined ? { lastFailedAt: patch.lastFailedAt } : {}),
            ...(patch.lockedUntil !== undefined ? { lockedUntil: patch.lockedUntil } : {}),
            ...(patch.sessionsInvalidBefore !== undefined
              ? { sessionsInvalidBefore: patch.sessionsInvalidBefore }
              : {}),
            updatedAt: now,
          })
          .where(eq(authAccounts.id, id))
          .returning();
        return row ? { ok: true, account: toAccount(row) } : { ok: false, reason: "not-found" };
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, reason: "email-taken" };
        throw error;
      }
    },

    async findCredential(accountId) {
      if (!isUuid(accountId)) return undefined;
      const [row] = await database
        .select()
        .from(authCredentials)
        .where(eq(authCredentials.accountId, accountId));
      return row
        ? {
            accountId: row.accountId,
            passwordHash: row.passwordHash,
            algorithm: row.algorithm,
            updatedAt: row.updatedAt,
          }
        : undefined;
    },
    async setCredential(accountId, credential) {
      await database
        .insert(authCredentials)
        .values({
          accountId,
          passwordHash: credential.passwordHash,
          algorithm: credential.algorithm,
          updatedAt: credential.now,
        })
        .onConflictDoUpdate({
          target: authCredentials.accountId,
          set: {
            passwordHash: credential.passwordHash,
            algorithm: credential.algorithm,
            updatedAt: credential.now,
          },
        });
    },

    async createToken(input) {
      const [row] = await database
        .insert(authTokens)
        .values({
          accountId: input.accountId,
          purpose: input.purpose,
          tokenHash: input.tokenHash,
          payload: input.payload ? { ...input.payload } : null,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        })
        .returning();
      if (!row) throw new Error("token insert returned no row");
      return toToken(row);
    },
    async findToken(input) {
      const [row] = await database.select().from(authTokens).where(liveToken(input));
      return row ? toToken(row) : undefined;
    },
    async consumeToken(input) {
      const [row] = await database
        .update(authTokens)
        .set({ consumedAt: input.now })
        .where(liveToken(input))
        .returning();
      return row ? toToken(row) : undefined;
    },
    async revokeTokens(input) {
      const rows = await database
        .update(authTokens)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(authTokens.accountId, input.accountId),
            eq(authTokens.purpose, input.purpose),
            isNull(authTokens.consumedAt),
            gt(authTokens.expiresAt, input.now),
          ),
        )
        .returning({ id: authTokens.id });
      return rows.length;
    },

    async findMfaSecret(accountId) {
      if (!isUuid(accountId)) return undefined;
      const [row] = await database
        .select()
        .from(authMfaSecrets)
        .where(eq(authMfaSecrets.accountId, accountId));
      return row ? toSecret(row) : undefined;
    },
    async upsertMfaSecret(input) {
      const [row] = await database
        .insert(authMfaSecrets)
        .values({
          accountId: input.accountId,
          secretCiphertext: input.secretCiphertext,
          keyId: input.keyId,
          enabledAt: input.enabledAt ?? null,
          lastUsedStep: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: authMfaSecrets.accountId,
          set: {
            secretCiphertext: input.secretCiphertext,
            keyId: input.keyId,
            enabledAt: input.enabledAt ?? null,
            updatedAt: input.now,
          },
        })
        .returning();
      if (!row) throw new Error("mfa secret upsert returned no row");
      return toSecret(row);
    },
    async claimMfaStep(accountId, step, now) {
      if (!isUuid(accountId)) return false;
      const rows = await database
        .update(authMfaSecrets)
        .set({ lastUsedStep: step, updatedAt: now })
        .where(
          and(
            eq(authMfaSecrets.accountId, accountId),
            or(isNull(authMfaSecrets.lastUsedStep), lt(authMfaSecrets.lastUsedStep, step)),
          ),
        )
        .returning({ accountId: authMfaSecrets.accountId });
      return rows.length > 0;
    },
    async deleteMfaSecret(accountId) {
      if (!isUuid(accountId)) return;
      await database.delete(authMfaSecrets).where(eq(authMfaSecrets.accountId, accountId));
    },

    async replaceRecoveryCodes(accountId, codeHashes, now) {
      await database.transaction(async (tx) => {
        await tx.delete(authRecoveryCodes).where(eq(authRecoveryCodes.accountId, accountId));
        if (codeHashes.length > 0) {
          await tx
            .insert(authRecoveryCodes)
            .values(codeHashes.map((codeHash) => ({ accountId, codeHash, createdAt: now })));
        }
      });
    },
    async consumeRecoveryCode(input) {
      if (!isUuid(input.accountId)) return false;
      const rows = await database
        .update(authRecoveryCodes)
        .set({ usedAt: input.now })
        .where(
          and(
            eq(authRecoveryCodes.accountId, input.accountId),
            eq(authRecoveryCodes.codeHash, input.codeHash),
            isNull(authRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: authRecoveryCodes.id });
      return rows.length > 0;
    },
    async countRecoveryCodes(accountId) {
      if (!isUuid(accountId)) return { remaining: 0, used: 0 };
      const [row] = await database
        .select({
          remaining: sql<number>`count(*) filter (where ${authRecoveryCodes.usedAt} is null)::int`,
          used: sql<number>`count(*) filter (where ${authRecoveryCodes.usedAt} is not null)::int`,
        })
        .from(authRecoveryCodes)
        .where(eq(authRecoveryCodes.accountId, accountId));
      return { remaining: row?.remaining ?? 0, used: row?.used ?? 0 };
    },

    async createSession(input) {
      const [row] = await database
        .insert(authSessions)
        .values({
          accountId: input.accountId,
          tokenHash: input.tokenHash,
          mfaState: input.mfaState,
          createdAt: input.now,
          expiresAt: input.expiresAt,
          lastSeenAt: input.now,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        })
        .returning();
      if (!row) throw new Error("session insert returned no row");
      return toSession(row);
    },
    async findSession(id) {
      if (!isUuid(id)) return undefined;
      const [row] = await database.select().from(authSessions).where(eq(authSessions.id, id));
      return row ? toSession(row) : undefined;
    },
    async findSessionByTokenHash(tokenHash) {
      const [row] = await database
        .select()
        .from(authSessions)
        .where(eq(authSessions.tokenHash, tokenHash));
      return row ? toSession(row) : undefined;
    },
    async listSessions(accountId, options = {}) {
      if (!isUuid(accountId)) return Object.freeze([]);
      const rows = await database
        .select()
        .from(authSessions)
        .where(
          options.includeRevoked
            ? eq(authSessions.accountId, accountId)
            : and(eq(authSessions.accountId, accountId), isNull(authSessions.revokedAt)),
        )
        .orderBy(desc(authSessions.createdAt), desc(authSessions.id));
      return Object.freeze(rows.map(toSession));
    },
    async touchSession(id, now) {
      if (!isUuid(id)) return;
      await database.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, id));
    },
    async updateSession(id, patch) {
      if (!isUuid(id)) return undefined;
      const [row] = await database
        .update(authSessions)
        .set({
          ...(patch.mfaState !== undefined ? { mfaState: patch.mfaState } : {}),
          ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        })
        .where(eq(authSessions.id, id))
        .returning();
      return row ? toSession(row) : undefined;
    },
    async revokeSession(id, revocation) {
      if (!isUuid(id)) return false;
      const rows = await database
        .update(authSessions)
        .set({ revokedAt: revocation.now, revokedReason: revocation.reason })
        .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id });
      return rows.length > 0;
    },
    async revokeSessions(accountId, revocation) {
      if (!isUuid(accountId)) return 0;
      const rows = await database
        .update(authSessions)
        .set({ revokedAt: revocation.now, revokedReason: revocation.reason })
        .where(
          and(
            eq(authSessions.accountId, accountId),
            isNull(authSessions.revokedAt),
            ...(revocation.except !== undefined && isUuid(revocation.except)
              ? [ne(authSessions.id, revocation.except)]
              : []),
          ),
        )
        .returning({ id: authSessions.id });
      return rows.length;
    },

    async recordAudit(event) {
      const [row] = await database
        .insert(authAuditEvents)
        .values({
          event: event.event,
          outcome: event.outcome,
          accountId:
            event.accountId !== undefined && isUuid(event.accountId) ? event.accountId : null,
          sessionId:
            event.sessionId !== undefined && isUuid(event.sessionId) ? event.sessionId : null,
          requestId: event.requestId,
          ip: event.ip ?? null,
          userAgent: event.userAgent ?? null,
          details: event.details ? { ...event.details } : null,
          createdAt: event.createdAt,
        })
        .returning();
      if (!row) throw new Error("audit insert returned no row");
      return toAudit(row);
    },
    async listAudit(query: AuthAuditQuery) {
      if (query.accountId !== undefined && !isUuid(query.accountId)) return Object.freeze([]);
      const conditions = [
        query.accountId !== undefined ? eq(authAuditEvents.accountId, query.accountId) : undefined,
        query.event !== undefined ? eq(authAuditEvents.event, query.event) : undefined,
        query.outcome !== undefined ? eq(authAuditEvents.outcome, query.outcome) : undefined,
        query.before !== undefined ? lt(authAuditEvents.createdAt, query.before) : undefined,
      ].filter((condition) => condition !== undefined);
      const rows = await database
        .select()
        .from(authAuditEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(authAuditEvents.createdAt), desc(authAuditEvents.id))
        .limit(query.limit);
      return Object.freeze(rows.map(toAudit));
    },

    async cleanup({ before }) {
      const tokens = await database
        .delete(authTokens)
        .where(
          or(
            lt(authTokens.consumedAt, before),
            and(isNull(authTokens.consumedAt), lt(authTokens.expiresAt, before)),
          ),
        )
        .returning({ id: authTokens.id });
      const sessions = await database
        .delete(authSessions)
        .where(
          or(
            lt(authSessions.revokedAt, before),
            and(isNull(authSessions.revokedAt), lt(authSessions.expiresAt, before)),
          ),
        )
        .returning({ id: authSessions.id });
      return { tokens: tokens.length, sessions: sessions.length };
    },
  };
  return Object.freeze(store);
}

function toAccount(row: AccountRow): AuthAccount {
  return Object.freeze({
    id: row.id,
    email: row.email,
    ...(row.name !== null ? { name: row.name } : {}),
    status: row.status as AuthAccount["status"],
    roles: Object.freeze([...row.roles]),
    ...(row.emailVerifiedAt ? { emailVerifiedAt: row.emailVerifiedAt } : {}),
    failedAttempts: row.failedAttempts,
    ...(row.lastFailedAt ? { lastFailedAt: row.lastFailedAt } : {}),
    ...(row.lockedUntil ? { lockedUntil: row.lockedUntil } : {}),
    ...(row.sessionsInvalidBefore ? { sessionsInvalidBefore: row.sessionsInvalidBefore } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toToken(row: TokenRow): AuthToken {
  return Object.freeze({
    id: row.id,
    accountId: row.accountId,
    purpose: row.purpose as AuthTokenPurpose,
    tokenHash: row.tokenHash,
    ...(row.payload ? { payload: Object.freeze({ ...row.payload }) } : {}),
    expiresAt: row.expiresAt,
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
    createdAt: row.createdAt,
  });
}

function toSecret(row: SecretRow): AuthMfaSecret {
  return Object.freeze({
    accountId: row.accountId,
    secretCiphertext: row.secretCiphertext,
    keyId: row.keyId,
    ...(row.enabledAt ? { enabledAt: row.enabledAt } : {}),
    ...(row.lastUsedStep !== null ? { lastUsedStep: row.lastUsedStep } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toSession(row: SessionRow): AuthSession {
  return Object.freeze({
    id: row.id,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    mfaState: row.mfaState as AuthSessionMfaState,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    ...(row.revokedReason !== null ? { revokedReason: row.revokedReason } : {}),
    ...(row.ip !== null ? { ip: row.ip } : {}),
    ...(row.userAgent !== null ? { userAgent: row.userAgent } : {}),
  });
}

function toAudit(row: AuditRow): AuthAuditEvent {
  return Object.freeze({
    id: row.id,
    event: row.event,
    outcome: row.outcome as AuthAuditEvent["outcome"],
    ...(row.accountId !== null ? { accountId: row.accountId } : {}),
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    requestId: row.requestId,
    ...(row.ip !== null ? { ip: row.ip } : {}),
    ...(row.userAgent !== null ? { userAgent: row.userAgent } : {}),
    ...(row.details ? { details: Object.freeze({ ...row.details }) } : {}),
    createdAt: row.createdAt,
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Lookups by a caller-supplied id must not throw `22P02` on a non-uuid; they answer "not found". */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if (Reflect.get(current, "code") === "23505") return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleCredentialStoreDefinition<Record<string, unknown>> {
  if (typeof definition !== "object" || definition === null) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_STORE_INVALID",
      "credential store definition must be an object",
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_STORE_INVALID",
      "credential store definition must provide a Drizzle database",
      { field: "database" },
    );
  }
  const tables = Reflect.get(definition, "tables");
  if (tables !== undefined && (typeof tables !== "object" || tables === null)) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_STORE_INVALID",
      "credential store tables must be created with shipAuthTables()",
      { field: "tables" },
    );
  }
}
