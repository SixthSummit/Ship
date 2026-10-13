import {
  createPostgresTestPool,
  type PostgresTestDb,
  setupPostgresTestDb,
} from "@sixthsummit/ship-testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advisoryLockProvider } from "./advisory-lock.js";

const marker = pgTable("advisory_lock_marker", { id: serial("id").primaryKey() });
const schema = { marker };

describe("advisoryLockProvider integration", () => {
  let context: PostgresTestDb<typeof schema>;
  let secondPool: pg.Pool;

  beforeAll(async () => {
    context = await setupPostgresTestDb(schema);
    secondPool = createPostgresTestPool(context.connectionString, { max: 3 });
  });

  afterAll(async () => {
    await secondPool?.end().catch(() => undefined);
    await context?.cleanup();
  });

  it("serializes one (jobId, key) across independent connections and frees it on release", async () => {
    const first = advisoryLockProvider(context.db);
    const second = advisoryLockProvider(drizzle(secondPool, { schema }));

    const lease = await first.acquire("reports.digest", "acme", 5_000);
    expect(lease).toBeDefined();
    expect(await second.acquire("reports.digest", "acme", 5_000)).toBeUndefined();
    const other = await second.acquire("reports.digest", "beta", 5_000);
    expect(other).toBeDefined();

    await first.release(lease as never);
    const reacquired = await second.acquire("reports.digest", "acme", 5_000);
    expect(reacquired).toBeDefined();
    await second.release(reacquired as never);
    await second.release(other as never);
    expect(first.held()).toBe(0);
    expect(second.held()).toBe(0);
  });

  it("expires a lease that is never released so another process can proceed", async () => {
    const first = advisoryLockProvider(context.db);
    const second = advisoryLockProvider(drizzle(secondPool, { schema }));
    const lease = await first.acquire("reports.expiry", "acme", 200);
    expect(lease).toBeDefined();
    expect(await second.acquire("reports.expiry", "acme", 200)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const taken = await second.acquire("reports.expiry", "acme", 1_000);
    expect(taken).toBeDefined();
    await second.release(taken as never);
  });
});
