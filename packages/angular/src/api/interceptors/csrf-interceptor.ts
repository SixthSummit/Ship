import type { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject, type Provider } from '@angular/core';

/**
 * CSRF stance configuration. Matches ShipAPI's `csrf({ doubleSubmit: true })`
 * middleware defaults (cookie name `ship_csrf`, header name `x-csrf-token`).
 */
export interface CsrfConfig {
  /** Cookie holding the CSRF token, set by the server. Default: `'ship_csrf'`. */
  cookieName?: string;
  /** Header the framework echoes the cookie into. Default: `'X-CSRF-Token'`. */
  headerName?: string;
}

const DEFAULT_CONFIG: Required<CsrfConfig> = {
  cookieName: 'ship_csrf',
  headerName: 'X-CSRF-Token',
};

/**
 * Injection token for CSRF interceptor configuration. Apps shouldn't
 * reach for this directly — use {@link provideCsrf}.
 */
export const CSRF_CONFIG = new InjectionToken<Required<CsrfConfig>>('SHIP_ANGULAR_CSRF_CONFIG', {
  factory: () => DEFAULT_CONFIG,
});

/**
 * Configure cookie and header names for CSRF token echoing.
 *
 * ```ts
 * provideHttpClient(withInterceptors([authInterceptor, csrfTokenInterceptor])),
 * provideCsrf({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
 * ```
 */
export function provideCsrf(config: CsrfConfig): Provider {
  return {
    provide: CSRF_CONFIG,
    useValue: { ...DEFAULT_CONFIG, ...config },
  };
}

const NEEDS_CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Functional HTTP interceptor that implements the **double-submit cookie**
 * pattern: reads the CSRF token from a cookie set by the server and echoes
 * it as a header on mutating requests.
 *
 * Required when ShipAPI runs `csrf({ doubleSubmit: true })`. Harmless when
 * ShipAPI runs in default mode (Origin-check only) — the server ignores
 * the echoed header.
 *
 * Behaviour:
 *
 * - Reads `document.cookie` to find the configured cookie. SSR-safe:
 *   no-op on the server (no `document`).
 * - Only applies to mutating methods (POST / PUT / PATCH / DELETE).
 * - Skips when the caller has already set the header (manual override).
 * - Skips silently when the cookie is missing (server hasn't issued one
 *   yet — the next safe request will set it). The mutation request will
 *   then fail server-side with 403; the next attempt will succeed.
 *
 * Register via `provideHttpClient(withInterceptors([csrfTokenInterceptor]))`.
 */
export const csrfTokenInterceptor: HttpInterceptorFn = (req, next) => {
  if (!NEEDS_CSRF_METHODS.has(req.method)) {
    return next(req);
  }
  const config = inject(CSRF_CONFIG);
  if (req.headers.has(config.headerName)) {
    return next(req);
  }
  const token = readCookie(config.cookieName);
  if (!token) {
    return next(req);
  }
  return next(
    req.clone({
      setHeaders: { [config.headerName]: token },
    })
  );
};

function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') {
    return null;
  }
  const prefix = `${name}=`;
  for (const pair of document.cookie.split(';')) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return null;
}

/**
 * Wrap a `fetch` implementation with CSRF token echoing for Hono `hc()`
 * calls (which bypass Angular's HTTP_INTERCEPTORS).
 *
 * Same rules as {@link csrfTokenInterceptor}: only mutating methods,
 * skip when header already set, no-op when cookie missing.
 *
 * ```ts
 * import { withCsrf } from '@sixthsummit/ship-angular';
 * export const api = hc<ShipApiClient>(BASE, {
 *   init: { credentials: 'include' },
 *   fetch: withCsrf(fetch),
 * });
 * ```
 */
export function withCsrf(fetchImpl: typeof fetch = fetch, config: CsrfConfig = {}): typeof fetch {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (!NEEDS_CSRF_METHODS.has(method)) {
      return fetchImpl(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    if (headers.has(cfg.headerName)) {
      return fetchImpl(input, init);
    }
    const token = readCookie(cfg.cookieName);
    if (!token) {
      return fetchImpl(input, init);
    }
    headers.set(cfg.headerName, token);
    return fetchImpl(input, { ...init, headers });
  };
}
