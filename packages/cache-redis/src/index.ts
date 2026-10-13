import type { CacheBackend, CacheBackendHealth, CacheStoreOptions } from "@sixthsummit/ship-core";
import { createSingleFlight } from "@sixthsummit/ship-core";

/**
 * The Redis surface this adapter touches. Any client implementing it works:
 * ioredis in production, a hand-rolled fake in unit tests. Keeping the client
 * injected means this package has no Redis driver dependency of its own.
 */
export interface RedisLike {
  set(key: string, value: string, ...arguments_: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  ping(): Promise<string>;
}

export interface RedisCacheBackendOptions {
  readonly client: RedisLike;
  /**
   * Prepended to every key and tag set. Namespace it per service and release
   * (`billing:4.0.0:`) so a deploy can never read a previous build's entries.
   */
  readonly keyPrefix?: string;
  /** Tag-set namespace, applied after `keyPrefix`. Defaults to `tag:`. */
  readonly tagPrefix?: string;
  /** Surfaced by `health()` when a ping exceeds it. Defaults to 250 ms. */
  readonly slowPingMs?: number;
}

export type RedisCacheDiagnosticCode = "SHIP_CACHE_REDIS_OPTIONS_INVALID";

export class RedisCacheError extends TypeError {
  readonly code: RedisCacheDiagnosticCode;

  constructor(code: RedisCacheDiagnosticCode, message: string) {
    super(message);
    this.name = "RedisCacheError";
    this.code = code;
  }
}

/**
 * Redis-backed {@link CacheBackend} for declared read caching.
 *
 * Values are JSON: the framework only ever stores a validated operation
 * success result, which is already wire-serializable, and JSON keeps the
 * stored bytes inspectable by operators.
 *
 * Tag tracking mirrors the compatibility `RedisCache`: every tagged write
 * SADDs the namespaced key into `<keyPrefix><tagPrefix><tag>`, and the tag set
 * inherits the entry TTL so bookkeeping never outlives the data it tracks.
 * `delByTag` reads the members, deletes them, and drops the set — this is what
 * the cache-invalidation dispatcher calls after a write commits.
 *
 * Stampede protection is per process: `singleFlight` coalesces concurrent
 * misses for one key inside this instance. Cross-process coalescing is not
 * part of the declared contract.
 */
export function createRedisCacheBackend(options: RedisCacheBackendOptions): CacheBackend {
  assertOptions(options);
  const client = options.client;
  const keyPrefix = options.keyPrefix ?? "";
  const tagPrefix = options.tagPrefix ?? "tag:";
  const slowPingMs = options.slowPingMs ?? 250;
  const gate = createSingleFlight();
  const namespaced = (key: string): string => `${keyPrefix}${key}`;
  const tagKey = (tag: string): string => `${keyPrefix}${tagPrefix}${tag}`;

  return Object.freeze({
    kind: "ship.cache-backend" as const,
    get: async (key: string): Promise<unknown | undefined> => {
      const stored = await client.get(namespaced(key));
      if (stored === null) return undefined;
      try {
        return JSON.parse(stored) as unknown;
      } catch {
        // A value this adapter did not write, or a truncated one: treat it as
        // a miss and drop it rather than failing the read.
        await client.del(namespaced(key)).catch(() => 0);
        return undefined;
      }
    },
    set: async (key: string, value: unknown, storeOptions: CacheStoreOptions): Promise<void> => {
      const target = namespaced(key);
      await client.set(target, JSON.stringify(value), "PX", storeOptions.ttlMs);
      for (const tag of storeOptions.tags ?? []) {
        const set = tagKey(tag);
        await client.sadd(set, target);
        await client.pexpire(set, storeOptions.ttlMs);
      }
    },
    del: async (key: string): Promise<void> => {
      await client.del(namespaced(key));
    },
    delByTag: async (tag: string): Promise<void> => {
      const set = tagKey(tag);
      const members = await client.smembers(set);
      if (members.length > 0) await client.del(...members);
      await client.del(set);
    },
    health: async (): Promise<CacheBackendHealth> => {
      const startedAt = Date.now();
      try {
        const reply = await client.ping();
        const latencyMs = Date.now() - startedAt;
        return Object.freeze({
          available: reply === "PONG",
          latencyMs,
          ...(latencyMs > slowPingMs ? { detail: `ping exceeded ${slowPingMs}ms` } : {}),
        });
      } catch (error) {
        return Object.freeze({
          available: false,
          latencyMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : "ping failed",
        });
      }
    },
    singleFlight: gate,
  });
}

function assertOptions(options: RedisCacheBackendOptions): void {
  const client = options?.client as Partial<RedisLike> | undefined;
  const complete =
    typeof client === "object" &&
    client !== null &&
    (["set", "get", "del", "sadd", "smembers", "pexpire", "ping"] as const).every(
      (method) => typeof client[method] === "function",
    );
  if (!complete) {
    throw new RedisCacheError(
      "SHIP_CACHE_REDIS_OPTIONS_INVALID",
      "redis cache backend requires a client with set, get, del, sadd, smembers, pexpire and ping",
    );
  }
  for (const field of ["keyPrefix", "tagPrefix"] as const) {
    const value = options[field];
    if (value !== undefined && (typeof value !== "string" || /[\s]/u.test(value))) {
      throw new RedisCacheError(
        "SHIP_CACHE_REDIS_OPTIONS_INVALID",
        `${field} must be a whitespace-free string`,
      );
    }
  }
  if (
    options.slowPingMs !== undefined &&
    (!Number.isSafeInteger(options.slowPingMs) || options.slowPingMs <= 0)
  ) {
    throw new RedisCacheError(
      "SHIP_CACHE_REDIS_OPTIONS_INVALID",
      "slowPingMs must be a positive safe integer",
    );
  }
}
