import { Packr } from "msgpackr";
import { describe, expect, it } from "vitest";
import { RedisCache, type RedisLike } from "./RedisCache.js";

/**
 * Minimal in-memory fake of the ioredis surface RedisCache touches. We're
 * not testing Redis itself — we're testing that our serialization,
 * key-namespacing, and tag-tracking dance produces the right Redis calls.
 *
 * Real-Redis integration tests come later via testcontainers.
 */
class FakeRedis implements RedisLike {
  private kv = new Map<string, Buffer>();
  private sets = new Map<string, Set<string>>();
  private ttls = new Map<string, number>();

  async set(key: string, value: Buffer | string, ...args: unknown[]): Promise<unknown> {
    // Honor NX (set-if-absent) like real ioredis.
    if (args.includes("NX") && this.kv.has(key)) {
      return null;
    }
    const buf = typeof value === "string" ? Buffer.from(value) : value;
    this.kv.set(key, buf);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "EX" && typeof args[i + 1] === "number") {
        this.ttls.set(key, args[i + 1] as number);
      }
    }
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const buf = this.kv.get(key);
    return buf ? buf.toString() : null;
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    return this.kv.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) n++;
      this.sets.delete(k); // del a tag set wipes the set too
      this.ttls.delete(k);
    }
    return n;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let bucket = this.sets.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      this.sets.set(key, bucket);
    }
    let added = 0;
    for (const m of members) {
      if (!bucket.has(m)) {
        bucket.add(m);
        added++;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.kv.has(key) || this.sets.has(key)) {
      this.ttls.set(key, seconds);
      return 1;
    }
    return 0;
  }

  // Test introspection
  ttl(key: string) {
    return this.ttls.get(key);
  }
  hasKey(key: string) {
    return this.kv.has(key);
  }
}

describe("RedisCache", () => {
  it("get returns null on miss", async () => {
    const cache = new RedisCache({ client: new FakeRedis() });
    expect(await cache.get("missing")).toBeNull();
  });

  it("round-trips a value via msgpackr", async () => {
    const cache = new RedisCache({ client: new FakeRedis() });
    const value = { name: "alice", count: 7, active: true };
    await cache.set("k", value);
    expect(await cache.get("k")).toEqual(value);
  });

  it("preserves Date / Map / Set / undefined that JSON would lose", async () => {
    const cache = new RedisCache({ client: new FakeRedis() });
    const value = {
      when: new Date("2026-04-29T12:00:00Z"),
      tags: new Set(["a", "b"]),
      lookup: new Map([["k", 1]]),
      maybe: undefined,
    };
    await cache.set("k", value);
    const out = (await cache.get<typeof value>("k"))!;
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.toISOString()).toBe(value.when.toISOString());
    expect(out.tags).toBeInstanceOf(Set);
    expect([...out.tags]).toEqual(["a", "b"]);
    expect(out.lookup.get("k")).toBe(1);
  });

  it("keyPrefix namespaces all keys", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake, keyPrefix: "svc:v4:" });
    await cache.set("widget", { id: 1 });
    expect(fake.hasKey("svc:v4:widget")).toBe(true);
    expect(fake.hasKey("widget")).toBe(false);
  });

  it("set with ttlSec issues SET … EX <ttl>", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("k", "v", { ttlSec: 60 });
    expect(fake.ttl("k")).toBe(60);
  });

  it("set without ttlSec does not set an expiry", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("k", "v");
    expect(fake.ttl("k")).toBeUndefined();
  });

  it("set with tags SADDs the namespaced key into each tag set", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake, keyPrefix: "p:" });
    await cache.set("u:1", { x: 1 }, { tags: ["user:1", "module:users"] });
    expect(await fake.smembers("p:tag:user:1")).toEqual(["p:u:1"]);
    expect(await fake.smembers("p:tag:module:users")).toEqual(["p:u:1"]);
  });

  it("tag sets inherit the value's TTL so bookkeeping doesn't outlive data", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("k", "v", { ttlSec: 120, tags: ["t"] });
    expect(fake.ttl("tag:t")).toBe(120);
  });

  it("del removes a single key", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("k", "v");
    await cache.del("k");
    expect(fake.hasKey("k")).toBe(false);
  });

  it("del accepts an array", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.del(["a", "b"]);
    expect(fake.hasKey("a")).toBe(false);
    expect(fake.hasKey("b")).toBe(false);
  });

  it("del on empty array is a no-op", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await expect(cache.del([])).resolves.toBeUndefined();
  });

  it("invalidateTag deletes all members + the tag set itself", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("u:1", "alice", { tags: ["user:1"] });
    await cache.set("u:1:posts", "alice's posts", { tags: ["user:1"] });
    await cache.set("u:2", "bob", { tags: ["user:2"] });

    await cache.invalidateTag("user:1");
    expect(fake.hasKey("u:1")).toBe(false);
    expect(fake.hasKey("u:1:posts")).toBe(false);
    expect(fake.hasKey("u:2")).toBe(true);
    expect(await fake.smembers("tag:user:1")).toEqual([]);
  });

  it("invalidateTag on an unknown tag is a no-op", async () => {
    const cache = new RedisCache({ client: new FakeRedis() });
    await expect(cache.invalidateTag("never-set")).resolves.toBeUndefined();
  });

  it("integrates with custom tagPrefix", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake, tagPrefix: "T-" });
    await cache.set("k", 1, { tags: ["x"] });
    expect(await fake.smembers("T-x")).toEqual(["k"]);
  });

  describe("setIfAbsent", () => {
    it("returns true on first claim, false on subsequent claim of the same key", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake });
      const first = await cache.setIfAbsent("lock-1", "owner-a", { ttlSec: 30 });
      const second = await cache.setIfAbsent("lock-1", "owner-b", { ttlSec: 30 });
      expect(first).toBe(true);
      expect(second).toBe(false);
      // Original owner was preserved
      expect(await cache.get("lock-1")).toBe("owner-a");
    });

    it("uses SET NX EX so ioredis returns 'OK' on success and null on NX-rejection", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake, keyPrefix: "p:" });
      await cache.setIfAbsent("k", "v", { ttlSec: 60 });
      expect(fake.ttl("p:k")).toBe(60);
    });

    it("ttl is optional (no expiry when omitted)", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake });
      await cache.setIfAbsent("k", "v");
      expect(fake.ttl("k")).toBeUndefined();
    });
  });

  // Sanity check that msgpackr is actually being used
  it("stored value is msgpackr-encoded (binary), not JSON-encoded", async () => {
    const fake = new FakeRedis();
    const cache = new RedisCache({ client: fake });
    await cache.set("k", { x: 1 });
    const buf = await fake.getBuffer("k");
    expect(buf).toBeInstanceOf(Buffer);
    // msgpackr produces a small binary format; would-be JSON `{"x":1}` is 7 bytes.
    // Just verify it's parseable by msgpackr but not as JSON.
    expect(() => JSON.parse(buf!.toString())).toThrow();
    const packr = new Packr({ moreTypes: true });
    expect(packr.unpack(buf!)).toEqual({ x: 1 });
  });

  describe("HMAC integrity (F14)", () => {
    const KEY = "this-is-a-32-byte-signing-key-AAAA";

    it("round-trips a signed value", async () => {
      const cache = new RedisCache({ client: new FakeRedis(), signingKey: KEY });
      await cache.set("k", { x: 1 });
      expect(await cache.get("k")).toEqual({ x: 1 });
    });

    it("signing-enabled writes prepend the v1 frame byte + 32-byte MAC", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake, signingKey: KEY });
      await cache.set("k", { x: 1 });
      const buf = await fake.getBuffer("k");
      expect(buf).not.toBeNull();
      // [0x01][32-byte MAC][msgpackr bytes]
      expect(buf![0]).toBe(0x01);
      expect(buf!.length).toBeGreaterThan(1 + 32);
    });

    it("returns null + deletes the entry when the MAC doesn't verify", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake, signingKey: KEY });
      // Write a sham value directly into Redis bypassing the cache.
      await fake.set("k", Buffer.from([0x01, ...new Array(32 + 4).fill(0)]));
      expect(await cache.get("k")).toBeNull();
      // wait for the fire-and-forget delete to settle
      await new Promise((r) => setTimeout(r, 0));
      expect(await fake.getBuffer("k")).toBeNull();
    });

    it("returns null on a legacy (pre-signing) unsigned entry under signed mode", async () => {
      const fake = new FakeRedis();
      // Pretend a value was written by an older RedisCache without signing.
      const packr = new Packr({ moreTypes: true });
      await fake.set("k", packr.pack({ legacy: true }));
      const cache = new RedisCache({ client: fake, signingKey: KEY });
      expect(await cache.get("k")).toBeNull();
    });

    it("MAC binds the value to the key — copying the bytes to a different key fails verify", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake, signingKey: KEY });
      await cache.set("k-original", { secret: "owned" });
      const fromOrig = await fake.getBuffer("k-original");
      // Copy verbatim to a different key.
      await fake.set("k-attacker-copy", fromOrig!);
      expect(await cache.get("k-attacker-copy")).toBeNull();
    });

    it("disabled-by-default: same fake-Redis, same value bytes (legacy contract)", async () => {
      const fake = new FakeRedis();
      const cache = new RedisCache({ client: fake });
      await cache.set("k", { x: 1 });
      const buf = await fake.getBuffer("k");
      // Frame byte 0x01 would mean signed; legacy entries start with msgpackr bytes.
      expect(buf![0]).not.toBe(0x01);
      expect(await cache.get("k")).toEqual({ x: 1 });
    });

    it("rejects a short-string signingKey at construction (must be >= 32 chars)", () => {
      expect(() => new RedisCache({ client: new FakeRedis(), signingKey: "too-short" })).toThrow(
        /at least 32/,
      );
    });

    it("setIfAbsent under signing — round-trips via set then get", async () => {
      const cache = new RedisCache({ client: new FakeRedis(), signingKey: KEY });
      expect(await cache.setIfAbsent("k", { v: "first" })).toBe(true);
      expect(await cache.setIfAbsent("k", { v: "second" })).toBe(false);
      expect(await cache.get("k")).toEqual({ v: "first" });
    });
  });
});
