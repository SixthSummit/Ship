import type { HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { AuthService } from '../../auth/services/AuthService';

/**
 * The set of API origins to which the auth interceptor will attach the
 * bearer token. Relative-URL requests always receive the token regardless
 * of this list (they go to the same origin as the app).
 *
 * Provide this token in your `app.config.ts` to allow attaching the token
 * to specific cross-origin APIs:
 *
 * ```ts
 * { provide: API_ORIGINS, useValue: ['https://api.example.com'] as const }
 * ```
 *
 * Default: `[]` (no cross-origin attachment). This is the safe default —
 * tokens leaking to a third-party host is a privilege-escalation bug.
 */
export const API_ORIGINS = new InjectionToken<readonly string[]>('SHIP_ANGULAR_API_ORIGINS', {
  factory: () => [],
});

/**
 * Functional HTTP interceptor that attaches the current ID token (from
 * {@link AuthService}) as a `Bearer` `Authorization` header.
 *
 * Reads `auth.idToken()` reactively per-request: the latest token from the
 * adapter is always used, so silent token refreshes don't require any
 * explicit plumbing.
 *
 * Attaches the token only to:
 *
 * - **Relative URLs** (same origin as the app), and
 * - **Cross-origin URLs** whose origin is listed in {@link API_ORIGINS}.
 *
 * Register via `provideHttpClient(withInterceptors([authInterceptor]))` —
 * see `provideShipAngular()` for the convenience wrapper.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const allowedOrigins = inject(API_ORIGINS);
  const token = auth.idToken();

  if (!token || !shouldAttachToken(req.url, allowedOrigins)) {
    return next(req);
  }

  return next(
    req.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
      withCredentials: true,
    })
  );
};

function shouldAttachToken(url: string, allowedOrigins: readonly string[]): boolean {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return true;
  try {
    const reqOrigin = new URL(url).origin;
    return allowedOrigins.includes(reqOrigin);
  } catch {
    return false;
  }
}
