import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Auth } from '@angular/fire/auth';
import type { User } from 'firebase/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseAuthAdapter } from './firebase-auth-adapter';

const firebase = vi.hoisted(() => ({
  createUser: vi.fn(),
  isEmailLink: vi.fn(),
  onAuthState: vi.fn(),
  onToken: vi.fn(),
  sendEmailLink: vi.fn(),
  signIn: vi.fn(),
  signInEmailLink: vi.fn(),
  signInPopup: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: firebase.createUser,
  isSignInWithEmailLink: firebase.isEmailLink,
  onAuthStateChanged: firebase.onAuthState,
  onIdTokenChanged: firebase.onToken,
  sendSignInLinkToEmail: firebase.sendEmailLink,
  signInWithEmailAndPassword: firebase.signIn,
  signInWithEmailLink: firebase.signInEmailLink,
  signInWithPopup: firebase.signInPopup,
  signOut: firebase.signOut,
}));

type UserListener = (user: User | null) => void | Promise<void>;
type ErrorListener = (error: Error) => void;

describe('FirebaseAuthAdapter', () => {
  let authListener: UserListener;
  let tokenListener: UserListener;
  let authError: ErrorListener;
  let tokenError: ErrorListener;
  let stopAuth: ReturnType<typeof vi.fn>;
  let stopToken: ReturnType<typeof vi.fn>;
  let auth: { currentUser: User | null };

  beforeEach(() => {
    vi.clearAllMocks();
    stopAuth = vi.fn();
    stopToken = vi.fn();
    auth = { currentUser: null };
    firebase.onAuthState.mockImplementation(
      (_auth, listener: UserListener, onError: ErrorListener) => {
        authListener = listener;
        authError = onError;
        return stopAuth;
      }
    );
    firebase.onToken.mockImplementation((_auth, listener: UserListener, onError: ErrorListener) => {
      tokenListener = listener;
      tokenError = onError;
      return stopToken;
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: Auth, useValue: auth }],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('defers provider I/O until initialize and maps current identity tokens', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('token-1');
    auth.currentUser = user;

    expect(firebase.onAuthState).not.toHaveBeenCalled();
    expect(firebase.onToken).not.toHaveBeenCalled();
    const initialized = adapter.initialize?.();
    await authListener(user);
    await initialized;
    expect(adapter.state()).toEqual({
      status: 'authenticated',
      user: {
        uid: 'user-1',
        email: 'user@example.com',
        displayName: 'User One',
        photoURL: null,
      },
      idToken: 'token-1',
    });
    expect(await adapter.capabilities.bearerToken.getToken(true)).toBe('token-1');
    expect(user.getIdToken).toHaveBeenLastCalledWith(true);

    user.getIdToken = vi.fn().mockResolvedValue('token-2');
    await tokenListener(user);
    expect(adapter.state()).toMatchObject({ status: 'authenticated', idToken: 'token-2' });

    auth.currentUser = null;
    await authListener(null);
    expect(adapter.state()).toEqual({ status: 'unauthenticated' });
  });

  it('delegates every advertised provider capability', async () => {
    firebase.isEmailLink.mockReturnValue(true);
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const settings = { url: 'https://app.example/finish', handleCodeInApp: true };
    const provider = { providerId: 'example' };

    await adapter.capabilities.password.signIn('user@example.com', 'secret');
    await adapter.capabilities.password.register?.('user@example.com', 'secret');
    await adapter.capabilities.emailLink.send('user@example.com', settings);
    await adapter.capabilities.emailLink.complete('user@example.com', settings.url);
    await adapter.capabilities.popup.signIn(provider);
    await adapter.capabilities.signOut.signOut();

    expect(firebase.signIn).toHaveBeenCalledWith(auth, 'user@example.com', 'secret');
    expect(firebase.createUser).toHaveBeenCalledWith(auth, 'user@example.com', 'secret');
    expect(firebase.sendEmailLink).toHaveBeenCalledWith(auth, 'user@example.com', settings);
    expect(firebase.signInEmailLink).toHaveBeenCalledWith(auth, 'user@example.com', settings.url);
    expect(firebase.isEmailLink(auth, settings.url)).toBe(true);
    expect(firebase.signInPopup).toHaveBeenCalledWith(auth, provider);
    expect(firebase.signOut).toHaveBeenCalledWith(auth);
  });

  it('unsubscribes both provider listeners when its injection scope is destroyed', () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    void adapter.initialize?.();
    TestBed.resetTestingModule();

    expect(stopAuth).toHaveBeenCalledOnce();
    expect(stopToken).toHaveBeenCalledOnce();
  });

  it('redacts provider failures into an indeterminate frontend state', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const initialized = adapter.initialize?.();

    authError(new Error('secret provider payload'));
    await initialized;

    expect(adapter.state()).toEqual({
      status: 'indeterminate',
      issue: {
        kind: 'provider',
        message: 'Firebase authentication state could not be established',
        retryable: true,
      },
      previousUser: undefined,
    });
    tokenError(new Error('secret token payload'));
    expect(JSON.stringify(adapter.state())).not.toContain('secret');
  });

  it('lets callers cancel their initialization wait', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const controller = new AbortController();
    const initialized = adapter.initialize?.(controller.signal);

    controller.abort();
    await expect(initialized).rejects.toMatchObject({ name: 'AbortError' });
    await authListener(null);
  });

  it('reuses initialization and refuses use after destruction', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const first = adapter.initialize?.();
    const second = adapter.initialize?.();

    await authListener(null);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    adapter.destroy?.();
    adapter.destroy?.();
    await expect(adapter.initialize?.()).rejects.toThrow('FirebaseAuthAdapter is destroyed');
    expect(stopAuth).toHaveBeenCalledOnce();
    expect(stopToken).toHaveBeenCalledOnce();
  });

  it('preserves the prior user when token refresh becomes indeterminate', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('token-1');
    auth.currentUser = user;
    const initialized = adapter.initialize?.();
    await authListener(user);
    await initialized;

    user.getIdToken = vi.fn().mockRejectedValue(new Error('provider secret'));
    await tokenListener(user);
    await vi.waitFor(() => {
      expect(adapter.state()).toMatchObject({
        status: 'indeterminate',
        issue: { message: 'Firebase identity token could not be refreshed' },
        previousUser: { uid: 'user-1' },
      });
    });
  });

  it('redacts an initial identity-token failure', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('unused');
    auth.currentUser = user;
    user.getIdToken = vi.fn().mockRejectedValue(new Error('provider secret'));
    const initialized = adapter.initialize?.();

    await authListener(user);
    await initialized;
    expect(adapter.state()).toMatchObject({
      status: 'indeterminate',
      issue: { message: 'Firebase identity token could not be read' },
    });
  });

  it('ignores obsolete token events and late events after destroy', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('token-1');
    void adapter.initialize?.();

    await tokenListener(null);
    await tokenListener(user);
    expect(adapter.state()).toEqual({ status: 'unauthenticated' });
    expect(await adapter.capabilities.bearerToken.getToken()).toBeNull();

    adapter.destroy?.();
    await authListener(user);
    tokenError(new Error('late provider error'));
    expect(adapter.state()).toEqual({ status: 'unauthenticated' });
  });

  it.each(['auth', 'token'] as const)(
    'discards pending %s success after sign-out',
    async source => {
      const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
      const user = firebaseUser('initial');
      auth.currentUser = user;
      const initialized = adapter.initialize();
      await authListener(user);
      await initialized;
      const pending = deferredToken();
      user.getIdToken = vi.fn().mockReturnValue(pending.promise);
      void (source === 'auth' ? authListener(user) : tokenListener(user));
      auth.currentUser = null;
      void tokenListener(null);
      void authListener(null);
      pending.resolve('late');
      await drainTokens();
      expect(adapter.state()).toEqual({ status: 'unauthenticated' });
    }
  );

  it.each(['auth', 'token'] as const)(
    'discards pending %s failure after sign-out',
    async source => {
      const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
      const user = firebaseUser('initial');
      auth.currentUser = user;
      const initialized = adapter.initialize();
      await authListener(user);
      await initialized;
      const pending = deferredToken();
      user.getIdToken = vi.fn().mockReturnValue(pending.promise);
      void (source === 'auth' ? authListener(user) : tokenListener(user));
      auth.currentUser = null;
      void tokenListener(null);
      void authListener(null);
      pending.reject(new Error('old provider failure'));
      await drainTokens();
      expect(adapter.state()).toEqual({ status: 'unauthenticated' });
    }
  );

  it.each(['different UID', 'same UID'])(
    'keeps the new session when an old token resolves after %s login',
    async identity => {
      const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
      const a = firebaseUser('A');
      auth.currentUser = a;
      const initialized = adapter.initialize();
      await authListener(a);
      await initialized;
      const pending = deferredToken();
      a.getIdToken = vi.fn().mockReturnValue(pending.promise);
      void tokenListener(a);
      auth.currentUser = null;
      void tokenListener(null);
      void authListener(null);
      const b = { ...firebaseUser('B'), uid: identity === 'same UID' ? a.uid : 'user-B' };
      auth.currentUser = b;
      void tokenListener(b);
      void authListener(b);
      await drainTokens();
      expect(adapter.state()).toMatchObject({ user: { uid: b.uid }, idToken: 'B' });
      pending.resolve('late-A');
      await drainTokens();
      expect(adapter.state()).toMatchObject({ user: { uid: b.uid }, idToken: 'B' });
    }
  );

  it.each(['auth-first', 'token-first'])(
    'settles initialization on the newest token with %s provider order',
    async order => {
      const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
      const user = firebaseUser('unused');
      auth.currentUser = user;
      const old = deferredToken();
      const latest = deferredToken();
      user.getIdToken = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(latest.promise);
      const initialized = adapter.initialize();
      if (order === 'auth-first') {
        void authListener(user);
        void tokenListener(user);
      } else {
        void tokenListener(user);
        void authListener(user);
      }
      latest.resolve('newest');
      await initialized;
      expect(adapter.state()).toMatchObject({ status: 'authenticated', idToken: 'newest' });
      old.resolve('old');
      await drainTokens();
      expect(adapter.state()).toMatchObject({ status: 'authenticated', idToken: 'newest' });
    }
  );

  it('does not settle initialization when obsolete work finishes before the newest read', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('unused');
    auth.currentUser = user;
    const old = deferredToken();
    const latest = deferredToken();
    user.getIdToken = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(latest.promise);
    let settled = false;
    const initialized = adapter.initialize().then(() => {
      settled = true;
    });
    void tokenListener(user);
    void authListener(user);
    old.resolve('old');
    await drainTokens();
    expect(settled).toBe(false);
    expect(adapter.state()).toEqual({ status: 'unknown' });
    latest.resolve('latest');
    await initialized;
    expect(adapter.state()).toMatchObject({ idToken: 'latest' });
  });

  it('rejects an obsolete SDK callback without replacing current identity', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const current = firebaseUser('current');
    auth.currentUser = current;
    const initialized = adapter.initialize();
    void tokenListener(current);
    void authListener(current);
    await initialized;
    const obsolete = { ...firebaseUser('obsolete'), uid: 'obsolete' };
    void authListener(obsolete);
    void tokenListener(obsolete);
    await drainTokens();
    expect(obsolete.getIdToken).not.toHaveBeenCalled();
    expect(adapter.state()).toMatchObject({ user: { uid: current.uid }, idToken: 'current' });
  });

  it('does not return an old bearer token across a same-UID session boundary', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('initial');
    auth.currentUser = user;
    const initialized = adapter.initialize();
    await authListener(user);
    await initialized;
    const pending = deferredToken();
    user.getIdToken = vi.fn().mockReturnValue(pending.promise);
    const token = adapter.capabilities.bearerToken.getToken();
    auth.currentUser = null;
    void tokenListener(null);
    void authListener(null);
    auth.currentUser = user;
    user.getIdToken = vi.fn().mockResolvedValue('new-session');
    void tokenListener(user);
    void authListener(user);
    await drainTokens();
    pending.resolve('old-session');
    expect(await token).toBeNull();
  });

  it('preserves an in-flight bearer read during normal same-session refresh', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('initial');
    auth.currentUser = user;
    const initialized = adapter.initialize();
    await authListener(user);
    await initialized;
    const pending = deferredToken();
    user.getIdToken = vi.fn().mockReturnValue(pending.promise);
    const token = adapter.capabilities.bearerToken.getToken(true);
    void tokenListener(user);
    pending.resolve('refreshed');
    expect(await token).toBe('refreshed');
  });

  it('ignores pending state and bearer work after destruction', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('initial');
    auth.currentUser = user;
    const initialized = adapter.initialize();
    await authListener(user);
    await initialized;
    const pending = deferredToken();
    user.getIdToken = vi.fn().mockReturnValue(pending.promise);
    void tokenListener(user);
    const token = adapter.capabilities.bearerToken.getToken();
    adapter.destroy();
    pending.resolve('late');
    expect(await token).toBeNull();
    await drainTokens();
    expect(adapter.state()).toMatchObject({ idToken: 'initial' });
  });

  it('ignores obsolete bearer failures but preserves current-session errors', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('initial');
    auth.currentUser = user;
    const initialized = adapter.initialize();
    await authListener(user);
    await initialized;
    const pending = deferredToken();
    user.getIdToken = vi.fn().mockReturnValue(pending.promise);
    const token = adapter.capabilities.bearerToken.getToken();
    auth.currentUser = null;
    void tokenListener(null);
    pending.reject(new Error('obsolete'));
    expect(await token).toBeNull();
    auth.currentUser = user;
    user.getIdToken = vi.fn().mockRejectedValue(new Error('current'));
    await expect(adapter.capabilities.bearerToken.getToken()).rejects.toThrow('current');
  });

  it('keeps newer refresh state when the older refresh fails last', async () => {
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    const user = firebaseUser('initial');
    auth.currentUser = user;
    const initialized = adapter.initialize();
    await authListener(user);
    await initialized;
    const old = deferredToken();
    user.getIdToken = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('newest');
    void tokenListener(user);
    void tokenListener(user);
    await drainTokens();
    old.reject(new Error('old failure'));
    await drainTokens();
    expect(adapter.state()).toMatchObject({ status: 'authenticated', idToken: 'newest' });
  });

  it('handles already-aborted and rejected initialization waits', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const adapter = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    await expect(adapter.initialize?.(aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    TestBed.resetTestingModule();
    firebase.onAuthState.mockImplementationOnce(() => {
      throw new Error('listener registration failed');
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: Auth, useValue: auth }],
    });
    const rejecting = TestBed.runInInjectionContext(() => new FirebaseAuthAdapter());
    await expect(rejecting.initialize?.(new AbortController().signal)).rejects.toThrow(
      'listener registration failed'
    );
  });
});

function firebaseUser(token: string): User {
  return {
    uid: 'user-1',
    email: 'user@example.com',
    displayName: 'User One',
    photoURL: null,
    getIdToken: vi.fn().mockResolvedValue(token),
  } as unknown as User;
}

function deferredToken() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function drainTokens(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
