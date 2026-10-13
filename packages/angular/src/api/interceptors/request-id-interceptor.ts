import type { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject, REQUEST } from '@angular/core';

/**
 * Header name the framework attaches a request-id under. Standard de-facto
 * convention used by load balancers, OTel auto-instrumentation, and
 * ShipAPI's pino logger to correlate frontend↔backend logs.
 */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * UUID generator override for the request-id. Default: `crypto.randomUUID()`.
 */
export const REQUEST_ID_GENERATOR = new InjectionToken<() => string>(
  'SHIP_ANGULAR_REQUEST_ID_GENERATOR',
  { factory: () => () => crypto.randomUUID() }
);

/**
 * Functional HTTP interceptor that attaches `X-Request-ID` to outbound
 * requests for client↔server log correlation.
 *
 * Behaviour:
 *
 * - **Existing header preserved.** If the caller already set
 *   `X-Request-ID`, it's left untouched.
 * - **SSR aware.** During SSR, the interceptor reads the incoming
 *   {@link REQUEST}'s `X-Request-ID` header (if present, set by the
 *   load balancer / reverse proxy) and forwards it on outbound calls so
 *   server-rendered and browser-issued requests for the same render share
 *   a request-id. Falls back to a fresh UUID when the incoming request
 *   has none.
 * - **Browser fallback.** No SSR `Request` injected → generates a fresh
 *   UUID per outbound call.
 *
 * **Caveat — Hono `hc()` calls bypass this interceptor.** Use
 * {@link withRequestId} for the same behaviour on the `hc()` path.
 *
 * Register via `provideHttpClient(withInterceptors([requestIdInterceptor]))`.
 */
export const requestIdInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.headers.has(REQUEST_ID_HEADER)) {
    return next(req);
  }
  const ssrRequest = inject(REQUEST, { optional: true });
  const ssrId = ssrRequest?.headers.get(REQUEST_ID_HEADER) ?? null;
  const generate = inject(REQUEST_ID_GENERATOR);
  const id = ssrId ?? generate();
  return next(req.clone({ setHeaders: { [REQUEST_ID_HEADER]: id } }));
};

/**
 * Wrap a `fetch` implementation so Hono `hc()` calls also get
 * `X-Request-ID` auto-attached. Same rules as the interceptor: preserve
 * existing header, fall back to the generator.
 *
 * SSR forwarding is the caller's responsibility for `hc()` — pass
 * `init.headers['X-Request-ID']` from the SSR `Request` when building
 * the client.
 *
 * ```ts
 * import { withRequestId } from '@sixthsummit/ship-angular';
 * export const api = hc<ShipApiClient>(BASE, {
 *   init: { credentials: 'include' },
 *   fetch: withRequestId(fetch),
 * });
 * ```
 */
export function withRequestId(
  fetchImpl: typeof fetch = fetch,
  generator: () => string = () => crypto.randomUUID()
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    if (!headers.has(REQUEST_ID_HEADER)) {
      headers.set(REQUEST_ID_HEADER, generator());
    }
    return fetchImpl(input, { ...init, headers });
  };
}
