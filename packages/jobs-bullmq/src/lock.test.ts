import { describe, expect, it } from "vitest";
import { createRedisLockProvider, type RedisLockClient } from "./lock.js";

/** Minimal Redis emulation for SET NX PX plus the two Lua scripts the provider uses. */
function fakeRedis(clock: () => number) {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= clock()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  const client: RedisLockClient = {
    set: async (key, value, _px, ttl, _nx) => {
      if (live(key)) return null;
      store.set(key, { value, expiresAt: clock() + ttl });
      return "OK";
    },
    eval: async (script, _keys, key, token, ttl) => {
      const entry = live(key as string);
      if (!entry || entry.value !== token) return 0;
      if (script.includes("pexpire")) {
        entry.expiresAt = clock() + Number(ttl);
        return 1;
      }
      store.delete(key as string);
      return 1;
    },
  };
  return { client, store };
}

describe("createRedisLockProvider", () => {
  it("acquires, extends and releases token-guarded leases", async () => {
    let now = 1_000;
    const redis = fakeRedis(() => now);
    const provider = createRedisLockProvider({
      client: redis.client,
      keyPrefix: "test:lock",
      clock: () => new Date(now),
    });

    const lease = await provider.acquire("reports.digest", "acme", 500);
    expect(lease).toMatchObject({
      jobId: "reports.digest",
      key: "acme",
      expiresAt: new Date(1_500),
    });
    expect(provider.keyFor("reports.digest", "acme")).toBe("test:lock:reports.digest:acme");
    expect(await provider.acquire("reports.digest", "acme", 500)).toBeUndefined();
    expect(await provider.acquire("reports.digest", "beta", 500)).toBeDefined();

    now = 1_400;
    expect(await provider.extend(lease as never, 500)).toBe(true);
    now = 1_800;
    expect(await provider.acquire("reports.digest", "acme", 500)).toBeUndefined();
    now = 2_000;
    expect(await provider.extend(lease as never, 500)).toBe(false);

    const taken = await provider.acquire("reports.digest", "acme", 500);
    expect(taken?.token).not.toBe(lease?.token);
    await provider.release(lease as never);
    expect(redis.store.has("test:lock:reports.digest:acme")).toBe(true);
    await provider.release(taken as never);
    expect(redis.store.has("test:lock:reports.digest:acme")).toBe(false);
  });

  it("validates its client and lease arguments", async () => {
    expect(() => createRedisLockProvider({ client: {} as never })).toThrow(TypeError);
    expect(() => createRedisLockProvider(null as never)).toThrow(TypeError);
    const provider = createRedisLockProvider({ client: fakeRedis(() => 0).client });
    await expect(provider.acquire("a", "b", 0)).rejects.toThrow(TypeError);
    expect(provider.adapter).toBe("redis");
    expect(provider.keyFor("a", "b")).toBe("ship:jobs:lock:a:b");
  });
});
