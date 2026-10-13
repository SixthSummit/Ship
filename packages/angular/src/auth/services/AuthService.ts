import { isPlatformBrowser } from '@angular/common';
import {
  computed,
  Injectable,
  Injector,
  inject,
  PLATFORM_ID,
  type Signal,
  signal,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import type {
  AuthAdapter,
  AuthAdapterCapabilities,
  AuthCapabilityName,
  AuthState,
  AuthUser,
} from '../adapters/AuthAdapter';
import { AuthCapabilityUnavailableError } from './AuthCapabilityUnavailableError';

/**
 * Authentication service — the framework's signal-first auth surface.
 *
 * The service holds an {@link AuthAdapter} (the pluggable auth provider) and
 * exposes its reactive state to components, guards, and interceptors. The
 * adapter is configured at app bootstrap via {@link setAdapter}.
 *
 * @example
 * ```ts
 * // app.config.ts
 * provideAppInitializer(async () => {
 *   const auth = inject(AuthService);
 *   auth.setAdapter(new FirebaseAuthAdapter());
 *   await auth.initialize();
 * });
 *
 * // In a component
 * private auth = inject(AuthService);
 * isAuthed = this.auth.isAuthenticated;     // Signal<boolean>
 * user     = this.auth.user;                // Signal<AuthUser | null>
 *
 * // Imperative API
 * await this.auth.signIn(email, password);  // resolves after state is 'authenticated'
 * ```
 *
 * `state()`, `isAuthenticated()`, `isInitialized()`, and `user()` are
 * computed signals; callers read them as functions in templates or via
 * `effect()` / `computed()` in code.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly adapterSignal = signal<AuthAdapter | null>(null);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * The adapter's reactive state. `{ status: 'unknown' }` until an adapter is
   * registered AND the adapter has reported its first auth event.
   */
  readonly state: Signal<AuthState> = computed(() => {
    const adapter = this.adapterSignal();
    return adapter ? adapter.state() : { status: 'unknown' };
  });

  /** `true` once the adapter has reported its first auth event. */
  readonly isInitialized: Signal<boolean> = computed(() => this.state().status !== 'unknown');

  /** `true` when a user is signed in. */
  readonly isAuthenticated: Signal<boolean> = computed(
    () => this.state().status === 'authenticated'
  );

  /** The signed-in user, or `null` when unauthenticated / not yet initialized. */
  readonly user: Signal<AuthUser | null> = computed(() => {
    const s = this.state();
    return s.status === 'authenticated' ? s.user : null;
  });

  /**
   * The current ID token, or `null` when unauthenticated / not yet initialized.
   * Read by the `authInterceptor`. Updated whenever the adapter's state changes.
   */
  readonly idToken: Signal<string | null> = computed(() => {
    const s = this.state();
    return s.status === 'authenticated' ? s.idToken : null;
  });

  /** Reactive capability availability for conditionally rendering provider-specific actions. */
  readonly capabilities: Signal<Readonly<Record<AuthCapabilityName, boolean>>> = computed(() => {
    const capabilities = this.adapterSignal()?.capabilities;
    return {
      password: capabilities?.password !== undefined,
      signOut: capabilities?.signOut !== undefined,
      bearerToken: capabilities?.bearerToken !== undefined,
      emailLink: capabilities?.emailLink !== undefined,
      popup: capabilities?.popup !== undefined,
    };
  });

  /**
   * Register the adapter. Should be called exactly once during app bootstrap
   * (via `provideAppInitializer`).
   */
  setAdapter(adapter: AuthAdapter): void {
    this.adapterSignal.set(adapter);
  }

  private requireAdapter(): AuthAdapter {
    const adapter = this.adapterSignal();
    if (!adapter) {
      throw new Error('AuthService: no adapter configured. Call setAdapter() at bootstrap.');
    }
    return adapter;
  }

  private requireCapability<TKey extends AuthCapabilityName>(
    name: TKey
  ): NonNullable<AuthAdapterCapabilities[TKey]> {
    const capability = this.requireAdapter().capabilities[name];
    if (capability === undefined) throw new AuthCapabilityUnavailableError(name);
    return capability as NonNullable<AuthAdapterCapabilities[TKey]>;
  }

  /** Initialize adapters that need to establish identity from provider/server state. */
  initialize(signal?: AbortSignal): Promise<void> {
    const initialize = this.requireAdapter().initialize;
    return initialize === undefined ? Promise.resolve() : initialize(signal);
  }

  /**
   * Get the current ID token, refreshing if requested. Most callers should
   * read the {@link idToken} signal instead — that one tracks adapter updates
   * and is what the auth interceptor uses.
   */
  getIdToken(forceRefresh = false): Promise<string | null> {
    return (
      this.requireAdapter().capabilities.bearerToken?.getToken(forceRefresh) ??
      Promise.resolve(null)
    );
  }

  /**
   * Wait for the adapter to report its first auth event (i.e. for the state
   * to leave `'unknown'`). Useful in route guards and bootstrap flows where
   * you need to know the user's status before proceeding.
   */
  async waitForInitialization(): Promise<AuthState> {
    return firstValueFrom(
      toObservable(this.state, { injector: this.injector }).pipe(
        filter(s => s.status !== 'unknown')
      )
    );
  }

  /**
   * Sign in with email + password. Resolves once the auth state has
   * transitioned to `'authenticated'` (so callers can navigate immediately
   * without race conditions).
   */
  async signIn(email: string, password: string): Promise<AuthUser> {
    await this.requireCapability('password').signIn(email, password);
    return this.waitForAuthenticated();
  }

  /** Register a new user. Resolves once authenticated. */
  async register(email: string, password: string): Promise<AuthUser> {
    const register = this.requireCapability('password').register;
    if (register === undefined) throw new AuthCapabilityUnavailableError('password');
    await register(email, password);
    return this.waitForAuthenticated();
  }

  /**
   * Send a passwordless sign-in link to `email`. The link redirects the user
   * to `redirectUrl` (defaults to `${origin}/finishSignIn?email=...`).
   */
  async sendSignInLinkToEmail(email: string, redirectUrl?: string): Promise<void> {
    if (!email) throw new Error('AuthService: invalid email');
    if (!this.isBrowser) {
      throw new Error('AuthService.sendSignInLinkToEmail is only available in the browser.');
    }
    const url =
      redirectUrl ?? `${window.location.origin}/finishSignIn?email=${encodeURIComponent(email)}`;
    await this.requireCapability('emailLink').send(email, { url, handleCodeInApp: true });
    window.localStorage.setItem('emailForSignIn', email);
  }

  /**
   * Complete a passwordless sign-in. Pass the URL the user landed on after
   * clicking the email link.
   */
  async confirmSignIn(emailOrNull: string | null, url: string): Promise<AuthUser | null> {
    const emailLink = this.requireCapability('emailLink');
    if (!emailLink.recognizes(url)) return null;

    let email = emailOrNull ?? this.readStoredEmail();
    if (!email && this.isBrowser) {
      email = window.prompt('Please confirm your email to complete sign-in') ?? null;
    }
    if (!email) throw new Error('AuthService: invalid email for confirmSignIn');

    await emailLink.complete(email, url);
    this.clearStoredEmail();
    return this.waitForAuthenticated();
  }

  /** Sign in via OAuth popup. Adapter-defined `provider` shape. */
  async signInWithPopup(provider: unknown): Promise<AuthUser> {
    await this.requireCapability('popup').signIn(provider);
    return this.waitForAuthenticated();
  }

  /** Sign out and redirect (default: `/signin`). */
  async logout(redirectTo: string = '/signin'): Promise<void> {
    await this.requireCapability('signOut').signOut();
    await this.router.navigate([redirectTo]);
  }

  /** Sign out without navigating. */
  async signOut(): Promise<void> {
    await this.requireCapability('signOut').signOut();
  }

  private async waitForAuthenticated(): Promise<AuthUser> {
    const obs$ = toObservable(this.state, { injector: this.injector }).pipe(
      filter(s => s.status !== 'unknown')
    );
    const next = await firstValueFrom(obs$);
    if (next.status !== 'authenticated') {
      throw new Error('AuthService: auth state is not authenticated after operation.');
    }
    return next.user;
  }

  private readStoredEmail(): string | null {
    if (!this.isBrowser) return null;
    return window.localStorage.getItem('emailForSignIn');
  }

  private clearStoredEmail(): void {
    if (!this.isBrowser) return;
    window.localStorage.removeItem('emailForSignIn');
  }
}
