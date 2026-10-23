import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildWorker, spawnChildWorker } from "./__fixtures__/children.js";
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
 * Upper bound on recovery. Stall detection (lock 2 s + two 500 ms stalled
 * checks) and the outbox lease (1 s) put the expected recovery in the single
 * digits of seconds; the bound is generous because the suite runs alongside
 * three other Docker-backed files under `--maxWorkers=4`.
 */
const RECOVERY_TIMEOUT_MS = 45_000;

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

  /** What the recovery predicate sees, for the timeout message. */
  async function describeRecovery(
    api: Awaited<ReturnType<typeof createCrashRuntime>>,
    key: string,
  ) {
    const queue = api.backend.queue("crash.write");
    const [state, counts, failed] = await Promise.all([
      snapshot(key),
      queue.getJobCounts("waiting", "active", "delayed", "completed", "failed"),
      queue.getFailed(0, 5),
    ]);
    return JSON.stringify({
      state,
      counts,
      failed: failed.map((job) => ({
        id: job.id,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        stalledCounter: job.stalledCounter,
      })),
    });
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
    const children: ChildWorker[] = [];
    try {
      const crashing = spawnChildWorker("crash-child.ts", {
        ...environment,
        WORKER_NAME: "crashing",
        CRASH_AT: crashAt,
      });
      children.push(crashing);
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
      children.push(recovering);
      await recovering.ready;
      try {
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
          RECOVERY_TIMEOUT_MS,
          200,
        );
      } catch (error) {
        const detail = await describeRecovery(api, key).catch((cause) => `unavailable: ${cause}`);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; recovering child ${
            recovering.process.exitCode === null ? "alive" : `exited ${recovering.process.exitCode}`
          }; last observed ${detail}`,
        );
      }
      const recovered = await snapshot(key);
      return { afterCrash, recovered };
    } finally {
      // Stop the children before the api so a failed scenario never leaks a
      // worker that is still connected when `afterAll` stops the containers.
      await Promise.all(children.map((child) => child.stop()));
      await api.stop();
    }
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
