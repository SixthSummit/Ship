import { operationFailure } from "@sixthsummit/ship-core";
import type { HonoPreValidationPolicy } from "@sixthsummit/ship-hono";
import { readRequestClient } from "./client.js";
import { authRateLimited } from "./errors.js";

/** A counter per key and window; the in-memory store is per process, so use a shared one in a fleet. */
export interface RateLimitStore {
  /** Counts one hit and reports the window state after it. */
  hit(
    key: string,
    windowMs: number,
    now: Date,
  ): Promise<{ readonly count: number; readonly resetAt: Date }>;
}

export function createInMemoryRateLimitStore(
  options: { readonly capacity?: number } = {},
): RateLimitStore & { readonly reset: () => void } {
  const capacity = options.capacity ?? 50_000;
  let buckets = new Map<string, { count: number; resetAt: number }>();
  return Object.freeze({
    async hit(key: string, windowMs: number, now: Date) {
      const at = now.getTime();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= at) {
        if (buckets.size >= capacity) {
          for (const [bucketKey, bucket] of buckets) {
            if (bucket.resetAt <= at) buckets.delete(bucketKey);
          }
          if (buckets.size >= capacity) {
            const oldest = buckets.keys().next().value;
            if (oldest !== undefined) buckets.delete(oldest);
          }
        }
        const bucket = { count: 1, resetAt: at + windowMs };
        buckets.set(key, bucket);
        return { count: 1, resetAt: new Date(bucket.resetAt) };
      }
      existing.count += 1;
      return { count: existing.count, resetAt: new Date(existing.resetAt) };
    },
    reset() {
      buckets = new Map();
    },
  });
}

export interface CredentialAuthRateLimitOptions {
  /** The auth module id the operations are prefixed with. Defaults to `auth`. */
  readonly moduleId?: string;
  /** Window length. Defaults to 60 s. */
  readonly windowMs?: number;
  /** Attempts per key per window. Defaults to 10. */
  readonly max?: number;
  /** Operation suffixes to limit. Defaults to every public credential flow. */
  readonly operations?: readonly string[];
  /** Derives the bucket key; defaults to the client ip from `X-Forwarded-For` / `X-Real-IP`. */
  readonly key?: (request: Request) => string;
  readonly store?: RateLimitStore;
  readonly clock?: () => Date;
}

export const DEFAULT_RATE_LIMITED_OPERATIONS: readonly string[] = Object.freeze([
  "register",
  "verify-email",
  "resend-verification",
  "sign-in",
  "forgot-password",
  "reset-password",
  "confirm-email-change",
  "totp.verify",
  "recovery.consume",
]);

/**
 * Pre-validation policies (SAPI-476) for `createHonoAdapter({ preValidationPolicies })`:
 * a fixed window per operation and client key, answered with the declared
 * `AUTH_RATE_LIMITED` failure and RFC-draft `RateLimit-*` headers. Direct
 * executor runs never pass through it; lockout is the account-level guard.
 */
export function credentialAuthRateLimitPolicies(
  options: CredentialAuthRateLimitOptions = {},
): Readonly<Record<string, HonoPreValidationPolicy>> {
  const moduleId = options.moduleId ?? "auth";
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 10;
  if (!Number.isInteger(windowMs) || windowMs < 1000 || !Number.isInteger(max) || max < 1) {
    throw new TypeError("credential auth rate limit needs windowMs >= 1000 and max >= 1");
  }
  const store = options.store ?? createInMemoryRateLimitStore();
  const clock = options.clock ?? (() => new Date());
  const key = options.key ?? ((request: Request) => readRequestClient(request).ip ?? "ip:unknown");
  const policies: Record<string, HonoPreValidationPolicy> = {};
  for (const suffix of options.operations ?? DEFAULT_RATE_LIMITED_OPERATIONS) {
    const operationId = `${moduleId}.${suffix}`;
    policies[operationId] = async ({ request }) => {
      const now = clock();
      const bucket = await store.hit(`${operationId}:${key(request)}`, windowMs, now);
      const remaining = Math.max(0, max - bucket.count);
      if (bucket.count > max) {
        const retryAfter = Math.max(
          1,
          Math.ceil((bucket.resetAt.getTime() - now.getTime()) / 1000),
        );
        return {
          allowed: false,
          failure: operationFailure(authRateLimited, {
            headers: {
              "Retry-After": String(retryAfter),
              "RateLimit-Limit": String(max),
              "RateLimit-Remaining": "0",
            },
          }),
        };
      }
      return {
        allowed: true,
        headers: { "RateLimit-Limit": String(max), "RateLimit-Remaining": String(remaining) },
      };
    };
  }
  return Object.freeze(policies);
}
