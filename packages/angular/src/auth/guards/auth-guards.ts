import { isPlatformBrowser } from '@angular/common';
import { inject, PLATFORM_ID } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  Router,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { filter, first, map } from 'rxjs/operators';
import { AuthService } from '../services/AuthService';

/**
 * Functional `CanActivateFn` that requires the user to be authenticated.
 *
 * Waits for the auth state to leave `'unknown'` (i.e. for the adapter to
 * report its first event) before deciding. Unauthenticated users are
 * redirected to the route's `data.loginUrl` (default: `/signin`), with the
 * attempted URL preserved in `?returnUrl=`.
 *
 * @example
 * ```ts
 * { path: 'dashboard', canActivate: [authGuard], loadComponent: () => ... }
 * ```
 */
export const authGuard: CanActivateFn = (
  route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot
) => {
  // SSR: no auth adapter runs on the server, so state would stay 'unknown'
  // forever and deadlock server rendering. Render the page shell and let the
  // client re-run the guard after hydration — route DATA stays protected by
  // the API; only the unauthenticated shell is server-rendered.
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;

  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.state).pipe(
    filter(s => s.status !== 'unknown'),
    first(),
    map((s): boolean | UrlTree => {
      if (s.status === 'authenticated') return true;
      const redirectUrl = (route.data?.['loginUrl'] as string | undefined) ?? '/signin';
      return router.createUrlTree([redirectUrl], {
        queryParams: { returnUrl: state.url },
      });
    })
  );
};

/**
 * Functional `CanActivateFn` that requires the user to be NOT authenticated.
 *
 * Use on sign-in / register / public-only routes to bounce already-signed-in
 * users to `data.redirectUrl` (default: `/dashboard`).
 *
 * @example
 * ```ts
 * { path: 'signin', canActivate: [noAuthGuard], loadComponent: () => ... }
 * ```
 */
export const noAuthGuard: CanActivateFn = (route: ActivatedRouteSnapshot) => {
  // SSR: same deadlock avoidance as authGuard — see comment there.
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;

  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.state).pipe(
    filter(s => s.status !== 'unknown'),
    first(),
    map((s): boolean | UrlTree => {
      if (s.status !== 'authenticated') return true;
      const redirectUrl = (route.data?.['redirectUrl'] as string | undefined) ?? '/dashboard';
      return router.createUrlTree([redirectUrl]);
    })
  );
};
