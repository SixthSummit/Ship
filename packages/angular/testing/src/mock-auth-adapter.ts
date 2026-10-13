import { type Signal, signal } from '@angular/core';
import type {
  AuthAdapter,
  AuthState,
  AuthUser,
  SignInLinkSettings,
} from '@sixthsummit/ship-angular';

/**
 * Construction options for {@link MockAuthAdapter}.
 */
export interface MockAuthAdapterOptions {
  /**
   * When set, the adapter transitions out of `'unknown'` automatically on a
   * microtask after construction. Useful for dev-mode and Playwright e2e
   * tests where guards need a deterministic non-`'unknown'` initial state.
   *
   * Default: `undefined` (stay in `'unknown'` until a method drives a
   * transition — matches the conformance suite's expectations).
   */
  initialStatus?: 'unauthenticated' | 'authenticated';
  /**
   * If `initialStatus === 'authenticated'`, the user shape to surface.
   * Defaults to a generic stub.
   */
  initialUser?: AuthUser;
}

/**
 * In-memory reference implementation of {@link AuthAdapter} for tests and
 * MSW-backed development. Exposes a small `__test` API for driving state
 * transitions deterministically.
 *
 * Used by the conformance suite as a known-good implementation; consumers
 * can also use it directly to test code paths that require an adapter
 * without standing up Firebase.
 *
 * @example
 * ```ts
 * // Conformance use (default — stays in 'unknown' until methods drive it):
 * const adapter = new MockAuthAdapter();
 *
 * // Dev/e2e use (auto-transition on microtask):
 * const adapter = new MockAuthAdapter({ initialStatus: 'unauthenticated' });
 * authService.setAdapter(adapter);
 * await adapter.signIn('a@b.test', 'pw'); // resolves with user populated
 * ```
 */
export class MockAuthAdapter implements AuthAdapter {
  private readonly internal = signal<AuthState>({ status: 'unknown' });
  readonly state: Signal<AuthState> = this.internal.asReadonly();
  readonly capabilities = {
    password: {
      signIn: (email: string, password: string) => this.signIn(email, password),
      register: (email: string, password: string) => this.register(email, password),
    },
    signOut: { signOut: () => this.signOut() },
    bearerToken: { getToken: (forceRefresh?: boolean) => this.getIdToken(forceRefresh) },
    emailLink: {
      send: (email: string, settings: SignInLinkSettings) =>
        this.sendSignInLinkToEmail(email, settings),
      complete: (email: string, url: string) => this.signInWithEmailLink(email, url),
      recognizes: (url: string) => this.isSignInWithEmailLink(url),
    },
    popup: { signIn: (provider: unknown) => this.signInWithPopup(provider) },
  };

  constructor(options: MockAuthAdapterOptions = {}) {
    if (options.initialStatus === 'unauthenticated') {
      queueMicrotask(() => {
        if (this.internal().status === 'unknown') {
          this.internal.set({ status: 'unauthenticated' });
        }
      });
    } else if (options.initialStatus === 'authenticated') {
      const user: AuthUser =
        options.initialUser ??
        ({
          uid: 'mock-initial',
          email: 'initial@mock.test',
          displayName: null,
          photoURL: null,
        } as AuthUser);
      queueMicrotask(() => {
        if (this.internal().status === 'unknown') {
          this.internal.set({ status: 'authenticated', user, idToken: 'mock-token' });
        }
      });
    }
  }

  /** Test hook for driving state transitions deterministically. */
  readonly __test = {
    transitionToUnauthenticated: (): void => {
      this.internal.set({ status: 'unauthenticated' });
    },
    transitionToAuthenticated: (user: AuthUser, idToken: string | null = 'mock-token'): void => {
      this.internal.set({ status: 'authenticated', user, idToken });
    },
    setIdToken: (idToken: string | null): void => {
      const s = this.internal();
      if (s.status === 'authenticated') {
        this.internal.set({ ...s, idToken });
      }
    },
  };

  async signIn(email: string, _password: string): Promise<void> {
    const user: AuthUser = {
      uid: `mock-${email}`,
      email,
      displayName: null,
      photoURL: null,
    };
    this.internal.set({ status: 'authenticated', user, idToken: 'mock-token' });
  }

  async register(email: string, password: string): Promise<void> {
    return this.signIn(email, password);
  }

  async signOut(): Promise<void> {
    this.internal.set({ status: 'unauthenticated' });
  }

  async getIdToken(_forceRefresh = false): Promise<string | null> {
    const s = this.internal();
    return s.status === 'authenticated' ? s.idToken : null;
  }

  async sendSignInLinkToEmail(_email: string, _settings: SignInLinkSettings): Promise<void> {
    /* no-op for the mock */
  }

  async signInWithEmailLink(email: string, _url: string): Promise<void> {
    return this.signIn(email, 'mock-link-password');
  }

  isSignInWithEmailLink(url: string): boolean {
    return url.includes('?mode=signIn') || url.includes('mockSignInLink=true');
  }

  async signInWithPopup(_provider: unknown): Promise<void> {
    return this.signIn('popup-user@mock.test', 'mock-popup-password');
  }
}
