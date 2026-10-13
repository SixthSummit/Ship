# Rate limiting

> **Compatibility feature:** this Hono middleware remains available from the
> monolithic v4 package. Rate limiting is not yet a focused operation policy and
> must not be represented as one until the graph can inspect and test it.

The `rateLimit` middleware: how the sliding-window algorithm works, the bucket key resolution, the headers it sets, and the operational defaults around fail-open vs fail-closed.

## The middleware

```ts
import { rateLimit } from "@sixthsummit/ship-api";
import { RedisSlidingWindowBackend } from "@sixthsummit/ship-api/rate-limit";

const backend = new RedisSlidingWindowBackend({
  client: redisProvider.getClient(),
  keyPrefix: "ratelimit:",
});

app.post(
  "/auth/login",
  rateLimit({
    windowMs: 60_000,
    max: 5,
    backend,
    scope: "login",
  }),
  loginHandler,
);
```

That's a 5-requests-per-60-seconds limit on login attempts. The bucket key defaults to the authenticated user's id, falls back to client IP — so the limit is per-actor, not per-route-globally.

## Options

```ts
interface RateLimitOptions {
  windowMs: number;                          // window length in ms
  max: number;                               // max requests per key per window
  backend: RateLimitBackend;                 // Redis or in-memory
  keyGenerator?: (c: Context) => string;     // bucket-key composer
  scope?: string;                            // namespace prefix
  onBackendError?: "allow" | "deny";         // Redis unavailable behavior
  legacyHeaders?: boolean;                   // emit X-RateLimit-* legacy headers
  logger?: typeof defaultLogger;
}
```

The defaults are tuned for first-party apps:

- **`onBackendError: "deny"`** — fail-closed. If Redis is down, return 429 rather than allowing unrestricted access. Defends against availability attacks (knock Redis offline → all rate limits disabled).
- **`legacyHeaders: false`** — emit RFC-draft `RateLimit-*` headers only. Set to `true` if your clients rely on the older `X-RateLimit-*` headers.

## Default key resolution

Without a custom `keyGenerator`, the middleware:

1. Reads `c.get('user')`. If set (route ran through `requireAuth` first), uses `user.id`.
2. Otherwise reads `X-Forwarded-For`, then `X-Real-IP`. Takes the first value (proxy chain leftmost).
3. Falls back to `"ip:unknown"` if no headers are present.

The resulting key is namespaced with `scope`: `${scope}:${id}`. Different `scope` values give the same actor independent buckets — `login:123` and `payments:123` are separate.

## The sliding-window algorithm

The Redis backend uses an atomic Lua script over a sorted set. One Redis round-trip per check:

```lua
-- Drop entries older than the window
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)

-- Count current window
local count = redis.call('ZCARD', KEYS[1])
if count >= max then
  -- Denied — find oldest entry to compute reset time
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return { 0, count, max, oldest_score + windowMs }
end

-- Allowed — record this request
redis.call('ZADD', KEYS[1], now, entryId)
redis.call('PEXPIRE', KEYS[1], windowMs)
return { 1, count + 1, max, now + windowMs }
```

Two important properties:

**True sliding window, not fixed window.** A fixed-window limiter resets the bucket at `windowMs` boundaries — a burst right before the boundary plus a burst right after spans only seconds but doubles the apparent allowed rate. Sliding-window doesn't have boundaries; it always counts the last `windowMs` worth of requests.

**Atomic.** The Lua script runs as a single Redis operation. Two concurrent requests can't both squeeze under the limit by reading-then-writing — Redis serializes the script invocations.

## Response headers

On every request (allowed or denied):

```
RateLimit-Limit: 5
RateLimit-Remaining: 3
RateLimit-Policy: 5;w=60
```

`RateLimit-Policy: 5;w=60` is the RFC-draft format meaning "5 requests per 60-second window."

When `legacyHeaders: true`, also emit:

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 3
X-RateLimit-Reset: 1715000060      (epoch seconds when the window resets)
```

When denied, the middleware additionally sets `Retry-After: <seconds>` and throws `RateLimitError`. The framework's error handlers map this to a 429 with the standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded",
    "details": { "retryAfterSec": 30 }
  }
}
```

## Custom key resolution

The default key (user-id or IP) is rarely what you want for everything. Common variants:

```ts
// Per-IP regardless of auth (login attempts before user is known):
rateLimit({
  windowMs: 60_000,
  max: 5,
  backend,
  scope: "login",
  keyGenerator: (c) => {
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return xff ?? c.req.header("x-real-ip") ?? "ip:unknown";
  },
});

// Per-account-and-route (separate budgets per endpoint):
rateLimit({
  windowMs: 60_000,
  max: 100,
  backend,
  scope: c.req.path,
  keyGenerator: (c) => c.var.user?.id ?? "anon",
});

// Per-API-key (service-to-service):
rateLimit({
  windowMs: 60_000,
  max: 1000,
  backend,
  scope: "service-api",
  keyGenerator: (c) => `svc:${c.req.header("x-api-key")}`,
});
```

## Multiple limits per route

Stack `rateLimit` middleware to enforce both a fast limit (per-second burst) and a slow limit (per-hour total):

```ts
app.post(
  "/messages",
  requireAuth({ provider }),
  rateLimit({ windowMs: 1_000, max: 5, backend, scope: "msg-burst" }),
  rateLimit({ windowMs: 3600_000, max: 1_000, backend, scope: "msg-hour" }),
  handler,
);
```

The first to fail wins. The middleware doesn't coalesce — each layer is independent.

## In-memory backend

```ts
import { InMemorySlidingWindowBackend } from "@sixthsummit/ship-api/rate-limit";

const backend = new InMemorySlidingWindowBackend();
```

For tests and single-process scenarios. Stores a per-key array of timestamps; on each `check()`, filters by window cutoff and counts. Don't use in multi-replica production — each pod has its own buckets, and the effective rate per actor is N×limit where N is the replica count.

## When to fail open vs closed

The default `onBackendError: "deny"` is conservative. It costs availability — if Redis blips, users see 429s — for safety. The alternative `onBackendError: "allow"` keeps the app available but means a Redis outage temporarily disables rate limiting, which an attacker could exploit if they can also disrupt Redis.

The right choice depends on what the limit protects:

- **Cost limits** (LLM calls, email sends, SMS) — fail closed. A burst of unmetered LLM calls is more expensive than a brief 429 spike.
- **Anti-abuse** (login throttling, signup limits) — fail closed. The whole point is to slow attackers; failing open helps them.
- **Fairness limits** (per-user request budget on a free tier) — could go either way. Fail open if availability matters more than fairness during incidents.

Log the failure mode when it kicks in — `onBackendError: "allow"` should be auditable so post-incident analysis can see "the limit didn't fire because Redis was down."

## Operational concerns

**Bucket key cardinality.** Each unique key is a Redis sorted set. Keys that include high-cardinality data (request id, timestamp) create a sorted set per request and never reuse them — wasted memory. Keep keys to bounded cardinality (user id, IP, scope), let the TTL clean up.

**Window length and accuracy.** Shorter windows (1-second) are precise but noisy — small bursts trip them. Longer windows (60-second, 1-hour) are smoother but slower to respond. The standard pattern is layered limits as shown above: short window for burst protection, long window for sustained-rate protection.

**Limit by what matters.** A per-IP limit on `/api/*` doesn't protect a specific expensive endpoint — an attacker can spread requests across many endpoints. Limit at the right granularity for the resource you're protecting.

**Communicate the limit.** Include the limit policy in your API documentation and in the response headers. Surprise rate limits frustrate legitimate users; documented limits let consumers code retry-with-backoff.

## Source

- [`packages/core/src/http/middleware/rateLimit.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/middleware/rateLimit.ts) — middleware
- [`packages/core/src/app/services/rateLimit/RedisSlidingWindowBackend.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/rateLimit/RedisSlidingWindowBackend.ts) — Redis Lua implementation
- [`packages/core/src/app/services/rateLimit/InMemorySlidingWindowBackend.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/rateLimit/InMemorySlidingWindowBackend.ts)
