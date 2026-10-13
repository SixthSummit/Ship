/**
 * Storage abstraction for the rate-limit middleware.
 *
 * Two implementations ship in v4.0:
 *   - `RedisSlidingWindowBackend` — production default. Atomic Lua-script
 *     sliding-window log over a Redis sorted set (ZADD/ZRANGE/ZCARD).
 *     Supports horizontal scaling.
 *   - `InMemorySlidingWindowBackend` — test fixture. Single-process only;
 *     useful for unit tests and as a documented fallback when running
 *     a single-instance dev / staging service.
 *
 * The interface deliberately exposes the algorithm-agnostic shape: a
 * single `check()` that atomically counts + records the request and
 * returns the verdict + bookkeeping. Future v4.x implementations
 * (Cloudflare Durable Objects, Upstash REST, Memcached CAS) plug in
 * without changing the middleware.
 */

export interface RateLimitCheckArgs {
  /** Composed bucket key (caller has already applied scope + key generator). */
  key: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per window. */
  max: number;
  /** Current time in epoch milliseconds. Injected for deterministic tests. */
  now: number;
}

export interface RateLimitCheckResult {
  /** `true` → request is permitted; `false` → over the ceiling. */
  allowed: boolean;
  /** Number of requests counted toward this window so far (post-this-call). */
  used: number;
  /** Configured ceiling (returned for header convenience). */
  limit: number;
  /** Window-reset time in epoch ms. Used to compute `Retry-After`. */
  resetAtMs: number;
}

export interface RateLimitBackend {
  check(args: RateLimitCheckArgs): Promise<RateLimitCheckResult>;
}
