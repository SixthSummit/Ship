import type { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';

/**
 * UUID generator for idempotency keys. Defaults to `crypto.randomUUID()`,
 * available in modern browsers and Node 19+. Override in tests for
 * deterministic keys, or in apps that want a different key shape.
 */
export const IDEMPOTENCY_KEY_GENERATOR = new InjectionToken<() => string>(
  'SHIP_ANGULAR_IDEMPOTENCY_KEY_GENERATOR',
  { factory: () => () => crypto.randomUUID() }
);

/**
 * Header name the framework attaches the generated key under. Matches
 * Stripe's convention and ShipAPI's `idempotency()` middleware default.
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * Header name used to opt out of idempotency-key attachment per request.
 * The header is consumed by the interceptor (stripped before send) — it
 * never reaches the network.
 *
 * ```ts
 * httpClient.post('/api/x', body, { headers: { 'X-Skip-Idempotency': 'true' } });
 * ```
 */
export const SKIP_IDEMPOTENCY_HEADER = 'X-Skip-Idempotency';

/**
 * HTTP methods the interceptor attaches keys to. POST / PATCH / PUT
 * require idempotency keys to safely retry; GET / HEAD / OPTIONS / DELETE
 * are idempotent by RFC 7231 and skipped.
 */
const NON_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT']);

/**
 * Functional HTTP interceptor that auto-attaches `Idempotency-Key:
 * <crypto.randomUUID()>` to non-idempotent requests (POST / PATCH / PUT).
 *
 * Pairs with ShipAPI's `idempotency()` middleware — the server caches
 * responses keyed by the same `Idempotency-Key` for 24 hours by default,
 * so retries replay the original response instead of re-executing the
 * mutation.
 *
 * Skipped:
 *
 * - Idempotent verbs (GET / HEAD / OPTIONS / DELETE).
 * - Requests that already carry an `Idempotency-Key` header (apps that
 *   manage their own keys for cross-session retry, e.g. payment intents,
 *   stay in control).
 * - Requests with `X-Skip-Idempotency: true` (the header is consumed —
 *   stripped before send).
 *
 * Register via `provideHttpClient(withInterceptors([authInterceptor,
 * idempotencyInterceptor]))`.
 *
 * **Caveat — Hono `hc()` calls bypass this interceptor.** Hono's typed
 * client uses raw `fetch` and does NOT pass through Angular's
 * HTTP_INTERCEPTORS. Use {@link withIdempotency} to wrap the `fetch`
 * passed to `hc({ fetch })` for the same behaviour.
 */
export const idempotencyInterceptor: HttpInterceptorFn = (req, next) => {
  if (!NON_IDEMPOTENT_METHODS.has(req.method)) {
    return next(req);
  }
  if (req.headers.get(SKIP_IDEMPOTENCY_HEADER)) {
    return next(req.clone({ headers: req.headers.delete(SKIP_IDEMPOTENCY_HEADER) }));
  }
  if (req.headers.has(IDEMPOTENCY_HEADER)) {
    return next(req);
  }
  const generate = inject(IDEMPOTENCY_KEY_GENERATOR);
  return next(
    req.clone({
      setHeaders: { [IDEMPOTENCY_HEADER]: generate() },
    })
  );
};

/**
 * Wrap a `fetch` implementation so Hono `hc()` calls also get
 * idempotency keys auto-attached.
 *
 * Use at the `hc()` call site:
 *
 * ```ts
 * import { hc } from '@sixthsummit/ship-api/client';
 * import { withIdempotency } from '@sixthsummit/ship-angular';
 *
 * export const api = hc<ShipApiClient>(env.apiBase, {
 *   init: { credentials: 'include' },
 *   fetch: withIdempotency(fetch),
 * });
 * ```
 *
 * Same rules as the interceptor: only POST / PATCH / PUT, skip when an
 * `Idempotency-Key` is already set, honour `X-Skip-Idempotency`.
 *
 * @param fetchImpl - The `fetch` to wrap (defaults to global `fetch`).
 * @param keyGenerator - Optional UUID generator override.
 */
export function withIdempotency(
  fetchImpl: typeof fetch = fetch,
  keyGenerator: () => string = () => crypto.randomUUID()
): typeof fetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (!NON_IDEMPOTENT_METHODS.has(method)) {
      return fetchImpl(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    if (headers.get(SKIP_IDEMPOTENCY_HEADER)) {
      headers.delete(SKIP_IDEMPOTENCY_HEADER);
      return fetchImpl(input, { ...init, headers });
    }
    if (headers.has(IDEMPOTENCY_HEADER)) {
      return fetchImpl(input, init);
    }
    headers.set(IDEMPOTENCY_HEADER, keyGenerator());
    return fetchImpl(input, { ...init, headers });
  };
}
