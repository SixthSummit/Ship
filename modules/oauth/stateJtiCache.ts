/**
 * `StateJtiCache` — single-use bookkeeping for OAuth state nonces (F16).
 *
 * The framework's signed state already defends against tampering and
 * carries a 10-minute expiry window. Inside that window, single-use
 * is enforced *only* by the upstream provider invalidating the
 * authorization code on exchange — fine when providers behave, but:
 *
 *   - Some providers retry on idempotent failures (e.g. transient
 *     network errors on the framework's token-exchange request)
 *     instead of invalidating eagerly.
 *   - A downstream adapter retry against a failed exchange can resend
 *     the same state.
 *   - A leaked-then-replayed state from logs / browser history / a
 *     misconfigured proxy that records query strings is theoretically
 *     replayable until the 10-minute window closes.
 *
 * This cache closes the within-window window: every successful state
 * verification records the nonce (acting as a JTI) with a short TTL.
 * A second use of the same nonce is rejected as a replay.
 *
 * Default in-memory implementation; multi-instance deployments need
 * a shared backing (Redis, etc.) to enforce single-use across nodes.
 * Surface the interface so a custom implementation can plug in.
 */

export interface StateJtiCache {
  /**
   * Atomic check + record. Returns `true` when `jti` was seen
   * within the last `ttlMs` (treat as replay; reject); returns
   * `false` when `jti` is fresh (record it and let the call
   * proceed). Same-tick semantics: within a single event-loop tick,
   * concurrent `seenAndRecord` calls behave like CAS (exactly one
   * returns `false`).
   */
  seenAndRecord(jti: string, ttlMs?: number): boolean;
}

/**
 * Default in-memory implementation. A `Map<string, number>` where
 * the value is the entry's expiration epoch (ms). Pruned
 * opportunistically on each call — no separate timer thread.
 *
 * Process lifecycle: entries reset on process restart. State has a
 * 10-minute expiry, so a restart effectively widens the replay
 * window to 10 minutes (not unlimited). Multi-instance consumers
 * (behind a load balancer) need a shared cache to enforce
 * single-use across nodes; swap in a Redis-backed implementation
 * of `StateJtiCache` to do so.
 */
export class InMemoryStateJtiCache implements StateJtiCache {
  private readonly entries = new Map<string, number>();
  private lastPruneAt = 0;

  /** Default TTL = 60 s (≈ longest reasonable OAuth round-trip). */
  static readonly DEFAULT_TTL_MS = 60_000;

  /** Run a prune at most every `PRUNE_INTERVAL_MS` to amortize cost. */
  private static readonly PRUNE_INTERVAL_MS = 5_000;

  seenAndRecord(jti: string, ttlMs = InMemoryStateJtiCache.DEFAULT_TTL_MS): boolean {
    const now = Date.now();
    this.maybePrune(now);

    const existing = this.entries.get(jti);
    if (existing !== undefined && existing > now) {
      return true; // replay
    }
    this.entries.set(jti, now + ttlMs);
    return false;
  }

  /** Exposed for tests; not part of the public contract. */
  _size(): number {
    return this.entries.size;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneAt < InMemoryStateJtiCache.PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    for (const [jti, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(jti);
    }
  }
}
