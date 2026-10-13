import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAuthAdapter } from '../../../testing/src/mock-auth-adapter';
import { AuthService } from './AuthService';

describe('AuthService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  it('initial state is { status: "unknown" } and isInitialized is false', () => {
    const auth = TestBed.inject(AuthService);
    expect(auth.state().status).toBe('unknown');
    expect(auth.isInitialized()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.user()).toBeNull();
    expect(auth.idToken()).toBeNull();
  });

  it('throws when methods are called before setAdapter', async () => {
    const auth = TestBed.inject(AuthService);
    await expect(auth.signIn('a@b.test', 'pw')).rejects.toThrow(/no adapter configured/);
  });

  it('setAdapter routes the adapter signal into state', async () => {
    const auth = TestBed.inject(AuthService);
    const adapter = new MockAuthAdapter();
    auth.setAdapter(adapter);
    expect(auth.state().status).toBe('unknown');

    await adapter.signIn('user@test.local', 'pw');

    const s = auth.state();
    expect(s.status).toBe('authenticated');
    if (s.status === 'authenticated') {
      expect(s.user.email).toBe('user@test.local');
    }
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.user()?.email).toBe('user@test.local');
    expect(auth.idToken()).toBe('mock-token');
  });

  it('signIn waits for state to transition to authenticated', async () => {
    const auth = TestBed.inject(AuthService);
    const adapter = new MockAuthAdapter();
    auth.setAdapter(adapter);

    const user = await auth.signIn('user@test.local', 'pw');

    expect(user.email).toBe('user@test.local');
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('signOut transitions state to unauthenticated', async () => {
    const auth = TestBed.inject(AuthService);
    const adapter = new MockAuthAdapter();
    auth.setAdapter(adapter);
    await auth.signIn('user@test.local', 'pw');

    await auth.signOut();

    expect(auth.state().status).toBe('unauthenticated');
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.user()).toBeNull();
    expect(auth.idToken()).toBeNull();
  });

  it('logout signs out and navigates to /signin by default', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));

    await auth.logout();

    expect(navigateSpy).toHaveBeenCalledWith(['/signin']);
  });

  it('logout accepts a custom redirect', async () => {
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));

    await auth.logout('/');

    expect(navigateSpy).toHaveBeenCalledWith(['/']);
  });

  it('waitForInitialization resolves once state leaves "unknown"', async () => {
    const auth = TestBed.inject(AuthService);
    const adapter = new MockAuthAdapter({ initialStatus: 'unauthenticated' });
    auth.setAdapter(adapter);

    const result = await auth.waitForInitialization();

    expect(result.status).toBe('unauthenticated');
  });

  it('getIdToken delegates to the adapter', async () => {
    const auth = TestBed.inject(AuthService);
    const adapter = new MockAuthAdapter({ initialStatus: 'authenticated' });
    auth.setAdapter(adapter);
    // initialStatus auto-transitions on a microtask; let it settle.
    await auth.waitForInitialization();

    const token = await auth.getIdToken();

    expect(token).toBe('mock-token');
  });
});
