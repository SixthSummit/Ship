import { PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAuthAdapter } from '../../../testing/src/mock-auth-adapter';
import type { AuthAdapter, AuthState } from '../adapters/AuthAdapter';
import { AuthService } from './AuthService';

function configure(platformId: 'browser' | 'server' = 'browser'): AuthService {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: PLATFORM_ID, useValue: platformId },
    ],
  });
  return TestBed.inject(AuthService);
}

function installLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return storage;
}

describe('AuthService authentication flows', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    installLocalStorage();
    vi.restoreAllMocks();
  });

  it('forwards forceRefresh when requesting an ID token', async () => {
    const auth = configure();
    const adapter = new MockAuthAdapter();
    const getIdToken = vi.spyOn(adapter, 'getIdToken').mockResolvedValue('fresh-token');
    auth.setAdapter(adapter);

    await expect(auth.getIdToken(true)).resolves.toBe('fresh-token');
    expect(getIdToken).toHaveBeenCalledWith(true);
  });

  it('registers through the adapter and returns the authenticated user', async () => {
    const auth = configure();
    auth.setAdapter(new MockAuthAdapter());

    await expect(auth.register('new@example.test', 'secret')).resolves.toMatchObject({
      email: 'new@example.test',
    });
  });

  it('signs in with a popup and returns the authenticated user', async () => {
    const auth = configure();
    auth.setAdapter(new MockAuthAdapter());

    await expect(auth.signInWithPopup({ provider: 'test' })).resolves.toMatchObject({
      email: 'popup-user@mock.test',
    });
  });

  it('rejects when an adapter operation settles unauthenticated', async () => {
    const auth = configure();
    const adapter = new MockAuthAdapter();
    vi.spyOn(adapter, 'signIn').mockImplementation(async () => {
      adapter.__test.transitionToUnauthenticated();
    });
    auth.setAdapter(adapter);

    await expect(auth.signIn('user@example.test', 'secret')).rejects.toThrow(
      'auth state is not authenticated'
    );
  });

  it('advertises provider capabilities and rejects unavailable actions explicitly', async () => {
    const auth = configure();
    const state = signal<AuthState>({ status: 'unauthenticated' });
    const adapter: AuthAdapter = {
      state: state.asReadonly(),
      capabilities: {
        signOut: { signOut: async () => state.set({ status: 'unauthenticated' }) },
      },
    };
    auth.setAdapter(adapter);

    expect(auth.capabilities()).toEqual({
      password: false,
      signOut: true,
      bearerToken: false,
      emailLink: false,
      popup: false,
    });
    await expect(auth.signInWithPopup({})).rejects.toMatchObject({
      name: 'AuthCapabilityUnavailableError',
      capability: 'popup',
    });
    await expect(auth.signIn('a@example.test', 'secret')).rejects.toMatchObject({
      name: 'AuthCapabilityUnavailableError',
      capability: 'password',
    });
    await expect(auth.getIdToken()).resolves.toBeNull();
  });

  it('runs explicit adapter initialization with caller cancellation', async () => {
    const auth = configure();
    const initialize = vi.fn(async () => undefined);
    const adapter: AuthAdapter = {
      state: signal<AuthState>({ status: 'unknown' }).asReadonly(),
      capabilities: {},
      initialize,
    };
    const controller = new AbortController();
    auth.setAdapter(adapter);

    await auth.initialize(controller.signal);

    expect(initialize).toHaveBeenCalledWith(controller.signal);
  });

  it('allows adapters without initialization to initialize as a no-op', async () => {
    const auth = configure();
    auth.setAdapter({
      state: signal<AuthState>({ status: 'unauthenticated' }).asReadonly(),
      capabilities: {},
    });

    await expect(auth.initialize()).resolves.toBeUndefined();
  });
});

describe('AuthService passwordless flows', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    installLocalStorage();
    vi.restoreAllMocks();
  });

  it('rejects an empty email before invoking the adapter', async () => {
    const auth = configure();
    const adapter = new MockAuthAdapter();
    const sendLink = vi.spyOn(adapter, 'sendSignInLinkToEmail');
    auth.setAdapter(adapter);

    await expect(auth.sendSignInLinkToEmail('')).rejects.toThrow('invalid email');
    expect(sendLink).not.toHaveBeenCalled();
  });

  it('creates a browser redirect and stores the email for confirmation', async () => {
    const auth = configure();
    const adapter = new MockAuthAdapter();
    const sendLink = vi.spyOn(adapter, 'sendSignInLinkToEmail');
    auth.setAdapter(adapter);

    await auth.sendSignInLinkToEmail('person+tag@example.test');

    expect(sendLink).toHaveBeenCalledWith('person+tag@example.test', {
      url: `${window.location.origin}/finishSignIn?email=person%2Btag%40example.test`,
      handleCodeInApp: true,
    });
    expect(window.localStorage.getItem('emailForSignIn')).toBe('person+tag@example.test');
  });

  it('uses an explicit passwordless redirect unchanged', async () => {
    const auth = configure();
    const adapter = new MockAuthAdapter();
    const sendLink = vi.spyOn(adapter, 'sendSignInLinkToEmail');
    auth.setAdapter(adapter);

    await auth.sendSignInLinkToEmail('person@example.test', 'https://app.example.test/finish');

    expect(sendLink).toHaveBeenCalledWith('person@example.test', {
      url: 'https://app.example.test/finish',
      handleCodeInApp: true,
    });
  });

  it('rejects passwordless link creation during SSR', async () => {
    const auth = configure('server');
    auth.setAdapter(new MockAuthAdapter());

    await expect(auth.sendSignInLinkToEmail('person@example.test')).rejects.toThrow(
      'only available in the browser'
    );
  });

  it('returns null for a URL the adapter does not recognize', async () => {
    const auth = configure();
    auth.setAdapter(new MockAuthAdapter());

    await expect(
      auth.confirmSignIn('person@example.test', 'https://example.test/no-link')
    ).resolves.toBeNull();
  });

  it('uses and clears the stored email when confirming a link', async () => {
    const auth = configure();
    auth.setAdapter(new MockAuthAdapter());
    window.localStorage.setItem('emailForSignIn', 'stored@example.test');

    await expect(
      auth.confirmSignIn(null, 'https://example.test/?mode=signIn')
    ).resolves.toMatchObject({ email: 'stored@example.test' });
    expect(window.localStorage.getItem('emailForSignIn')).toBeNull();
  });

  it('prompts for an email when browser storage is empty', async () => {
    const auth = configure();
    auth.setAdapter(new MockAuthAdapter());
    vi.spyOn(window, 'prompt').mockReturnValue('prompted@example.test');

    await expect(
      auth.confirmSignIn(null, 'https://example.test/?mode=signIn')
    ).resolves.toMatchObject({ email: 'prompted@example.test' });
  });

  it('rejects confirmation when no email can be resolved', async () => {
    const auth = configure();
    auth.setAdapter(new MockAuthAdapter());
    vi.spyOn(window, 'prompt').mockReturnValue(null);

    await expect(auth.confirmSignIn(null, 'https://example.test/?mode=signIn')).rejects.toThrow(
      'invalid email for confirmSignIn'
    );
  });

  it('does not read browser storage or prompt during SSR', async () => {
    const auth = configure('server');
    auth.setAdapter(new MockAuthAdapter());
    const prompt = vi.spyOn(window, 'prompt');
    window.localStorage.setItem('emailForSignIn', 'browser-only@example.test');

    await expect(auth.confirmSignIn(null, 'https://example.test/?mode=signIn')).rejects.toThrow(
      'invalid email for confirmSignIn'
    );
    expect(prompt).not.toHaveBeenCalled();
  });
});
