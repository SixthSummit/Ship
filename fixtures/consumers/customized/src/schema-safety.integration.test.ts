import { resolve } from "node:path";
import {
  assertMigrationsApplied,
  captureSchemaSnapshot,
  checkSchemaSnapshot,
  lintMigrations,
  migrationsStatus,
  PendingMigrationsError,
  readSnapshotFile,
} from "@sixthsummit/ship-schema-lint";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portfolioSchema } from "./schema.js";

const migrationsDir = resolve(import.meta.dirname, "..", "drizzle");
const snapshotPath = resolve(import.meta.dirname, "..", "schema.snapshot.json");
const allowlistPath = resolve(import.meta.dirname, "..", "schema-lint.allowlist.json");

/**
 * Schema safety gates for this consumer: migrations are linted, applied only
 * by the release step, and the committed snapshot must match what they
 * produce. The last test induces a hand edit and proves the check catches it.
 */
describe("schema safety", () => {
  let database: PostgresTestDb<Record<string, never>>;

  beforeAll(async () => {
    database = await setupPostgresTestDb({});
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("lints the committed migrations clean", async () => {
    const result = await lintMigrations({ migrationsDir, allowlistPath });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses to boot with pending migrations and applies them only through the migrator", async () => {
    await expect(assertMigrationsApplied({ client: database.pool, migrationsDir })).rejects.toThrow(
      PendingMigrationsError,
    );
    await migrate(drizzle(database.pool), { migrationsFolder: migrationsDir });
    expect(await migrationsStatus({ client: database.pool, migrationsDir })).toEqual({
      applied: 5,
      pending: [],
    });
  });

  it("matches the committed snapshot after migrating", async () => {
    const result = await checkSchemaSnapshot({ client: database.pool, snapshotPath });
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces the same physical schema from the schema source", async () => {
    // `pushSchema` builds the tables straight from `src/schema.ts`; the
    // committed migrations must produce the identical catalog.
    const pushed = await setupPostgresTestDb(portfolioSchema);
    try {
      expect(await captureSchemaSnapshot(pushed.pool)).toEqual(
        await readSnapshotFile(snapshotPath),
      );
    } finally {
      await pushed.cleanup();
    }
  });

  it("catches an induced hand edit that bypassed the migrations", async () => {
    await database.pool.query(`ALTER TABLE "work_items" ADD COLUMN "hand_edited" text`);
    await database.pool.query(`ALTER TABLE "projects" ALTER COLUMN "name" DROP NOT NULL`);
    try {
      const result = await checkSchemaSnapshot({ client: database.pool, snapshotPath });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(
        result.differences.map((difference) => `${difference.kind} ${difference.path}`),
      ).toEqual([
        "changed table public.projects.column name.nullable",
        "added table public.work_items.column hand_edited",
      ]);
    } finally {
      await database.pool.query(`ALTER TABLE "work_items" DROP COLUMN "hand_edited"`);
      await database.pool.query(`ALTER TABLE "projects" ALTER COLUMN "name" SET NOT NULL`);
    }
    expect(await checkSchemaSnapshot({ client: database.pool, snapshotPath })).toMatchObject({
      ok: true,
    });
  });
});
