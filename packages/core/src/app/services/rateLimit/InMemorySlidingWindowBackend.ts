import type {
  RateLimitBackend,
  RateLimitCheckArgs,
  RateLimitCheckResult,
} from "./RateLimitBackend.js";

/**
 * In-process sliding-window-log limiter. Stores the timestamp of every
 * counted request in a per-key array; on each `check()` it drops entries
 * older than the window, counts the remainder, and either appends + allows
 * or returns denied.
 *
 * Single-process only — does NOT coordinate across instances. Use Redis
 * for multi-instance deployments. Suitable for tests, single-process dev,
 * and as a documented `onRedisUnavailable: 'allow'` fallback if a consumer
 * accepts the per-instance ceiling.
 *
 * Memory bound: each bucket holds at most `max` timestamps. A periodic
 * cleanup-on-write removes empty buckets so abandoned keys (no traffic
 * for > windowMs) don't leak memory.
 */
export class InMemorySlidingWindowBackend implements RateLimitBackend {
  private buckets = new Map<string, number[]>();

  async check(args: RateLimitCheckArgs): Promise<RateLimitCheckResult> {
    const { key, windowMs, max, now } = args;
    const cutoff = now - windowMs;

    let timestamps = this.buckets.get(key) ?? [];
    // Drop entries older than the window
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= max) {
      // Reset = oldest counted timestamp + window
      const resetAtMs = (timestamps[0] ?? now) + windowMs;
      this.buckets.set(key, timestamps);
      return {
        allowed: false,
        used: timestamps.length,
        limit: max,
        resetAtMs,
      };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);

    // Reset of the (now-non-empty) window — based on the oldest entry
    const resetAtMs = timestamps[0]! + windowMs;
    return {
      allowed: true,
      used: timestamps.length,
      limit: max,
      resetAtMs,
    };
  }

  /** Test helper: wipe everything. */
  clear(): void {
    this.buckets.clear();
  }
}
