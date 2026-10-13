/**
 * Small token bucket for per-connection control-message limits. The compat
 * HTTP rate limiter lives in the v4 compatibility package, which the kernel
 * adapters do not import, so this stays internal and dependency-free.
 */
export interface TokenBucket {
  /** Returns true and consumes one token when available. */
  take(now?: number): boolean;
  readonly capacity: number;
}

export function createTokenBucket(options: {
  readonly capacity: number;
  readonly refillPerSecond: number;
}): TokenBucket {
  if (!Number.isFinite(options.capacity) || options.capacity < 1) {
    throw new TypeError("token bucket capacity must be at least 1");
  }
  if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
    throw new TypeError("token bucket refillPerSecond must be positive");
  }
  let tokens = options.capacity;
  let updatedAt = Date.now();
  return Object.freeze({
    capacity: options.capacity,
    take: (now = Date.now()) => {
      const elapsed = Math.max(0, now - updatedAt) / 1_000;
      tokens = Math.min(options.capacity, tokens + elapsed * options.refillPerSecond);
      updatedAt = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  });
}
