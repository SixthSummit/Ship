import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildWorker, spawnChildWorker } from "./__fixtures__/children.js";
import {
  type RedisTestContainer,
  startRedis,
  uniquePrefix,
  waitFor,
} from "./__fixtures__/redis.js";
import {
  createFixtureRuntime,
  EVENTS_KEY,
  type FixtureEvent,
  parseEvents,
} from "./__fixtures__/single-runner-app.js";

interface Interval {
  readonly worker: string;
  readonly start: number;
  readonly end: number;
}

function intervals(events: readonly FixtureEvent[], key: string): Interval[] {
  const starts = new Map<string, FixtureEvent>();
  const result: Interval[] = [];
  for (const event of events.filter((item) => item.job === "fixture.serial" && item.key === key)) {
    if (event.phase === "start") {
      starts.set(event.runId, event);
      continue;
    }
    const start = starts.get(event.runId);
    if (start) result.push({ worker: event.worker, start: start.at, end: event.at });
  }
  return result.sort((left, right) => left.start - right.start);
}

function overlaps(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

describe("two worker processes on one Redis", () => {
  let redis: RedisTestContainer;
  let prefix: string;
  let children: ChildWorker[] = [];
  let api: Awaited<ReturnType<typeof createFixtureRuntime>>;

  beforeAll(async () => {
    redis = await startRedis();
    prefix = uniquePrefix("multi");
    children = ["worker-a", "worker-b"].map((name) =>
      spawnChildWorker("worker-child.ts", {
        REDIS_URL: redis.url,
        PREFIX: prefix,
        WORKER_NAME: name,
        HOLD_MS: "150",
      }),
    );
    await Promise.all(children.map((child) => child.ready));
    api = await createFixtureRuntime({
      redisUrl: redis.url,
      prefix,
      workerName: "api",
      mode: "api",
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => child.stop()));
    await api?.runtime.stop();
    await api?.redis.quit().catch(() => undefined);
    await redis?.stop();
  }, 60_000);

  it("never lets two processes own one (jobId, key) run while other keys proceed concurrently", async () => {
    const perKey = 6;
    for (let index = 0; index < perKey; index += 1) {
      for (const tenantId of ["acme", "beta"]) {
        const result = await api.backend.enqueue("fixture.serial", { tenantId, index });
        expect(result).toMatchObject({ accepted: true });
      }
    }
    await waitFor(
      async () =>
        parseEvents(await api.redis.lrange(EVENTS_KEY(prefix), 0, -1)).filter(
          (event) => event.job === "fixture.serial" && event.phase === "end",
        ).length >=
        perKey * 2,
      "every serial run to finish",
      60_000,
    );
    const events = parseEvents(await api.redis.lrange(EVENTS_KEY(prefix), 0, -1));
    const acme = intervals(events, "acme");
    const beta = intervals(events, "beta");
    expect(acme).toHaveLength(perKey);
    expect(beta).toHaveLength(perKey);

    for (const runs of [acme, beta]) {
      for (let index = 1; index < runs.length; index += 1) {
        const previous = runs[index - 1] as Interval;
        const current = runs[index] as Interval;
        expect(current.start).toBeGreaterThanOrEqual(previous.end);
      }
    }
    expect(acme.some((left) => beta.some((right) => overlaps(left, right)))).toBe(true);
    expect(new Set([...acme, ...beta].map((run) => run.worker))).toEqual(
      new Set(["worker-a", "worker-b"]),
    );
  }, 90_000);

  it("deduplicates scheduler ticks across processes by durable run identity", async () => {
    await waitFor(
      async () =>
        parseEvents(await api.redis.lrange(EVENTS_KEY(prefix), 0, -1)).filter(
          (event) => event.job === "fixture.tick",
        ).length >= 3,
      "at least three scheduled ticks",
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const ticks = parseEvents(await api.redis.lrange(EVENTS_KEY(prefix), 0, -1)).filter(
      (event) => event.job === "fixture.tick",
    );
    const runIds = ticks.map((event) => event.runId);
    expect(new Set(runIds).size).toBe(runIds.length);
    // Both processes upserted the same scheduler; ticks arrive roughly every 400 ms, never doubled.
    const sorted = ticks.map((event) => event.at).sort((left, right) => left - right);
    for (let index = 1; index < sorted.length; index += 1) {
      expect((sorted[index] as number) - (sorted[index - 1] as number)).toBeGreaterThan(150);
    }
    const health = await api.backend.health(new Date());
    expect(
      health.jobs.find((entry) => entry.jobId === "fixture.tick")?.lastSuccessAt,
    ).toBeDefined();
  }, 60_000);
});
