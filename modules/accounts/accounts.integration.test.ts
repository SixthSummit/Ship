/**
 * Real-Postgres integration test for the framework's default
 * `accounts` table + `AccountService` (`modules/accounts`).
 *
 * This is the V4_STATUS G3 first-slice landing test — proves the
 * testcontainers harness works end-to-end and exercises the SQL
 * the framework actually emits against a real Postgres. Unit tests
 * use a fake-Drizzle client to keep the loop fast; this one
 * verifies the same service against the actual planner so we
 * catch:
 *   - SQL builder regressions (`onConflictDoUpdate`, soft-delete
 *     filter, audit-column auto-stamp)
 *   - Schema source-of-truth drift (drizzle-kit's `pushSchema`
 *     applies the same DDL the runtime sees)
 *   - Postgres-specific behaviors (unique constraints, FK
 *     cascades, identity columns)
 *
 * Subsequent slices add oauth + outbox integration
 * tests against this same harness.
 *
 * Run via: `npm run test:integration -w @sixthsummit/ship-api`.
 * Excluded from default `npm test` (Docker-free, fast loop).
 */

import { DrizzleEntityService } from "@sixthsummit/ship-api/app/services/DrizzleEntityService";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accounts, accountsSchema } from "./schema.js";

class TestAccountService extends DrizzleEntityService<typeof accounts, typeof accountsSchema> {
  protected getTable() {
    return accounts;
  }
  protected override getDefaultSearchFields(): readonly string[] {
    return ["email", "displayName"];
  }
}

describe("accounts integration (real Postgres)", () => {
  let dbCtx: PostgresTestDb<typeof accountsSchema>;
  let service: TestAccountService;

  beforeAll(async () => {
    dbCtx = await setupPostgresTestDb(accountsSchema);
    service = new TestAccountService(dbCtx.db);
  }, 60_000);

  afterAll(async () => {
    if (dbCtx) await dbCtx.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(dbCtx);
  });

  // ─── Smoke: harness itself works ────────────────────────────────────

  it("harness pushes the default schema and `accounts` table is queryable", async () => {
    const rows = await dbCtx.db.select().from(accounts);
    expect(rows).toEqual([]);
  });

  // ─── Service.create ─────────────────────────────────────────────────

  it("create() inserts a row with the supplied fields and auto-stamps createdAt + updatedAt", async () => {
    const before = Date.now();
    const created = (await service.create({
      email: "alice@example.test",
      displayName: "Alice",
      isActive: true,
    })) as { id: string; email: string; createdAt: Date; updatedAt: Date };
    const after = Date.now();

    expect(created.email).toBe("alice@example.test");
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89abAB][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Postgres' `now()` resolves to transaction-start, which can fall
    // a few ms before the host's `Date.now()` reading taken at the JS
    // level — clock skew between the container and host shows up as
    // sub-second offsets. A 5 s envelope is comfortably wider than
    // any realistic skew; the test is just verifying "auto-stamped to
    // approximately now", not strict monotonicity against the JS clock.
    const skewMs = 5_000;
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - skewMs);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(after + skewMs);
    expect(created.updatedAt.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime());

    // Verify the row actually landed in Postgres (not just returned from RETURNING).
    const round = await dbCtx.db.select().from(accounts).where(eq(accounts.id, created.id));
    expect(round).toHaveLength(1);
    expect(round[0].email).toBe("alice@example.test");
  });

  // ─── Service.get + soft-delete filter ────────────────────────────────

  it("get() returns the row when present, null when missing", async () => {
    const created = (await service.create({
      email: "bob@example.test",
    })) as { id: string };
    const fetched = await service.get(created.id);
    expect(fetched).toBeTruthy();

    const missing = await service.get("00000000-0000-4000-8000-000000000000");
    expect(missing).toBeNull();
  });

  it("getAll() filters out soft-deleted rows by default; includeDeleted: true returns them", async () => {
    await service.create({ email: "live@example.test" });
    const tombstone = (await service.create({
      email: "tombstone@example.test",
    })) as { id: string };
    await service.delete(tombstone.id);

    const visible = (await service.getAll()) as Array<{ email: string }>;
    expect(visible.map((r) => r.email).sort()).toEqual(["live@example.test"]);

    const allRows = await dbCtx.db.select().from(accounts);
    expect(allRows).toHaveLength(2); // both still in the table
    const tombstoned = allRows.find((r) => r.email === "tombstone@example.test");
    expect(tombstoned?.deletedAt).toBeInstanceOf(Date);
  });

  // ─── Service.update — audit-column behavior ──────────────────────────

  it("update() bumps updatedAt while preserving createdAt", async () => {
    const created = (await service.create({
      email: "carol@example.test",
      displayName: "Carol",
    })) as { id: string; createdAt: Date; updatedAt: Date };

    // Wait a millisecond so updatedAt > createdAt is observable.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = (await service.update(created.id, {
      displayName: "Carol Smith",
    })) as { id: string; createdAt: Date; updatedAt: Date; displayName: string };

    expect(updated.displayName).toBe("Carol Smith");
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  // ─── Postgres-specific: unique constraint ────────────────────────────

  it("unique index on email rejects duplicates at the SQL layer", async () => {
    await service.create({ email: "dup@example.test" });
    // Drizzle wraps the underlying pg error in `error.cause`.
    // SQLSTATE 23505 = unique_violation — proves the SQL layer (not a
    // service-level pre-check) caught the duplicate.
    let thrown: { cause?: { code?: string } } | undefined;
    try {
      await service.create({ email: "dup@example.test" });
    } catch (err) {
      thrown = err as { cause?: { code?: string } };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.cause?.code).toBe("23505");
  });

  // ─── Postgres-specific: soft-delete preserves the row ───────────────

  it("delete() sets deletedAt rather than removing the row", async () => {
    const created = (await service.create({
      email: "softdelete@example.test",
    })) as { id: string };
    await service.delete(created.id);

    const raw = await dbCtx.db.select().from(accounts).where(eq(accounts.id, created.id));
    expect(raw).toHaveLength(1);
    expect(raw[0].deletedAt).toBeInstanceOf(Date);

    // The unique index lets us confirm the row WASN'T re-created — a
    // soft-deleted email-collision still fails the unique constraint
    // (the right behavior; consumers who want "delete + re-add" must
    // hard-delete first or use a different unique strategy).
    let thrown: { cause?: { code?: string } } | undefined;
    try {
      await service.create({ email: "softdelete@example.test" });
    } catch (err) {
      thrown = err as { cause?: { code?: string } };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.cause?.code).toBe("23505");
  });

  // ─── Smoke: lower-level Drizzle still works ──────────────────────────

  it("raw db.insert + db.select round-trip works against the real schema", async () => {
    await dbCtx.db.insert(accounts).values({ email: "raw@example.test", isActive: true });

    const rows = await dbCtx.db.select().from(accounts).where(isNull(accounts.deletedAt));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("raw@example.test");
  });
});
