import { describe, expect, it } from "vitest";
import {
  CacheConformanceError,
  cacheBackendConformance,
  createInMemoryCacheBackend,
  runCacheBackendConformance,
} from "./cache.js";

describe("createInMemoryCacheBackend", () => {
  for (const check of cacheBackendConformance(() => createInMemoryCacheBackend())) {
    it(`conformance: ${check.name}`, async () => {
      await check.run();
    });
  }

  it("evicts the least recently used entry past max", async () => {
    const backend = createInMemoryCacheBackend({ max: 2 });
    await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000 });
    await backend.set("b", { status: 200, data: 2 }, { ttlMs: 60_000 });
    await backend.get("a");
    await backend.set("c", { status: 200, data: 3 }, { ttlMs: 60_000 });
    expect(await backend.get("b")).toBeUndefined();
    expect(await backend.get("a")).toBeDefined();
    expect(await backend.get("c")).toBeDefined();
    expect(backend.size()).toBe(2);
  });

  it("expires entries against an injected clock", async () => {
    let now = 1_000;
    const backend = createInMemoryCacheBackend({ now: () => now });
    await backend.set("a", { status: 200, data: 1 }, { ttlMs: 500 });
    now += 499;
    expect(await backend.get("a")).toBeDefined();
    now += 2;
    expect(await backend.get("a")).toBeUndefined();
    expect(backend.size()).toBe(0);
  });

  it("drops a deleted key from its tag index", async () => {
    const backend = createInMemoryCacheBackend();
    await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000, tags: ["widgets"] });
    await backend.del("a");
    await backend.set("b", { status: 200, data: 2 }, { ttlMs: 60_000, tags: ["widgets"] });
    await backend.delByTag("widgets");
    expect(backend.size()).toBe(0);
  });

  it("clears everything", async () => {
    const backend = createInMemoryCacheBackend();
    await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000, tags: ["widgets"] });
    backend.clear();
    expect(backend.size()).toBe(0);
    await backend.delByTag("widgets");
    expect(await backend.health()).toMatchObject({ available: true });
  });
});

describe("cacheBackendConformance", () => {
  it("reports every check as passing for a conforming backend", async () => {
    const results = await runCacheBackendConformance(() => createInMemoryCacheBackend());
    expect(results.length).toBeGreaterThan(8);
    expect(results.filter((item) => item.error)).toEqual([]);
  });

  it("fails a backend that purges scoped tags too broadly", async () => {
    const results = await runCacheBackendConformance(() => {
      const backend = createInMemoryCacheBackend();
      // Treats `widgets@tenant:salpha` as `widgets`: one tenant's write purges every tenant.
      return {
        ...backend,
        delByTag: async (tag: string) => backend.delByTag(tag.split("@")[0] ?? tag),
      };
    });
    const failure = results.find((item) => item.error);
    expect(failure?.name).toBe(
      "purges a scoped tag without touching entries stored under other scope keys",
    );
  });

  it("fails a backend that ignores tags", async () => {
    const results = await runCacheBackendConformance(() => {
      const backend = createInMemoryCacheBackend();
      return { ...backend, delByTag: async () => undefined };
    });
    const failure = results.find((item) => item.error);
    expect(failure?.name).toBe("purges every key under a tag");
    expect(failure?.error).toBeInstanceOf(CacheConformanceError);
  });
});
