import type { LockLease, LockProvider } from "@sixthsummit/ship-core";
import type { Redis } from "ioredis";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

/** The subset of ioredis the lock provider uses; any compatible client works. */
export interface RedisLockClient {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numberOfKeys: number, ...arguments_: (string | number)[]): Promise<unknown>;
}

export interface RedisLockProviderOptions {
  readonly client: Redis | RedisLockClient;
  /** Redis key prefix; defaults to `ship:jobs:lock`. */
  readonly keyPrefix?: string;
  readonly clock?: () => Date;
}

export interface RedisLockProvider extends LockProvider {
  readonly adapter: "redis";
  readonly keyFor: (jobId: string, key: string) => string;
}

/**
 * Redis `SET NX PX` lease keyed by `(jobId, key)`. Release and extension are
 * compare-and-swap Lua scripts on the lease token, so a runner whose lease
 * already expired cannot release or extend a lease another runner now holds.
 */
export function createRedisLockProvider(options: RedisLockProviderOptions): RedisLockProvider {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.client !== "object" ||
    options.client === null ||
    typeof Reflect.get(options.client, "set") !== "function" ||
    typeof Reflect.get(options.client, "eval") !== "function"
  ) {
    throw new TypeError("createRedisLockProvider requires an ioredis-compatible client");
  }
  const client = options.client as RedisLockClient;
  const prefix = options.keyPrefix ?? "ship:jobs:lock";
  const clock = options.clock ?? (() => new Date());
  const keyFor = (jobId: string, key: string) => `${prefix}:${jobId}:${key}`;

  return Object.freeze({
    kind: "ship.lock-provider" as const,
    adapter: "redis" as const,
    keyFor,
    acquire: async (jobId: string, key: string, ttlMs: number) => {
      if (!(Number.isInteger(ttlMs) && ttlMs > 0)) {
        throw new TypeError("lock ttlMs must be a positive integer");
      }
      const token = globalThis.crypto.randomUUID();
      const result = await client.set(keyFor(jobId, key), token, "PX", ttlMs, "NX");
      if (result !== "OK") return undefined;
      return Object.freeze({
        jobId,
        key,
        token,
        expiresAt: new Date(clock().getTime() + ttlMs),
      });
    },
    release: async (lease: LockLease) => {
      await client.eval(RELEASE_SCRIPT, 1, keyFor(lease.jobId, lease.key), lease.token);
    },
    extend: async (lease: LockLease, ttlMs: number) => {
      const result = await client.eval(
        EXTEND_SCRIPT,
        1,
        keyFor(lease.jobId, lease.key),
        lease.token,
        ttlMs,
      );
      return result === 1;
    },
  });
}
