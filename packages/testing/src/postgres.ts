import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { pushSchema } from "drizzle-kit/api";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

/**
 * Real-Postgres test harness — spins up an ephemeral Postgres
 * container, builds a Drizzle client against it, and pushes the
 * supplied Drizzle schema so the tables exist before tests run.
 *
 * Why testcontainers: the per-module unit tests (accounts /
 * oauth / outbox) drive `DrizzleEntityService` against
 * a fake Drizzle-shaped DB so the test loop is fast and Docker-
 * free. Integration tests under `*.integration.test.ts` exercise
 * the SAME services against a real Postgres so the SQL the
 * framework actually emits — partial indexes, FK cascades,
 * `onConflictDoUpdate`, transactional outbox semantics — gets
 * verified end-to-end. Different surface; both matter.
 *
 * This harness is the foundation for V4_STATUS G3. First
 * integration test ships in this commit; oauth + outbox
 * integration tests layer on in subsequent slices.
 *
 * Usage (suite-scoped, one container per describe block):
 *
 *   import { describe, beforeAll, afterAll, it, expect } from "vitest";
 *   import { setupPostgresTestDb, type PostgresTestDb }
 *     from "@sixthsummit/ship-testing/postgres";
 *   import { accountsSchema } from "../../../../../../modules/accounts/index.js";
 *
 *   describe("accounts integration", () => {
 *     let dbCtx: PostgresTestDb<typeof accountsSchema>;
 *     beforeAll(async () => {
 *       dbCtx = await setupPostgresTestDb(accountsSchema);
 *     }, 60_000);
 *     afterAll(async () => { await dbCtx.cleanup(); });
 *
 *     it("inserts and reads", async () => {
 *       // dbCtx.db is a fully typed NodePgDatabase<typeof schema>.
 *     });
 *   });
 *
 * The container starts in ~3–10 s on a warm Docker daemon. Tests
 * SHOULD share a container per describe block (suite-scoped
 * lifecycle); per-test container overhead would dominate runtime.
 * Per-test isolation comes from `truncateAll(dbCtx)` between
 * tests, not from a fresh container.
 *
 * NOT included by the default `pnpm test` run — the root Vitest
 * config excludes `*.integration.test.ts`. Run via
 * `pnpm run test:integration`.
 */

export interface PostgresTestDb<TSchema extends Record<string, unknown>> {
  /** Started Postgres container (testcontainers handle). */
  container: StartedPostgreSqlContainer;
  /** Underlying pg.Pool. Surface for raw queries when Drizzle's API doesn't fit. */
  pool: pg.Pool;
  /** Fully-typed Drizzle client over the supplied schema. */
  db: NodePgDatabase<TSchema>;
  /** The connection string; useful when spawning subprocesses. */
  connectionString: string;
  /** Tear down the container + close the pool. Idempotent. */
  cleanup: () => Promise<void>;
}

/**
 * Bring up a Postgres container, build a Drizzle client, and push
 * the supplied schema so the tables exist. Returns the test-db
 * context plus a cleanup hook.
 *
 * The schema arg is a `Record<string, unknown>` matching the shape
 * of `import * as schema from "..."` — drizzle-kit's `pushSchema`
 * walks the imports and creates every `pgTable` it finds, plus
 * any `pgEnum`s, indexes, and foreign keys.
 */
/**
 * A `pg.Pool` for a test against the disposable container. Attaches the
 * pool-level `error` listener that `pg` requires: when the container stops
 * while an idle client is still connected, the server sends
 * `57P01 terminating connection due to administrator command`, and without
 * a listener that arrives as an uncaught exception after the suite has
 * already passed. Tests that build their own pools should use this too.
 */
export function createPostgresTestPool(
  connectionString: string,
  options: Omit<pg.PoolConfig, "connectionString"> = {},
): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...options });
  pool.on("error", () => undefined);
  return pool;
}

export async function setupPostgresTestDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
): Promise<PostgresTestDb<TSchema>> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ship_api_test")
    .withUsername("ship_api")
    .withPassword("ship_api")
    .start();

  const connectionString = container.getConnectionUri();
  const pool = createPostgresTestPool(connectionString, { max: 5 });
  const db = drizzle(pool, { schema });

  // Programmatic pushSchema — same machinery `drizzle-kit push`
  // uses, no migration files needed. The framework's schema source
  // (.ts files) is the single source of truth for both runtime and
  // tests. Schema changes propagate without committing intermediate
  // migration SQL the test harness would otherwise have to track.
  //
  // The cast is required because drizzle-kit's `pushSchema` is
  // typed against a dialect-agnostic `PgDatabase<any, ...>` rather
  // than the concrete `NodePgDatabase<TSchema>` the runtime uses.
  // Both are functionally compatible.
  const result = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]);
  await result.apply();

  return {
    container,
    pool,
    db,
    connectionString,
    cleanup: async () => {
      await pool.end().catch(() => undefined);
      await container.stop().catch(() => undefined);
    },
  };
}

/**
 * Truncate every table in the supplied schema, restarting identity
 * columns. Use between tests in a suite to isolate per-test state
 * without paying the container-startup cost.
 *
 * Iterates every value in the schema export that has a `_.name`
 * property (the convention drizzle-orm uses for `pgTable` metadata).
 * Skips relations, enums, and any other non-table exports.
 */
export async function truncateAll<TSchema extends Record<string, unknown>>(
  ctx: PostgresTestDb<TSchema>,
): Promise<void> {
  const tableNames: string[] = [];
  for (const exported of Object.values(ctx.db._.schema ?? {})) {
    const meta = (exported as { dbName?: string } | undefined)?.dbName;
    if (typeof meta === "string" && meta.length > 0) tableNames.push(meta);
  }
  if (tableNames.length === 0) return;
  // Single TRUNCATE statement covers all tables; CASCADE handles FK
  // references; RESTART IDENTITY resets serial / identity sequences.
  const quoted = tableNames.map((n) => `"${n}"`).join(", ");
  await ctx.pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
