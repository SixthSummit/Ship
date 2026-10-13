import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockAuthAdapter } from '../../../testing/src/mock-auth-adapter';
import { AuthService } from '../services/AuthService';
import { authGuard, noAuthGuard } from './auth-guards';

function fakeRoute(data: Record<string, unknown> = {}): ActivatedRouteSnapshot {
  return { data } as unknown as ActivatedRouteSnapshot;
}

function fakeState(url = '/dashboard'): RouterStateSnapshot {
  return { url } as RouterStateSnapshot;
}

// Guards return Observable<boolean | UrlTree>. Run inside the testing
// injection context, then await the first emission.
async function runGuard(
  guard: (route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => unknown,
  route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot
): Promise<unknown> {
  const result = TestBed.runInInjectionContext(() => guard(route, state));
  if (result && typeof result === 'object' && 'subscribe' in result) {
    return await new Promise<unknown>(resolve => {
      let resolved = false;
      (result as { subscribe: (cb: (v: unknown) => void) => unknown }).subscribe(value => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      });
    });
  }
  return await Promise.resolve(result);
}

describe('authGuard', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  it('returns true when authenticated', async () => {
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));

    const result = await runGuard(authGuard, fakeRoute(), fakeState());

    expect(result).toBe(true);
  });

  it('returns a UrlTree to /signin with returnUrl when unauthenticated', async () => {
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'unauthenticated' }));

    const result = await runGuard(authGuard, fakeRoute(), fakeState('/dashboard'));

    expect(result).toBeInstanceOf(UrlTree);
    const url = String(result);
    expect(url).toMatch(/\/signin/);
    expect(url).toMatch(/returnUrl=%2Fdashboard/);
  });

  it('honors the route data.loginUrl override', async () => {
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'unauthenticated' }));

    const result = await runGuard(authGuard, fakeRoute({ loginUrl: '/login' }), fakeState());

    expect(result).toBeInstanceOf(UrlTree);
    expect(String(result)).toMatch(/\/login/);
  });
});

describe('noAuthGuard', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  it('returns true when unauthenticated', async () => {
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'unauthenticated' }));

    const result = await runGuard(noAuthGuard, fakeRoute(), fakeState('/signin'));

    expect(result).toBe(true);
  });

  it('redirects authenticated users to /dashboard', async () => {
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));

    const result = await runGuard(noAuthGuard, fakeRoute(), fakeState('/signin'));

    expect(result).toBeInstanceOf(UrlTree);
    expect(String(result)).toMatch(/\/dashboard/);
  });

  it('honors the route data.redirectUrl override', async () => {
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));

    const result = await runGuard(noAuthGuard, fakeRoute({ redirectUrl: '/billing' }), fakeState());

    expect(result).toBeInstanceOf(UrlTree);
    expect(String(result)).toMatch(/\/billing/);
  });
});

describe('guards on the server platform (SSR)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
  });

  it('authGuard returns true on the server even while state is unknown', () => {
    // No adapter is set — state stays 'unknown'. In the browser the guard
    // would wait; on the server that would deadlock SSR rendering, so the
    // guard must pass synchronously and let the client re-guard post-hydration.
    const result = TestBed.runInInjectionContext(() => authGuard(fakeRoute(), fakeState()));
    expect(result).toBe(true);
  });

  it('noAuthGuard returns true on the server even while state is unknown', () => {
    const result = TestBed.runInInjectionContext(() =>
      noAuthGuard(fakeRoute(), fakeState('/signin'))
    );
    expect(result).toBe(true);
  });
});
