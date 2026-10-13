import { systemActor } from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  crashOutboxTable,
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

describe("cleanup job over BullMQ runs and the Drizzle outbox", () => {
  let redis: RedisTestContainer;
  let postgres: PostgresTestDb<typeof crashSchema>;
  let runtime: Awaited<ReturnType<typeof createCrashRuntime>>;

  beforeAll(async () => {
    [redis, postgres] = await Promise.all([startRedis(), setupPostgresTestDb(crashSchema)]);
    runtime = await createCrashRuntime({
      redisUrl: redis.url,
      databaseUrl: postgres.connectionString,
      prefix: uniquePrefix("cleanup"),
      workerName: "cleanup",
      crashAt: "none",
      mode: "worker",
      dispatchEveryMs: 100,
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.stop();
    await postgres?.cleanup();
    await redis?.stop();
  }, 60_000);

  it("removes completed runs and dispatched intents past retention and keeps undispatched intent", async () => {
    await runtime.backend.enqueue("crash.write", { key: "swept" });
    await waitFor(
      async () =>
        (await postgres.db.select().from(deliveries).where(eq(deliveries.key, "swept"))).length ===
        1,
      "the intent to be delivered",
    );
    await waitFor(
      async () =>
        (await runtime.backend.queue("crash.write").getJobCounts("completed")).completed === 1,
      "the run to complete",
    );
    // An intent that is not yet due must survive every sweep.
    await postgres.db.insert(crashOutboxTable).values({
      outboxId: "crash.outbox",
      intentId: "notify",
      payload: { key: "future" },
      dedupeKey: "future",
      availableAt: new Date(Date.now() + 60 * 60_000),
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    const result = await runtime.executor.run(
      "crash.cleanup",
      { payload: {} },
      { actor: systemActor({ id: "ops.cleanup" }) },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        runs: { completedDeleted: 1, deadLetteredDeleted: 0 },
        outboxes: [{ id: "crash.outbox", completedDeleted: 1, deadLetteredDeleted: 0 }],
      },
    });
    expect((await runtime.backend.queue("crash.write").getJobCounts("completed")).completed).toBe(
      0,
    );
    const remaining = await postgres.db.select().from(crashOutboxTable);
    expect(remaining.map((row) => [row.dedupeKey, row.status])).toEqual([["future", "pending"]]);
    // The cleanup job itself is a keyed single-runner: a second concurrent run would be refused.
    expect(result.ok && (await runtime.backend.health(new Date())).jobs.length).toBe(2);
  }, 60_000);
});
