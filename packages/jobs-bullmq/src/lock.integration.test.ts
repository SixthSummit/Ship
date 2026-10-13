import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RedisTestContainer, startRedis } from "./__fixtures__/redis.js";
import { createRedisLockProvider } from "./lock.js";

describe("createRedisLockProvider integration", () => {
  let redis: RedisTestContainer;
  let first: Redis;
  let second: Redis;

  beforeAll(async () => {
    redis = await startRedis();
    first = new Redis(redis.url);
    second = new Redis(redis.url);
  });

  afterAll(async () => {
    await first?.quit().catch(() => undefined);
    await second?.quit().catch(() => undefined);
    await redis?.stop();
  });

  it("serializes one (jobId, key) across connections, honors TTL and token-guarded release", async () => {
    const one = createRedisLockProvider({ client: first, keyPrefix: "it:lock" });
    const two = createRedisLockProvider({ client: second, keyPrefix: "it:lock" });

    const lease = await one.acquire("reports.digest", "acme", 5_000);
    expect(lease).toBeDefined();
    expect(await two.acquire("reports.digest", "acme", 5_000)).toBeUndefined();
    expect(await two.acquire("reports.digest", "beta", 5_000)).toBeDefined();
    expect(await two.extend(lease as never, 5_000)).toBe(true);
    await two.release(lease as never);
    expect(await two.acquire("reports.digest", "acme", 5_000)).toBeDefined();

    const short = await one.acquire("reports.expiry", "acme", 200);
    expect(short).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await one.extend(short as never, 1_000)).toBe(false);
    expect(await two.acquire("reports.expiry", "acme", 1_000)).toBeDefined();
  });
});
