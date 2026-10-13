# Idempotency

> **Compatibility feature:** this middleware remains available from the
> monolithic v4 package. A focused idempotency capability has not been accepted;
> applications must not hide it outside the operation graph.

`idempotency` middleware — Stripe-style replay deduplication for write endpoints. Same `Idempotency-Key` plus same request body → same response, no duplicate effects. Same key plus different body → 422.

## The middleware

```ts
import { idempotency } from "@sixthsummit/ship-api";
import { RedisCache } from "@sixthsummit/ship-api/app/services/cache/RedisCache";

const cache = new RedisCache({ client: redisProvider.getClient() });

app.post(
  "/payments/charge",
  requireAuth({ provider }),
  validate("json", chargeSchema),
  idempotency({ cache, ttlSec: 24 * 60 * 60, scope: "charges" }),
  async (c) => {
    const body = c.req.valid("json");
    const result = await paymentService.charge(body);
    return c.json(result, 201);
  },
);
```

The client supplies an `Idempotency-Key` header. The middleware:

1. Hashes `method | path | sorted-query | body` to get a request fingerprint.
2. Looks up `idempotency:<scope>:<actor>:<key>` in cache.
3. **Cached, same fingerprint** → replay the stored response (200 + body). Never invokes the handler.
4. **Cached, different fingerprint** → throws `IdempotencyKeyReusedError` (422). Stripe's behavior: same key + different body is a client bug and worth surfacing.
5. **In-flight (`__pending__` sentinel)** → throws `ConflictError` (409). Concurrent retries shouldn't both run.
6. **Not cached** → claim with `setIfAbsent(__pending__, ttlSec: 60)`, run the handler, capture the response, replace the sentinel with the finalized entry.

## Options

```ts
interface IdempotencyOptions {
  cache: Cache;                              // Redis or in-memory
  ttlSec?: number;                           // replay window, default 24h
  scope?: string;                            // bucket namespace
  keyGenerator?: (c: Context) => string;     // actor composer
  maxBodyBytes?: number;                     // cache size limit, default 256KB
  logger?: typeof defaultLogger;
}
```

`ttlSec` is the replay window — how long the framework remembers a response and replays it for the same key. The 24-hour default matches Stripe's documentation; tune up or down based on how long clients reasonably retry.

`scope` namespaces the cache key. Use a different scope per endpoint family (charges, refunds, transfers) so a stale charges key can't accidentally replay against a refund endpoint with the same body shape.

## What gets stored

```ts
interface StoredIdempotencyEntry {
  requestHash: string;      // SHA256 of method | path | sorted-query | body
  status: number;
  headers: Record<string, string>;
  body: string | null;       // null if response body > maxBodyBytes
  bodyTooLarge?: boolean;
  recordedAt: number;        // wall-clock ms
}
```

The replay returns the original status, headers, and body verbatim — including `Set-Cookie`, `Location`, etc. Replay headers add:

```
X-Idempotency-Replay: true
X-Idempotency-Recorded-At: 2024-05-03T16:42:00.000Z
```

## Body size limit

`maxBodyBytes` (default 256 KB) caps what the middleware will cache. Above that, the request still runs once successfully, but the framework stores a `bodyTooLarge: true` flag instead of the body. A subsequent retry sees:

```
HTTP/1.1 200 OK
X-Idempotency-Replay: true
X-Idempotency-Replay-Lost: true
```

with no body. The header tells the client "we did successfully process your request, but we can't replay the response — assume success." For most APIs this is the right tradeoff; for clients that strictly need the response body, raise `maxBodyBytes` or split large payloads into chunked uploads with separate keys.

## Idempotency-Key validation

The middleware doesn't enforce length or character restrictions on the header value. **Validate at the route level**:

```ts
const idempotencyHeaderSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/);

app.post(
  "/payments/charge",
  validate("header", z.object({ "idempotency-key": idempotencyHeaderSchema })),
  idempotency({ cache, scope: "charges" }),
  handler,
);
```

A malicious or buggy client sending unbounded keys can DOS your cache. Validate on input.

## Default actor

```ts
keyGenerator: (c) => c.get("user")?.id ?? "anon"
```

Used as the `<actor>` segment of the cache key. Anonymous endpoints get all-anon collisions; for genuinely anonymous endpoints (signup, password reset), include something more specific in `keyGenerator` — IP, user agent hash, etc. — to avoid one client's idempotency-key colliding with another's.

## Error handling — what happens mid-handler

The middleware claims the slot, runs the handler, and only on completion replaces the sentinel with the finalized entry. Three failure modes:

**Handler throws non-`AppError`** (uncaught exception, network error to a downstream): the sentinel is dropped so the next retry runs fresh. The exception propagates normally and surfaces as 500.

**Handler throws `AppError`** (validation failure, NotFoundError, etc.): the error response is *cached* and replayed idempotently. This is correct — if the same key + same body produced a 404 once, it should produce 404 again, not run the side effect.

**Process crashes during handler** (OOM kill, restart, etc.): the sentinel survives until its 60-second TTL. During that window, retries return 409 (in-flight). After expiry, the next retry runs the handler again. If the handler completed but the response wasn't recorded, that retry produces duplicate side effects — the limitation of an at-most-once-replay design without distributed transactions.

For payment processors and similar workloads where duplicate effects are catastrophic, layer this with downstream idempotency: pass the `Idempotency-Key` to the payment provider too, so even a duplicate charge attempt at the provider is a no-op.

## When to use it

- **POST endpoints that have side effects** (create resources, charge payments, send emails, enqueue jobs). The whole point.
- **PUT endpoints that aren't naturally idempotent** — e.g., a `PUT /things/:id/process` that triggers external work; the URL is "idempotent" but the side effect isn't.
- **Webhook receivers** that need to dedupe replays — set the `keyGenerator` to extract the provider's event id (`Stripe-Event-Id`, `X-GitHub-Delivery`, etc.).

Don't bother for naturally idempotent operations (PUT-as-replace, GET, DELETE) — they're already safe to retry.

## Combining with rate limiting

Stack idempotency *before* rate limit. A client retrying with the same key shouldn't burn rate-limit budget on each retry — the retry is a duplicate, not a new request.

```ts
app.post(
  "/payments/charge",
  requireAuth({ provider }),
  validate("json", chargeSchema),
  idempotency({ cache, scope: "charges" }),         // first
  rateLimit({ windowMs: 60_000, max: 100, backend }),// second
  handler,
);
```

A replay returns from the idempotency middleware before the rate-limit middleware runs.

## Operational concerns

**Cache backend matters.** The middleware uses the framework's `Cache` interface — typically `RedisCache`. In multi-replica deployments, all replicas must share the same Redis instance, otherwise replays can't follow the original request to a different pod.

**TTL vs business expectations.** A 24-hour replay window means a client can retry tomorrow and get yesterday's response. That's usually correct (you want safe retries through long network outages), but for some workflows (orders that change daily) it's wrong. Match `ttlSec` to the business window where replays are meaningful.

**Stripe's documented behavior.** This implementation follows [Stripe's idempotency docs](https://stripe.com/docs/api/idempotent_requests) closely — same key + same body replays, same key + different body fails. If you've integrated Stripe, your clients already expect this shape.

**Storage growth.** Cached responses persist for `ttlSec`. If your traffic includes many idempotent operations, the cache is a real storage cost. Monitor `idempotency:*` key count in Redis; consider a shorter TTL if it's a problem.

## Source

- [`packages/core/src/http/middleware/idempotency.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/middleware/idempotency.ts) — the middleware
- [Stripe's idempotency documentation](https://stripe.com/docs/api/idempotent_requests) — the reference implementation
