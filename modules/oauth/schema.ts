import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";
import { relations } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accounts } from "../accounts/schema.js";

/**
 * v4 OAuth connection table — ports v3's `OAuthConnection` TypeORM entity.
 *
 * One row per (account, provider) pair: an account that has OAuth-linked
 * Google + Microsoft has two rows. The unique composite on
 * `(account_id, provider_code)` enforces this; the codemod surfaced the
 * @Unique decorator as a TODO and we restore it here.
 *
 * Token storage is intentionally plain text columns (Postgres at-rest
 * encryption is the deployment-level concern). Refresh tokens live in
 * the same row as the access token; rotation overwrites in place
 * (no token-history trail — when the upstream provider rotates the
 * refresh token, the old one is gone).
 *
 * The `metadata` jsonb column carries provider-specific extras
 * (Google `id_token`, Microsoft `tenant_id`, …) that don't fit a
 * cross-provider schema. Adapters own the contract.
 */
export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),

    /** Stable provider identifier (e.g. "google", "microsoft", "gmail"). */
    providerCode: varchar("provider_code", { length: 50 }).notNull(),

    /** Bearer-style access token. Plaintext in DB; rely on at-rest encryption. */
    accessToken: text("access_token"),

    /** Long-lived refresh token. Rotated in place on refresh. */
    refreshToken: text("refresh_token"),

    /** Access-token expiry. Null when the provider doesn't issue one. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /** Granted OAuth scopes (space-separated, as the provider returned). */
    scope: text("scope"),

    /** Token type — typically "Bearer". */
    tokenType: varchar("token_type", { length: 50 }),

    /** Stable identifier for the user *at the upstream provider*. */
    providerAccountId: varchar("provider_account_id", { length: 255 }),

    /** Provider-specific extras the cross-provider schema doesn't model. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    ...baseFields,
  },
  (table) => [
    uniqueIndex("oauth_conn_account_provider_unique").on(table.accountId, table.providerCode),
    index("oauth_conn_provider_ix").on(table.providerCode),
    index("oauth_conn_expires_ix").on(table.expiresAt),
    index("oauth_conn_provider_account_ix").on(table.providerCode, table.providerAccountId),
  ],
);

export const oauthConnectionsRelations = relations(oauthConnections, ({ one }) => ({
  account: one(accounts, {
    fields: [oauthConnections.accountId],
    references: [accounts.id],
  }),
}));

export type OAuthConnection = typeof oauthConnections.$inferSelect;
export type NewOAuthConnection = typeof oauthConnections.$inferInsert;

// ─── Token-status helpers ──────────────────────────────────────────────
//
// v3 had these as instance methods on the TypeORM entity class. v4 rows
// are plain objects ($inferSelect produces a structural type, not a
// class), so the helpers move to module-level functions. Same semantics,
// no `this` — the service / adapter layer calls them on the row.

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** True when the access token has expired (or expires-at is in the past). */
export function isExpired(conn: Pick<OAuthConnection, "expiresAt">): boolean {
  if (!conn.expiresAt) return false;
  return Date.now() >= conn.expiresAt.getTime();
}

/** True when the access token expires within the next 5 minutes. */
export function isExpiringSoon(conn: Pick<OAuthConnection, "expiresAt">): boolean {
  if (!conn.expiresAt) return false;
  return conn.expiresAt.getTime() - Date.now() <= FIVE_MINUTES_MS;
}

/** True when the connection has both an access token and isn't expired. */
export function isActive(conn: Pick<OAuthConnection, "accessToken" | "expiresAt">): boolean {
  return Boolean(conn.accessToken) && !isExpired(conn);
}

/** True when refreshing the token is needed (expired or expiring soon). */
export function needsRefresh(conn: Pick<OAuthConnection, "expiresAt">): boolean {
  return isExpired(conn) || isExpiringSoon(conn);
}

/**
 * Build the `Authorization: <type> <token>` header value for upstream
 * provider API calls. Returns null when there's no access token to send.
 */
export function authorizationHeader(
  conn: Pick<OAuthConnection, "accessToken" | "tokenType">,
): string | null {
  if (!conn.accessToken) return null;
  const type = conn.tokenType ?? "Bearer";
  return `${type} ${conn.accessToken}`;
}
