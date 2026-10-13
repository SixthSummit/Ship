import { HttpErrorResponse, type HttpEvent, type HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject, type Provider } from '@angular/core';
import { defer, Observable, throwError, timer } from 'rxjs';
import { catchError, retry } from 'rxjs/operators';
import { ApiError, parseRetryAfter, RateLimitError } from '../errors/ApiError';

/**
 * Configuration for the rate-limit interceptor.
 */
export interface RateLimitConfig {
  /**
   * Auto-retry 429 responses. When `true`, the interceptor delays for
   * `Retry-After` seconds (or `defaultBackoffMs` when missing) and re-issues
   * the request. Default: `false` (rethrow as `RateLimitError` for callers
   * to handle).
   */
  autoRetry?: boolean;
  /**
   * Maximum number of automatic retries. Default: `2`.
   * Ignored when `autoRetry` is `false`.
   */
  maxRetries?: number;
  /**
   * Fallback delay (ms) when the server's `Retry-After` header is missing
   * or 0 and `autoRetry` is enabled. Default: `1000`.
   */
  defaultBackoffMs?: number;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  autoRetry: false,
  maxRetries: 2,
  defaultBackoffMs: 1000,
};

/**
 * Injection token holding the resolved {@link RateLimitConfig}. Apps
 * shouldn't reach for this directly — use {@link provideRateLimit}.
 */
export const RATE_LIMIT_CONFIG = new InjectionToken<Required<RateLimitConfig>>(
  'SHIP_ANGULAR_RATE_LIMIT_CONFIG',
  { factory: () => DEFAULT_CONFIG }
);

/**
 * Configure the rate-limit interceptor. Without this provider, the
 * interceptor uses the default config (rethrow on 429, no auto-retry).
 *
 * ```ts
 * provideHttpClient(withInterceptors([rateLimitInterceptor])),
 * provideRateLimit({ autoRetry: true, maxRetries: 3 }),
 * ```
 */
export function provideRateLimit(config: RateLimitConfig): Provider {
  return {
    provide: RATE_LIMIT_CONFIG,
    useValue: { ...DEFAULT_CONFIG, ...config },
  };
}

/**
 * Functional HTTP interceptor that handles 429 Rate-Limit-Exceeded
 * responses. Default behaviour: rethrow as a typed
 * {@link RateLimitError} with `retryAfterSec` populated from the
 * `Retry-After` header. Opt-in auto-retry via {@link provideRateLimit}.
 *
 * Pairs with ShipAPI's `rateLimit()` middleware. Non-429 responses pass
 * through untouched.
 *
 * **Caveat — Hono `hc()` calls bypass this interceptor.** Use
 * {@link withRateLimit} to wrap `fetch` for the same behaviour on the
 * `hc()` path.
 *
 * Register via `provideHttpClient(withInterceptors([rateLimitInterceptor]))`.
 */
export const rateLimitInterceptor: HttpInterceptorFn = (req, next) => {
  const config = inject(RATE_LIMIT_CONFIG);

  const sourceFactory = () => next(req);
  const source$ = defer(sourceFactory);

  if (!config.autoRetry) {
    return source$.pipe(catchError((err: unknown) => mapRateLimitError(err)));
  }

  return source$.pipe(
    retry({
      count: config.maxRetries,
      delay: (err: unknown) => {
        if (!(err instanceof HttpErrorResponse) || err.status !== 429) {
          return throwError(() => err);
        }
        const retryAfterSec = parseRetryAfter(toFakeResponse(err));
        const delayMs = retryAfterSec > 0 ? retryAfterSec * 1000 : config.defaultBackoffMs;
        return timer(delayMs);
      },
    }),
    catchError((err: unknown) => mapRateLimitError(err))
  );
};

function mapRateLimitError(err: unknown): Observable<HttpEvent<unknown>> {
  if (err instanceof HttpErrorResponse && err.status === 429) {
    const fake = toFakeResponse(err);
    const body = err.error;
    if (ApiError.isEnvelope(body)) {
      return throwError(() => new RateLimitError(body, 429, parseRetryAfter(fake)));
    }
    return throwError(
      () =>
        new RateLimitError(
          {
            success: false,
            error: { code: 'RATE_LIMIT_EXCEEDED', message: err.statusText || 'Too many requests' },
          },
          429,
          parseRetryAfter(fake)
        )
    );
  }
  return throwError(() => err);
}

/**
 * Adapt an Angular `HttpErrorResponse` into a `Response`-shaped object
 * for `parseRetryAfter`. Only the `headers` accessor is used.
 */
function toFakeResponse(err: HttpErrorResponse): Response {
  const headers = new Headers();
  err.headers.keys().forEach(k => {
    const value = err.headers.get(k);
    if (value !== null) headers.set(k, value);
  });
  return new Response(null, { status: err.status, headers });
}

/**
 * Wrap a `fetch` implementation with rate-limit handling for Hono `hc()`
 * calls (which bypass Angular's HTTP_INTERCEPTORS). Same semantics as
 * {@link rateLimitInterceptor} — opt into auto-retry by passing config.
 *
 * ```ts
 * import { hc } from '@sixthsummit/ship-api/client';
 * import { withRateLimit } from '@sixthsummit/ship-angular';
 *
 * export const api = hc<ShipApiClient>(env.apiBase, {
 *   init: { credentials: 'include' },
 *   fetch: withRateLimit(fetch, { autoRetry: true, maxRetries: 2 }),
 * });
 * ```
 *
 * Auto-retry uses `Retry-After` from the response (or `defaultBackoffMs`
 * fallback). When auto-retry is exhausted or disabled, the wrapped fetch
 * resolves to the original 429 response — callers handle it via
 * {@link ApiError.fromResponse} (which constructs a {@link RateLimitError}).
 */
export function withRateLimit(
  fetchImpl: typeof fetch = fetch,
  config: RateLimitConfig = {}
): typeof fetch {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return async (input, init) => {
    let attempt = 0;
    while (true) {
      const res = await fetchImpl(input, init);
      if (res.status !== 429 || !cfg.autoRetry || attempt >= cfg.maxRetries) {
        return res;
      }
      const retryAfterSec = parseRetryAfter(res);
      const delayMs = retryAfterSec > 0 ? retryAfterSec * 1000 : cfg.defaultBackoffMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      attempt++;
    }
  };
}
