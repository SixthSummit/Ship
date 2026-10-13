import type { CacheBackend, CacheStoreOptions } from "@sixthsummit/ship-core";
import { createSingleFlight } from "@sixthsummit/ship-core";

/**
 * In-process cache backend for tests and single-process development.
 *
 * Entries are evicted least-recently-used past `max`, expire on their declared
 * TTL, and are indexed by tag so `delByTag` mirrors what a shared backend does
 * when the cache-invalidation dispatcher performs a purge. Tag invalidation is
 * process-local: a multi-instance deployment needs a shared backend.
 */
export interface InMemoryCacheBackendOptions {
  /** Entries retained before least-recently-used eviction. Defaults to 1000. */
  readonly max?: number;
  /** Injectable clock, in epoch milliseconds, for deterministic expiry tests. */
  readonly now?: () => number;
}

export interface InMemoryCacheBackend extends CacheBackend {
  /** Live entry count, after expiry of anything already past its TTL. */
  size(): number;
  clear(): void;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
  readonly tags: readonly string[];
}

export function createInMemoryCacheBackend(
  options: InMemoryCacheBackendOptions = {},
): InMemoryCacheBackend {
  const max = options.max ?? 1000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  const tagIndex = new Map<string, Set<string>>();
  const gate = createSingleFlight();

  const forget = (key: string): void => {
    entries.delete(key);
    for (const [tag, keys] of tagIndex) {
      keys.delete(key);
      if (keys.size === 0) tagIndex.delete(tag);
    }
  };

  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      forget(key);
      return undefined;
    }
    return entry;
  };

  return {
    kind: "ship.cache-backend" as const,
    get: async (key: string) => {
      const entry = live(key);
      if (!entry) return undefined;
      // Refresh recency so eviction stays least-recently-used.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set: async (key: string, value: unknown, storeOptions: CacheStoreOptions) => {
      forget(key);
      entries.set(key, {
        value,
        expiresAt: now() + storeOptions.ttlMs,
        tags: Object.freeze([...(storeOptions.tags ?? [])]),
      });
      for (const tag of storeOptions.tags ?? []) {
        const keys = tagIndex.get(tag) ?? new Set<string>();
        keys.add(key);
        tagIndex.set(tag, keys);
      }
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
    },
    del: async (key: string) => {
      forget(key);
    },
    delByTag: async (tag: string) => {
      for (const key of [...(tagIndex.get(tag) ?? [])]) forget(key);
      tagIndex.delete(tag);
    },
    health: async () => ({ available: true, detail: `${entries.size} entries` }),
    singleFlight: gate,
    size: () => {
      for (const key of [...entries.keys()]) live(key);
      return entries.size;
    },
    clear: () => {
      entries.clear();
      tagIndex.clear();
    },
  };
}

export interface CacheConformanceCheck {
  readonly name: string;
  run(): Promise<void>;
}

export class CacheConformanceError extends Error {
  readonly check: string;

  constructor(check: string, message: string) {
    super(`${check}: ${message}`);
    this.name = "CacheConformanceError";
    this.check = check;
  }
}

/**
 * The behavioral contract every CacheBackend adapter must satisfy, expressed as
 * runner-agnostic checks so the same suite runs against the in-memory backend
 * and a real Redis without this package depending on a test framework.
 *
 * `createBackend` must return an empty backend on every call.
 */
export function cacheBackendConformance(
  createBackend: () => CacheBackend | Promise<CacheBackend>,
): readonly CacheConformanceCheck[] {
  const check = (
    name: string,
    run: (backend: CacheBackend) => Promise<void>,
  ): CacheConformanceCheck => ({
    name,
    run: async () => {
      await run(await createBackend());
    },
  });

  const expect = (name: string, condition: unknown, message: string): void => {
    if (!condition) throw new CacheConformanceError(name, message);
  };

  return Object.freeze([
    check("miss returns undefined", async (backend) => {
      expect(
        "miss returns undefined",
        (await backend.get("absent")) === undefined,
        "expected undefined for an unknown key",
      );
    }),
    check("round-trips a stored value", async (backend) => {
      await backend.set("key", { status: 200, data: { total: 7 } }, { ttlMs: 60_000 });
      const stored = await backend.get("key");
      expect(
        "round-trips a stored value",
        JSON.stringify(stored) === JSON.stringify({ status: 200, data: { total: 7 } }),
        `expected the stored value back, received ${JSON.stringify(stored)}`,
      );
    }),
    check("keeps a stored null distinct from a miss", async (backend) => {
      await backend.set("key", { status: 200, data: null }, { ttlMs: 60_000 });
      const stored = await backend.get("key");
      expect(
        "keeps a stored null distinct from a miss",
        stored !== undefined && (stored as { data: unknown }).data === null,
        "expected a stored null payload to survive the round trip",
      );
    }),
    check("expires an entry after its ttl", async (backend) => {
      await backend.set("key", { status: 200, data: 1 }, { ttlMs: 30 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(
        "expires an entry after its ttl",
        (await backend.get("key")) === undefined,
        "expected the entry to expire",
      );
    }),
    check("deletes one key", async (backend) => {
      await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000 });
      await backend.set("b", { status: 200, data: 2 }, { ttlMs: 60_000 });
      await backend.del("a");
      expect("deletes one key", (await backend.get("a")) === undefined, "expected a to be gone");
      expect("deletes one key", (await backend.get("b")) !== undefined, "expected b to survive");
    }),
    check("deleting an unknown key is a no-op", async (backend) => {
      await backend.del("absent");
      await backend.delByTag("absent");
    }),
    check("purges every key under a tag", async (backend) => {
      await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000, tags: ["widgets"] });
      await backend.set("b", { status: 200, data: 2 }, { ttlMs: 60_000, tags: ["widgets"] });
      await backend.set("c", { status: 200, data: 3 }, { ttlMs: 60_000, tags: ["gadgets"] });
      await backend.delByTag("widgets");
      expect("purges every key under a tag", (await backend.get("a")) === undefined, "a survived");
      expect("purges every key under a tag", (await backend.get("b")) === undefined, "b survived");
      expect(
        "purges every key under a tag",
        (await backend.get("c")) !== undefined,
        "an unrelated tag was purged",
      );
    }),
    check(
      "purges a scoped tag without touching entries stored under other scope keys",
      async (backend) => {
        // The executor stores an actor- or tenant-scoped entry under its plain
        // tag and under `<tag>@<scopeKey>`; a scoped purge names only the latter
        // and must leave every other subject's entries warm, while the plain tag
        // still reaches them all.
        await backend.set(
          "alpha",
          { status: 200, data: 1 },
          { ttlMs: 60_000, tags: ["widgets", "widgets@tenant:salpha"] },
        );
        await backend.set(
          "beta",
          { status: 200, data: 2 },
          { ttlMs: 60_000, tags: ["widgets", "widgets@tenant:sbeta"] },
        );
        await backend.delByTag("widgets@tenant:salpha");
        expect(
          "purges a scoped tag without touching entries stored under other scope keys",
          (await backend.get("alpha")) === undefined,
          "alpha survived its scoped purge",
        );
        expect(
          "purges a scoped tag without touching entries stored under other scope keys",
          (await backend.get("beta")) !== undefined,
          "beta was purged by another tenant's scoped tag",
        );
        await backend.delByTag("widgets");
        expect(
          "purges a scoped tag without touching entries stored under other scope keys",
          (await backend.get("beta")) === undefined,
          "the plain tag no longer reaches a scoped entry",
        );
      },
    ),
    check("rebuilds a tag after it is purged", async (backend) => {
      await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000, tags: ["widgets"] });
      await backend.delByTag("widgets");
      await backend.set("a", { status: 200, data: 2 }, { ttlMs: 60_000, tags: ["widgets"] });
      await backend.delByTag("widgets");
      expect(
        "rebuilds a tag after it is purged",
        (await backend.get("a")) === undefined,
        "expected the re-tagged key to be purged again",
      );
    }),
    check("overwrites an existing key", async (backend) => {
      await backend.set("a", { status: 200, data: 1 }, { ttlMs: 60_000 });
      await backend.set("a", { status: 200, data: 2 }, { ttlMs: 60_000 });
      const stored = (await backend.get("a")) as { data: number } | undefined;
      expect("overwrites an existing key", stored?.data === 2, "expected the newer value");
    }),
    check("reports health", async (backend) => {
      const health = await backend.health();
      expect("reports health", health.available === true, "expected an available backend");
    }),
    check("coalesces concurrent misses for one key", async (backend) => {
      if (!backend.singleFlight) return;
      let calls = 0;
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          backend.singleFlight?.("key", async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return calls;
          }),
        ),
      );
      expect(
        "coalesces concurrent misses for one key",
        calls === 1 && results.every((item) => item === 1),
        `expected one loader run, observed ${calls}`,
      );
    }),
  ]);
}

/** Runs every conformance check and returns the failures, if any. */
export async function runCacheBackendConformance(
  createBackend: () => CacheBackend | Promise<CacheBackend>,
): Promise<readonly { readonly name: string; readonly error?: Error }[]> {
  const results: { name: string; error?: Error }[] = [];
  for (const check of cacheBackendConformance(createBackend)) {
    try {
      await check.run();
      results.push({ name: check.name });
    } catch (error) {
      results.push({ name: check.name, error: error as Error });
    }
  }
  return Object.freeze(results);
}
