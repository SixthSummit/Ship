import { DrizzleEntityService } from "@sixthsummit/ship-api/app/services/DrizzleEntityService";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- conditional provider/account lookups + upsert; candidate for a QueryOptions refactor
import { and, eq } from "drizzle-orm";
import {
  authorizationHeader,
  isActive,
  isExpired,
  isExpiringSoon,
  needsRefresh,
  type OAuthConnection,
  oauthConnections,
} from "../schema.js";

/**
 * v4 `OAuthConnectionService` — extends `DrizzleEntityService` for
 * CRUD on the oauth_connections table, plus connection-management
 * helpers that v3 spread across `OAuthService.ts`.
 *
 * Inherits get / getAll / list / count / create / update / delete
 * (with soft-delete + audit-column auto-stamping) from the base. Adds:
 *
 *   - findByAccountAndProvider(accountId, providerCode)
 *   - upsertTokens(...) — atomic insert-or-update on the unique
 *     (accountId, providerCode) composite, used by adapter callbacks
 *   - clearTokens(id) — disconnect: nulls out access/refresh/expires
 *     without deleting the row (preserves provider linkage history)
 *   - status helpers re-exposed: isExpired / isExpiringSoon /
 *     isActive / needsRefresh / authorizationHeader (delegate to the
 *     module-level pure functions in schema.ts)
 *
 * Token rotation flows in via `upsertTokens` from adapter callbacks
 * (`oauth/{provider}/callback`); refresh flows in via the same path
 * from a worker that polls `expiresAt` indexes for soon-to-expire
 * tokens.
 */
export class OAuthConnectionService extends DrizzleEntityService<
  typeof oauthConnections,
  { oauthConnections: typeof oauthConnections }
> {
  protected getTable() {
    return oauthConnections;
  }

  protected override getDefaultSearchFields(): readonly string[] {
    return ["providerCode", "providerAccountId"];
  }

  protected override getDefaultRelations(): readonly string[] {
    return ["account"];
  }

  /**
   * Look up the row keyed by (accountId, providerCode). Returns `null`
   * when the account hasn't connected the provider.
   */
  async findByAccountAndProvider(
    accountId: string,
    providerCode: string,
  ): Promise<OAuthConnection | null> {
    const rows = await this.db
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.accountId, accountId),
          eq(oauthConnections.providerCode, providerCode),
        ),
      )
      .limit(1);
    return (rows[0] as OAuthConnection | undefined) ?? null;
  }

  /**
   * Upsert pattern keyed on the unique (accountId, providerCode)
   * composite — used by adapter callback handlers when a user grants
   * access (insert) or re-grants (update). Drizzle's `onConflictDoUpdate`
   * matches the unique index and updates the same fields on conflict.
   */
  async upsertTokens(values: {
    accountId: string;
    providerCode: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: Date;
    scope?: string;
    tokenType?: string;
    providerAccountId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<OAuthConnection> {
    const insertValues = {
      accountId: values.accountId,
      providerCode: values.providerCode,
      accessToken: values.accessToken ?? null,
      refreshToken: values.refreshToken ?? null,
      expiresAt: values.expiresAt ?? null,
      scope: values.scope ?? null,
      tokenType: values.tokenType ?? null,
      providerAccountId: values.providerAccountId ?? null,
      metadata: values.metadata ?? {},
    };
    const [row] = await this.db
      .insert(oauthConnections)
      .values(insertValues as never)
      .onConflictDoUpdate({
        target: [oauthConnections.accountId, oauthConnections.providerCode],
        set: {
          accessToken: insertValues.accessToken,
          refreshToken: insertValues.refreshToken,
          expiresAt: insertValues.expiresAt,
          scope: insertValues.scope,
          tokenType: insertValues.tokenType,
          providerAccountId: insertValues.providerAccountId,
          metadata: insertValues.metadata,
        } as never,
      })
      .returning();
    return row as OAuthConnection;
  }

  /**
   * Clear tokens (disconnect) without deleting the row — preserves the
   * provider-account-ID linkage so a later reconnect doesn't create a
   * stale duplicate.
   */
  async clearTokens(id: string): Promise<OAuthConnection | null> {
    const [row] = await this.db
      .update(oauthConnections)
      .set({
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        tokenType: null,
      } as never)
      .where(eq(oauthConnections.id, id))
      .returning();
    return (row as OAuthConnection | undefined) ?? null;
  }

  // Re-export the module-level status helpers so callers don't have to
  // import them separately when they already hold a service reference.
  isExpired = isExpired;
  isExpiringSoon = isExpiringSoon;
  isActive = isActive;
  needsRefresh = needsRefresh;
  authorizationHeader = authorizationHeader;
}
