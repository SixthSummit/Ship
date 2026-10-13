import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";
import { tenantScoped } from "@sixthsummit/ship-api/app/db/tenantScoped";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { eq } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenants } from "./schema.js";

/**
 * Real-Postgres integration test for the A2-1 tenancy primitive.
 *
 * The unit test (`tenantScoped.test.ts`) pins the column-builder shape; this
 * proves the shape actually ENFORCES at the SQL level: `tenantScoped(tenants)`
 * produces a non-null `tenant_id` uuid FK to `tenants.id` with
 * `onDelete: "restrict"`. Uses the module's real `tenants` table plus a demo
 * tenant-scoped domain table (a multi-tenant product would own the latter).
 */

const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  ...tenantScoped(tenants),
  ...baseFields,
});

const tenancySchema = { tenants, projects } as const;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("tenancy primitive (real Postgres)", () => {
  let dbCtx: PostgresTestDb<typeof tenancySchema>;

  beforeAll(async () => {
    dbCtx = await setupPostgresTestDb(tenancySchema);
  }, 60_000);

  afterAll(async () => {
    if (dbCtx) await dbCtx.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(dbCtx);
  });

  async function seedTenant(id = TENANT_A) {
    await dbCtx.pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [
      id,
      `t-${id.slice(0, 8)}`,
      "Acme",
    ]);
    return id;
  }

  it("accepts a scoped row whose tenant_id references an existing tenant", async () => {
    await seedTenant();
    await dbCtx.db.insert(projects).values({ name: "P1", tenantId: TENANT_A });

    const rows = await dbCtx.db.select().from(projects);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(TENANT_A);
  });

  it("rejects a scoped row whose tenant_id has no matching tenant (FK)", async () => {
    let thrown: unknown;
    try {
      await dbCtx.pool.query(`INSERT INTO projects (name, tenant_id) VALUES ($1, $2)`, [
        "orphan",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ]);
    } catch (err) {
      thrown = err;
    }
    // 23503 = foreign_key_violation
    expect((thrown as { code?: string } | undefined)?.code).toBe("23503");
  });

  it("rejects a scoped row with a null tenant_id (NOT NULL)", async () => {
    let thrown: unknown;
    try {
      await dbCtx.pool.query(`INSERT INTO projects (name, tenant_id) VALUES ($1, NULL)`, ["n"]);
    } catch (err) {
      thrown = err;
    }
    // 23502 = not_null_violation
    expect((thrown as { code?: string } | undefined)?.code).toBe("23502");
  });

  it("blocks deleting a tenant that still has scoped rows (onDelete: restrict)", async () => {
    await seedTenant();
    await dbCtx.db.insert(projects).values({ name: "P1", tenantId: TENANT_A });

    let thrown: unknown;
    try {
      await dbCtx.pool.query(`DELETE FROM tenants WHERE id = $1`, [TENANT_A]);
    } catch (err) {
      thrown = err;
    }
    // 23503 = foreign_key_violation (restrict)
    expect((thrown as { code?: string } | undefined)?.code).toBe("23503");

    // Once the scoped rows are gone, the tenant can be deleted.
    await dbCtx.db.delete(projects).where(eq(projects.tenantId, TENANT_A));
    await dbCtx.pool.query(`DELETE FROM tenants WHERE id = $1`, [TENANT_A]);
    expect(await dbCtx.db.select().from(tenants)).toHaveLength(0);
  });
});
