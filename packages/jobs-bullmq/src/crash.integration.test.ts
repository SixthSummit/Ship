import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnChildWorker } from "./__fixtures__/children.js";
import {
  type CrashPoint,
  crashOutboxTable,
  crashRecords,
  crashSchema,
  createCrashRuntime,
  deliveries,
} from "./__fixtures__/crash-app.js";
import {
  type RedisTestContainer,
  startRedis,
  uniquePrefix,
  waitFor,
} from "./__fixtures__/redis.js";

/**
 * Crash/restart at the three documented points. The worker child exits with
 * code 3 at the injected point; a second child with no crash point recovers.
 * Delivery is at-least-once: only the crash after the external effect yields a
 * duplicate delivery, and it is asserted rather than documented away.
 */
describe("crash and restart recovery", () => {
  let redis: RedisTestContainer;
  let postgres: PostgresTestDb<typeof crashSchema>;

  beforeAll(async () => {
    [redis, postgres] = await Promise.all([startRedis(), setupPostgresTestDb(crashSchema)]);
  }, 120_000);

  afterAll(async () => {
    await postgres?.cleanup();
    await redis?.stop();
  }, 60_000);

  async function snapshot(key: string) {
    const records = await postgres.db.select().from(crashRecords).where(eq(crashRecords.key, key));
    const delivered = await postgres.db.select().from(deliveries).where(eq(deliveries.key, key));
    const intents = await postgres.db
      .select()
      .from(crashOutboxTable)
      .where(eq(crashOutboxTable.dedupeKey, key));
    return {
      records: records.length,
      deliveries: delivered.length,
      intents: intents.map((row) => row.status),
    };
  }

  async function scenario(crashAt: CrashPoint, key: string) {
    const prefix = uniquePrefix(`crash-${crashAt}`);
    const environment = {
      REDIS_URL: redis.url,
      DATABASE_URL: postgres.connectionString,
      PREFIX: prefix,
    };
    const api = await createCrashRuntime({
      redisUrl: redis.url,
      databaseUrl: postgres.connectionString,
      prefix,
      workerName: "api",
      crashAt: "none",
      mode: "api",
    });
    const crashing = spawnChildWorker("crash-child.ts", {
      ...environment,
      WORKER_NAME: "crashing",
      CRASH_AT: crashAt,
    });
    await crashing.ready;
    const accepted = await api.backend.enqueue("crash.write", { key });
    expect(accepted).toMatchObject({ accepted: true });
    expect(await crashing.exited).toBe(3);
    const afterCrash = await snapshot(key);

    const recovering = spawnChildWorker("crash-child.ts", {
      ...environment,
      WORKER_NAME: "recovering",
      CRASH_AT: "none",
    });
    await recovering.ready;
    await waitFor(
      async () => {
        const state = await snapshot(key);
        const counts = await api.backend
          .queue("crash.write")
          .getJobCounts("waiting", "active", "delayed");
        return (
          state.records === 1 &&
          state.intents.every((status) => status === "completed") &&
          state.intents.length === 1 &&
          counts.waiting === 0 &&
          counts.active === 0 &&
          counts.delayed === 0
        );
      },
      `${crashAt} recovery`,
      45_000,
      200,
    );
    const recovered = await snapshot(key);
    await recovering.stop();
    await api.stop();
    return { afterCrash, recovered };
  }

  it("rolls back a crash before commit and completes the work once on restart", async () => {
    const { afterCrash, recovered } = await scenario("before-commit", "before-commit");
    expect(afterCrash).toEqual({ records: 0, deliveries: 0, intents: [] });
    expect(recovered).toEqual({ records: 1, deliveries: 1, intents: ["completed"] });
  }, 120_000);

  it("keeps a committed intent recoverable after a crash before dispatch without duplicating the write", async () => {
    const { afterCrash, recovered } = await scenario("after-commit", "after-commit");
    expect(afterCrash.records).toBe(1);
    expect(afterCrash.intents).toHaveLength(1);
    // The stalled BullMQ run re-executes; the idempotency window replays the committed result.
    expect(recovered).toEqual({ records: 1, deliveries: 1, intents: ["completed"] });
  }, 120_000);

  it("re-delivers after a crash between external success and completion (at-least-once)", async () => {
    const { afterCrash, recovered } = await scenario("after-effect", "after-effect");
    expect(afterCrash).toEqual({ records: 1, deliveries: 1, intents: ["claimed"] });
    expect(recovered.records).toBe(1);
    expect(recovered.intents).toEqual(["completed"]);
    expect(recovered.deliveries).toBe(2);
  }, 120_000);
});
