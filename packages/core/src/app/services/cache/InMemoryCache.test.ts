import { describe, expect, it } from "vitest";
import { InMemoryCache } from "./InMemoryCache.js";

describe("InMemoryCache", () => {
  it("get returns null on miss", async () => {
    const cache = new InMemoryCache();
    expect(await cache.get("missing")).toBeNull();
  });

  it("stores and retrieves values", async () => {
    const cache = new InMemoryCache();
    await cache.set("k1", { hello: "world" });
    expect(await cache.get("k1")).toEqual({ hello: "world" });
  });

  it("preserves the value's identity on retrieval (reference equality for in-memory)", async () => {
    const cache = new InMemoryCache();
    const v = { x: 1 };
    await cache.set("k", v);
    expect(await cache.get("k")).toBe(v);
  });

  it("expires entries past their TTL", async () => {
    const cache = new InMemoryCache();
    await cache.set("k", "v", { ttlSec: 0.05 }); // 50ms
    expect(await cache.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 80));
    expect(await cache.get("k")).toBeNull();
  });

  it("del removes a single key", async () => {
    const cache = new InMemoryCache();
    await cache.set("k", "v");
    await cache.del("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("del accepts an array of keys", async () => {
    const cache = new InMemoryCache();
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);
    await cache.del(["a", "b"]);
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toBe(3);
  });

  it("del on missing key is silently ignored", async () => {
    const cache = new InMemoryCache();
    await expect(cache.del("nope")).resolves.toBeUndefined();
  });

  it("invalidateTag wipes every key under the tag and drops the tag set", async () => {
    const cache = new InMemoryCache();
    await cache.set("u:1:profile", "alice", { tags: ["user:1", "module:profile"] });
    await cache.set("u:1:posts", "alice's posts", { tags: ["user:1"] });
    await cache.set("u:2:profile", "bob", { tags: ["user:2", "module:profile"] });

    await cache.invalidateTag("user:1");
    expect(await cache.get("u:1:profile")).toBeNull();
    expect(await cache.get("u:1:posts")).toBeNull();
    expect(await cache.get("u:2:profile")).toBe("bob");

    // Re-setting under the tag and re-invalidating still works (tag set rebuilt)
    await cache.set("u:1:profile", "alice2", { tags: ["user:1"] });
    await cache.invalidateTag("user:1");
    expect(await cache.get("u:1:profile")).toBeNull();
  });

  it("invalidateTag on an unknown tag is a no-op", async () => {
    const cache = new InMemoryCache();
    await expect(cache.invalidateTag("never-set")).resolves.toBeUndefined();
  });

  it("clear empties everything", async () => {
    const cache = new InMemoryCache();
    await cache.set("k", "v", { tags: ["t"] });
    await cache.clear?.();
    expect(await cache.get("k")).toBeNull();
    await cache.invalidateTag("t"); // doesn't crash
  });

  describe("setIfAbsent", () => {
    it("returns true and stores when the key is absent", async () => {
      const cache = new InMemoryCache();
      const claimed = await cache.setIfAbsent("k", "v", { ttlSec: 60 });
      expect(claimed).toBe(true);
      expect(await cache.get("k")).toBe("v");
    });

    it("returns false and does not overwrite when the key already exists", async () => {
      const cache = new InMemoryCache();
      await cache.set("k", "original");
      const claimed = await cache.setIfAbsent("k", "different", { ttlSec: 60 });
      expect(claimed).toBe(false);
      expect(await cache.get("k")).toBe("original");
    });

    it("respects ttlSec", async () => {
      const cache = new InMemoryCache();
      await cache.setIfAbsent("k", "v", { ttlSec: 0.05 });
      expect(await cache.get("k")).toBe("v");
      await new Promise((r) => setTimeout(r, 80));
      expect(await cache.get("k")).toBeNull();
    });

    it("two concurrent claims of the same key — only one wins", async () => {
      const cache = new InMemoryCache();
      const [a, b] = await Promise.all([
        cache.setIfAbsent("k", "first", { ttlSec: 60 }),
        cache.setIfAbsent("k", "second", { ttlSec: 60 }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    /**
     * F19 — atomicity-invariant canary. 100 concurrent claims of the
     * same key must yield exactly one `true`. If a future refactor
     * inserts an `await` between the `has` check and the `set` write,
     * the body crosses a microtask boundary and concurrent callers
     * each see an empty slot — every caller observes `true` and the
     * idempotency middleware silently loses dedup. This test fails
     * loudly the moment that happens.
     */
    it("100 concurrent claims of the same key — exactly one returns true (F19 atomic CAS canary)", async () => {
      const cache = new InMemoryCache();
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          cache.setIfAbsent("race-key", `value-${i}`, { ttlSec: 60 }),
        ),
      );
      const winners = results.filter(Boolean);
      expect(winners).toHaveLength(1);
      // The persisted value must be the winner's value (whichever it was).
      const stored = await cache.get<string>("race-key");
      expect(stored).toMatch(/^value-\d+$/);
    });
  });

  it("respects max + LRU eviction", async () => {
    const cache = new InMemoryCache({ max: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    // Access "a" so "b" becomes the LRU; adding "c" should evict "b".
    await cache.get("a");
    await cache.set("c", 3);

    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toBe(3);
  });
});
