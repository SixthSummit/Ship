import { randomBytes } from "node:crypto";
import type {
  RateLimitBackend,
  RateLimitCheckArgs,
  RateLimitCheckResult,
} from "./RateLimitBackend.js";

/**
 * Atomic sliding-window-log rate limiter on Redis.
 *
 * Algorithm: each key is a sorted set keyed by timestamp. Each request
 * goes through a single Lua script that:
 *   1. ZREMRANGEBYSCORE removes entries outside the current window.
 *   2. ZCARD reads the current count.
 *   3. If >= max, returns denied (looks up the oldest entry to compute
 *      the reset time).
 *   4. Otherwise, ZADD adds this request and PEXPIRE bumps the bucket TTL.
 *
 * Single Lua script means atomicity per key — no race between concurrent
 * requests sharing a bucket. Cluster mode: hash-tag the bucket key to
 * keep it on one shard.
 *
 * Returns `{ allowed (0|1), used, limit, resetAtMs }` from the script;
 * the wrapper translates to the `RateLimitCheckResult` shape.
 *
 * Designed to accept any Redis-like client that supports `eval`. ioredis
 * and node-redis both qualify.
 */

const LUA_SLIDING_WINDOW = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local entryId = ARGV[4]

-- Drop expired entries
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)

local count = redis.call('ZCARD', KEYS[1])

if count >= max then
  -- Get oldest entry's score to compute when the window resets
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local resetAt = oldest[2] and (tonumber(oldest[2]) + windowMs) or (now + windowMs)
  return { 0, count, max, resetAt }
end

-- Allowed — record this request
redis.call('ZADD', KEYS[1], now, entryId)
redis.call('PEXPIRE', KEYS[1], windowMs)

local newCount = count + 1
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local resetAt = oldest[2] and (tonumber(oldest[2]) + windowMs) or (now + windowMs)
return { 1, newCount, max, resetAt }
`;

export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisSlidingWindowBackendOptions {
  client: RedisEvalClient;
  /** Optional namespace prepended to every bucket key. */
  keyPrefix?: string;
}

function nextEntryId(now: number): string {
  // Unique-enough per-process token: now-ms suffixed with crypto-quality
  // random bytes. F26 replaced the prior monotonic counter — that leaked
  // process uptime / request-count info to anyone who could observe two
  // consecutive entry IDs (admittedly a low-impact info leak, but
  // `crypto.randomBytes` is free).
  //
  // 8 bytes → 16 hex chars → 64 bits of entropy per entry. Far above the
  // collision threshold for a millisecond window even under heavy load.
  return `${now}-${randomBytes(8).toString("hex")}`;
}

export class RedisSlidingWindowBackend implements RateLimitBackend {
  private client: RedisEvalClient;
  private keyPrefix: string;

  constructor(opts: RedisSlidingWindowBackendOptions) {
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix ?? "ratelimit:";
  }

  async check(args: RateLimitCheckArgs): Promise<RateLimitCheckResult> {
    const namespacedKey = this.keyPrefix + args.key;
    const result = (await this.client.eval(
      LUA_SLIDING_WINDOW,
      1,
      namespacedKey,
      args.now,
      args.windowMs,
      args.max,
      nextEntryId(args.now),
    )) as [number, number, number, number];

    const [allowedFlag, used, limit, resetAtMs] = result;
    return {
      allowed: allowedFlag === 1,
      used,
      limit,
      resetAtMs,
    };
  }
}
