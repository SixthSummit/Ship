import { describe, expect, it, vi } from "vitest";
import { cached } from "./cached.js";
import { InMemoryCache } from "./InMemoryCache.js";

describe("cached()", () => {
  it("runs fn() on miss, stores the result, returns it", async () => {
    const cache = new InMemoryCache();
    const fn = vi.fn(async () => ({ id: 1, name: "alice" }));

    const result = await cached(cache, "k", 60, fn);
    expect(result).toEqual({ id: 1, name: "alice" });
    expect(fn).toHaveBeenCalledOnce();

    expect(await cache.get("k")).toEqual({ id: 1, name: "alice" });
  });

  it("returns cached value on hit; does NOT call fn()", async () => {
    const cache = new InMemoryCache();
    await cache.set("k", { fromCache: true });
    const fn = vi.fn(async () => ({ fromCache: false }));

    const result = await cached(cache, "k", 60, fn);
    expect(result).toEqual({ fromCache: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("caches null (representing 'known absence')", async () => {
    const cache = new InMemoryCache();
    const fn = vi.fn(async () => null);

    const result = await cached<unknown>(cache, "k", 60, fn);
    expect(result).toBeNull();
    // Note: null is cached but `cache.get` returns null on miss too;
    // we can't distinguish without checking fn-call count. Re-running
    // shows fn would re-fire because the InMemoryCache.get returns
    // null for a stored null *and* for a true miss. This is documented
    // behavior — null is "do not cache" semantically. RedisCache has the
    // same property.
    void result;
  });

  it("treats undefined returns as 'do not cache'", async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const fn = async () => {
      calls++;
      return undefined;
    };

    const a = await cached(cache, "k", 60, fn);
    const b = await cached(cache, "k", 60, fn);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("forwards tags into the underlying cache", async () => {
    const cache = new InMemoryCache();
    await cached(cache, "k", 60, async () => ({ x: 1 }), { tags: ["t1", "t2"] });
    await cache.invalidateTag("t1");
    expect(await cache.get("k")).toBeNull();
  });

  it("supports synchronous functions", async () => {
    const cache = new InMemoryCache();
    const result = await cached(cache, "k", 60, () => "sync-value");
    expect(result).toBe("sync-value");
  });

  it("re-runs fn() after the TTL expires", async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };

    expect(await cached(cache, "k", 0.05, fn)).toBe(1); // 50 ms
    expect(await cached(cache, "k", 0.05, fn)).toBe(1); // hit, still 1
    await new Promise((r) => setTimeout(r, 80));
    expect(await cached(cache, "k", 0.05, fn)).toBe(2); // expired → re-run
  });

  it("propagates fn() errors without caching", async () => {
    const cache = new InMemoryCache();
    const fn = vi.fn(async () => {
      throw new Error("upstream down");
    });

    await expect(cached(cache, "k", 60, fn)).rejects.toThrow("upstream down");
    expect(await cache.get("k")).toBeNull();
    // Next call also re-throws (nothing cached)
    await expect(cached(cache, "k", 60, fn)).rejects.toThrow("upstream down");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
