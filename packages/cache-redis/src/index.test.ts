import { cacheBackendConformance } from "@sixthsummit/ship-testing/cache";
import { describe, expect, it } from "vitest";
import { createRedisCacheBackend, RedisCacheError, type RedisLike } from "./index.js";

/**
 * In-memory stand-in for the ioredis surface the adapter uses. It is not a
 * Redis substitute: the real thing runs in `index.integration.test.ts`. This
 * fake exists so the key namespacing, TTL and tag bookkeeping are asserted
 * without Docker.
 */
class FakeRedis implements RedisLike {
  private values = new Map<string, { value: string; expiresAt: number }>();
  private sets = new Map<string, Set<string>>();
  reachable = true;

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, value: string, ...arguments_: unknown[]): Promise<unknown> {
    const index = arguments_.indexOf("PX");
    const ttl = index >= 0 ? Number(arguments_[index + 1]) : Number.POSITIVE_INFINITY;
    this.values.set(key, { value, expiresAt: Date.now() + ttl });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      this.sets.delete(key);
    }
    return deleted;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    const entry = this.values.get(key);
    if (entry) this.values.set(key, { ...entry, expiresAt: Date.now() + milliseconds });
    return 1;
  }

  async ping(): Promise<string> {
    if (!this.reachable) throw new Error("connection refused");
    return "PONG";
  }

  // Test introspection
  rawKeys(): string[] {
    return [...this.values.keys()];
  }
  rawValue(key: string): string | undefined {
    return this.values.get(key)?.value;
  }
}

describe("createRedisCacheBackend", () => {
  for (const check of cacheBackendConformance(() =>
    createRedisCacheBackend({ client: new FakeRedis() }),
  )) {
    it(`conformance: ${check.name}`, async () => {
      await check.run();
    });
  }

  it("namespaces keys and tag sets with the configured prefixes", async () => {
    const client = new FakeRedis();
    const backend = createRedisCacheBackend({
      client,
      keyPrefix: "billing:4.0.0:",
      tagPrefix: "t-",
    });
    await backend.set("entry", { status: 200, data: 1 }, { ttlMs: 60_000, tags: ["widgets"] });
    expect(client.rawKeys()).toEqual(["billing:4.0.0:entry"]);
    expect(await client.smembers("billing:4.0.0:t-widgets")).toEqual(["billing:4.0.0:entry"]);
  });

  it("stores JSON so operators can read what is cached", async () => {
    const client = new FakeRedis();
    const backend = createRedisCacheBackend({ client });
    await backend.set("entry", { status: 200, data: { total: 3 } }, { ttlMs: 60_000 });
    expect(client.rawValue("entry")).toBe('{"status":200,"data":{"total":3}}');
  });

  it("treats an unreadable stored value as a miss and drops it", async () => {
    const client = new FakeRedis();
    await client.set("entry", "not json", "PX", 60_000);
    const backend = createRedisCacheBackend({ client });
    expect(await backend.get("entry")).toBeUndefined();
    expect(client.rawKeys()).toEqual([]);
  });

  it("reports health from a ping, including an unreachable server", async () => {
    const client = new FakeRedis();
    const backend = createRedisCacheBackend({ client });
    expect(await backend.health()).toMatchObject({ available: true });
    client.reachable = false;
    expect(await backend.health()).toMatchObject({
      available: false,
      detail: "connection refused",
    });
  });

  it("flags a slow ping", async () => {
    const backend = createRedisCacheBackend({
      client: Object.assign(new FakeRedis(), {
        ping: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "PONG";
        },
      }),
      slowPingMs: 1,
    });
    expect(await backend.health()).toMatchObject({
      available: true,
      detail: expect.stringContaining("exceeded"),
    });
  });

  it("rejects an incomplete client or malformed options", () => {
    expect(() => createRedisCacheBackend({ client: {} as RedisLike })).toThrow(RedisCacheError);
    expect(() =>
      createRedisCacheBackend({ client: new FakeRedis(), keyPrefix: "bad prefix" }),
    ).toThrow(/whitespace-free/);
    expect(() => createRedisCacheBackend({ client: new FakeRedis(), slowPingMs: 0 })).toThrow(
      /positive safe integer/,
    );
  });
});
