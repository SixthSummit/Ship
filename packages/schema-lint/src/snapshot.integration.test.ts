import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMigrationsApplied, migrationsStatus, PendingMigrationsError } from "./boot-guard.js";
import { lintMigrations } from "./lint.js";
import { RELEASE_STEP_ENV, runRelease } from "./release.js";
import { captureSchemaSnapshot, checkSchemaSnapshot, writeSchemaSnapshot } from "./snapshot.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(packageDir, "src", "__fixtures__", "migrations", "safe");

describe("schema snapshot against PostgreSQL", () => {
  let database: PostgresTestDb<Record<string, never>>;
  let snapshotPath: string;

  beforeAll(async () => {
    database = await setupPostgresTestDb({});
    snapshotPath = resolve(
      await mkdtemp(resolve(tmpdir(), "ship-schema-lint-pg-")),
      "schema.snapshot.json",
    );
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("reports every migration pending before the release step and none after", async () => {
    await expect(assertMigrationsApplied({ client: database.pool, migrationsDir })).rejects.toThrow(
      PendingMigrationsError,
    );
    expect(await lintMigrations({ migrationsDir })).toMatchObject({ ok: true });

    await migrate(drizzle(database.pool), { migrationsFolder: migrationsDir });

    expect(await migrationsStatus({ client: database.pool, migrationsDir })).toEqual({
      applied: 2,
      pending: [],
    });
  });

  it("captures the physical schema the migrations produced", async () => {
    const snapshot = await writeSchemaSnapshot({ client: database.pool, snapshotPath });
    expect(snapshot.tables.map((table) => table.name)).toEqual([
      "customers",
      "orders",
      "shipments",
    ]);
    const orders = snapshot.tables.find((table) => table.name === "orders");
    expect(orders?.columns.find((column) => column.name === "currency")).toEqual({
      name: "currency",
      type: "text",
      nullable: false,
      default: "'USD'::text",
    });
    expect(orders?.constraints.map((constraint) => constraint.name)).toContain(
      "orders_customer_id_customers_id_fk",
    );
    expect(
      snapshot.tables
        .find((table) => table.name === "shipments")
        ?.indexes.map((index) => index.name),
    ).toEqual(["shipments_order_id_idx", "shipments_pkey"]);
    expect(await checkSchemaSnapshot({ client: database.pool, snapshotPath })).toMatchObject({
      ok: true,
      differences: [],
    });
  });

  it("catches a hand edit to the database that bypassed migrations", async () => {
    await database.pool.query(`ALTER TABLE "orders" ADD COLUMN "hand_edited" text`);
    await database.pool.query(`ALTER TABLE "customers" ALTER COLUMN "display_name" SET NOT NULL`);
    await database.pool.query(`DROP INDEX "shipments_order_id_idx"`);

    const result = await checkSchemaSnapshot({ client: database.pool, snapshotPath });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.differences.map((difference) => `${difference.kind} ${difference.path}`)).toEqual(
      [
        "changed table public.customers.column display_name.nullable",
        "added table public.orders.column hand_edited",
        "removed table public.shipments.index shipments_order_id_idx",
      ],
    );
  });

  it("catches a hand edit to a migration file through the release step", async () => {
    // Revert the hand edits so the only drift is the edited migration file.
    await database.pool.query(`ALTER TABLE "orders" DROP COLUMN "hand_edited"`);
    await database.pool.query(`ALTER TABLE "customers" ALTER COLUMN "display_name" DROP NOT NULL`);
    await database.pool.query(
      `CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id")`,
    );
    expect(await checkSchemaSnapshot({ client: database.pool, snapshotPath })).toMatchObject({
      ok: true,
    });

    // A second database receives an edited copy of the last migration, as a
    // hand edit after the snapshot was committed would.
    const edited = await setupPostgresTestDb({});
    try {
      const editedDir = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-edited-"));
      await cp(migrationsDir, editedDir, { recursive: true });
      await writeFile(
        resolve(editedDir, "0001_add_currency.sql"),
        `ALTER TABLE "orders" ADD COLUMN "currency" text DEFAULT 'EUR' NOT NULL;\n--> statement-breakpoint\nCREATE TABLE "shipments" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "order_id" uuid NOT NULL, "carrier" text NOT NULL);\n--> statement-breakpoint\nCREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id");\n`,
        "utf8",
      );
      // The script lives under the package's node_modules so it resolves
      // drizzle-orm and pg from the workspace, unlike a tmpdir script.
      const scriptDir = resolve(packageDir, "node_modules", ".cache", "ship-schema-lint-test");
      await mkdir(scriptDir, { recursive: true });
      const script = resolve(scriptDir, "migrate.mjs");
      await writeFile(
        script,
        [
          `import { drizzle } from "drizzle-orm/node-postgres";`,
          `import { migrate } from "drizzle-orm/node-postgres/migrator";`,
          `import pg from "pg";`,
          `const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });`,
          `await migrate(drizzle(pool), { migrationsFolder: ${JSON.stringify(editedDir)} });`,
          `await pool.end();`,
        ].join("\n"),
        "utf8",
      );
      const result = await runRelease({
        cwd: packageDir,
        env: { ...process.env, [RELEASE_STEP_ENV]: "1" },
        migrationsDir: editedDir,
        databaseUrl: edited.connectionString,
        migrateCommand: `${process.execPath} ${script}`,
        snapshotPath,
        write: () => undefined,
      });
      expect(result.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
        "guard:passed",
        "lint:passed",
        "migrate:passed",
        "snapshot:failed",
      ]);
      expect(result.snapshot?.differences).toEqual([
        {
          kind: "changed",
          path: "table public.orders.column currency.default",
          expected: "'USD'::text",
          actual: "'EUR'::text",
        },
      ]);
      expect(await captureSchemaSnapshot(edited.pool)).not.toEqual(
        await captureSchemaSnapshot(database.pool),
      );
    } finally {
      await edited.cleanup();
    }
  });
});
