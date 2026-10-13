/**
 * Real-Postgres integration test for the oauth module:
 * `oauth_connections` table + `OAuthConnectionService`.
 *
 * V4_STATUS G3 slice 2. Builds on the harness from slice 1
 * (`accounts.integration.test.ts`) but adds the oauth schema
 * to the composed test schema, so the FK from
 * `oauth_connections.account_id → accounts.id` resolves at the
 * SQL layer.
 *
 * What this catches that fake-DB tests cannot:
 *   - `upsertTokens` actually does the right thing on the unique
 *     `(account_id, provider_code)` composite — first call inserts,
 *     subsequent calls UPDATE that exact row
 *   - The unique composite actually enforces — independent
 *     verification that a duplicate insert (without onConflict)
 *     fires SQLSTATE 23505
 *   - FK cascade: deleting the owning account drops dependent
 *     oauth_connections (the schema declares `onDelete: "cascade"`)
 *   - `clearTokens` preserves the row, leaving provider_account_id
 *     intact for re-link
 */

import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accounts, accountsSchema } from "../accounts/schema.js";
import { oauthConnections, oauthConnectionsRelations } from "./schema.js";
import { OAuthConnectionService } from "./services/OAuthConnectionService.js";

const oauthSchema = {
  ...accountsSchema,
  oauthConnections,
  oauthConnectionsRelations,
} as const;

describe("oauth integration (real Postgres)", () => {
  let dbCtx: PostgresTestDb<typeof oauthSchema>;
  let service: OAuthConnectionService;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    dbCtx = await setupPostgresTestDb(oauthSchema);
    service = new OAuthConnectionService(
      dbCtx.db as unknown as ConstructorParameters<typeof OAuthConnectionService>[0],
    );
  }, 60_000);

  afterAll(async () => {
    if (dbCtx) await dbCtx.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(dbCtx);
    // Seed two account rows; oauth_connections.account_id FK requires
    // them to exist before we can insert any oauth row.
    const [alice] = await dbCtx.db
      .insert(accounts)
      .values({ email: "alice@example.test" })
      .returning();
    const [bob] = await dbCtx.db.insert(accounts).values({ email: "bob@example.test" }).returning();
    aliceId = alice.id;
    bobId = bob.id;
  });

  // ─── upsertTokens — the load-bearing UPSERT path ────────────────────

  it("upsertTokens INSERTs on first call (no existing row for the pair)", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const row = await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt,
      scope: "openid email",
      tokenType: "Bearer",
      providerAccountId: "g-12345",
      metadata: { id_token: "header.payload.sig" },
    });

    expect(row.accountId).toBe(aliceId);
    expect(row.providerCode).toBe("google");
    expect(row.accessToken).toBe("ya29.access");

    const all = await dbCtx.db.select().from(oauthConnections);
    expect(all).toHaveLength(1);
    expect(all[0].providerAccountId).toBe("g-12345");
  });

  it("upsertTokens UPDATEs on second call for the same (accountId, providerCode) pair (re-grant flow)", async () => {
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "first-access",
      refreshToken: "first-refresh",
      providerAccountId: "g-12345",
    });

    const second = await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      providerAccountId: "g-12345",
      metadata: { rotated: true },
    });

    // Still exactly one row (no duplicate on the unique composite).
    const all = await dbCtx.db.select().from(oauthConnections);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(second.id);
    expect(all[0].accessToken).toBe("rotated-access");
    expect(all[0].refreshToken).toBe("rotated-refresh");
    expect(all[0].metadata).toEqual({ rotated: true });
  });

  it("upsertTokens for a DIFFERENT providerCode on the same account creates a separate row", async () => {
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "google-tok",
    });
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "microsoft",
      accessToken: "microsoft-tok",
    });

    const all = await dbCtx.db.select().from(oauthConnections);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.providerCode).sort()).toEqual(["google", "microsoft"]);
  });

  it("upsertTokens for the same providerCode on a DIFFERENT account creates a separate row", async () => {
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "alice-tok",
    });
    await service.upsertTokens({
      accountId: bobId,
      providerCode: "google",
      accessToken: "bob-tok",
    });

    const all = await dbCtx.db.select().from(oauthConnections);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.accessToken).sort()).toEqual(["alice-tok", "bob-tok"]);
  });

  // ─── findByAccountAndProvider ───────────────────────────────────────

  it("findByAccountAndProvider returns the row when present, null when missing", async () => {
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "alice-google",
    });
    await service.upsertTokens({
      accountId: bobId,
      providerCode: "google",
      accessToken: "bob-google",
    });

    const aliceRow = await service.findByAccountAndProvider(aliceId, "google");
    expect(aliceRow).toBeDefined();
    expect(aliceRow!.accessToken).toBe("alice-google");

    const aliceMicrosoft = await service.findByAccountAndProvider(aliceId, "microsoft");
    expect(aliceMicrosoft).toBeNull();
  });

  // ─── clearTokens — disconnect preserves the row ─────────────────────

  it("clearTokens nulls the token columns but preserves the row + providerAccountId", async () => {
    const created = await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: "openid email",
      tokenType: "Bearer",
      providerAccountId: "g-12345",
    });

    await service.clearTokens(created.id);

    const round = await dbCtx.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, created.id));
    expect(round).toHaveLength(1);
    expect(round[0].accessToken).toBeNull();
    expect(round[0].refreshToken).toBeNull();
    expect(round[0].expiresAt).toBeNull();
    expect(round[0].scope).toBeNull();
    expect(round[0].tokenType).toBeNull();
    // providerAccountId is the linkage key — NOT cleared so a re-grant
    // can reconcile against the same provider identity.
    expect(round[0].providerAccountId).toBe("g-12345");
  });

  // ─── FK cascade: deleting the account drops the connection ──────────

  it("FK cascade: hard-deleting the owning account removes its oauth_connections rows", async () => {
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "google",
      accessToken: "alice-google",
    });
    await service.upsertTokens({
      accountId: aliceId,
      providerCode: "microsoft",
      accessToken: "alice-microsoft",
    });
    await service.upsertTokens({
      accountId: bobId,
      providerCode: "google",
      accessToken: "bob-google",
    });

    expect(await dbCtx.db.select().from(oauthConnections)).toHaveLength(3);

    // HARD delete (raw SQL — not the service's soft-delete) so the FK
    // cascade actually fires.
    await dbCtx.db.delete(accounts).where(eq(accounts.id, aliceId));

    const remaining = await dbCtx.db.select().from(oauthConnections);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].accountId).toBe(bobId);
  });

  // ─── Unique composite enforcement (without onConflict) ──────────────

  it("raw INSERT without onConflict rejects duplicate (account_id, provider_code) at SQLSTATE 23505", async () => {
    await dbCtx.db.insert(oauthConnections).values({
      accountId: aliceId,
      providerCode: "google",
      payload: undefined,
    } as never);

    let thrown: { cause?: { code?: string } } | undefined;
    try {
      await dbCtx.db.insert(oauthConnections).values({
        accountId: aliceId,
        providerCode: "google",
      } as never);
    } catch (err) {
      thrown = err as { cause?: { code?: string } };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.cause?.code).toBe("23505");
  });

  // ─── Indexes are actually created ───────────────────────────────────

  it("the three secondary indexes (provider, expires, provider+account) exist on the table", async () => {
    // Query pg_indexes to confirm our schema-declared indexes landed.
    // (drizzle-kit's pushSchema applied them; this verifies the source-
    // of-truth between schema.ts and the live DB.)
    const result = await dbCtx.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
      ["oauth_connections"],
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "oauth_conn_account_provider_unique",
        "oauth_conn_provider_ix",
        "oauth_conn_expires_ix",
        "oauth_conn_provider_account_ix",
      ]),
    );
  });
});
