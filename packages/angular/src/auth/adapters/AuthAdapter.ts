import type { Signal } from '@angular/core';

/**
 * A user authenticated by an {@link AuthAdapter}.
 *
 * The shape is intentionally minimal — adapters that surface richer claims
 * (roles, custom user fields, MFA factors) should expose those through their
 * own typed extensions, not by widening this interface.
 */
export interface AuthUser {
  uid: string;
  email: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}

/**
 * The reactive auth state surfaced by every {@link AuthAdapter}.
 *
 * Modeled as a discriminated union so consumers narrow on `status` and the
 * type system enforces the right fields are read in each branch:
 *
 * - `'unknown'` — initial state, before the adapter has reported its first
 *   auth event. Components should treat this as "loading"; do NOT assume the
 *   user is unauthenticated until the state transitions away from `'unknown'`.
 * - `'authenticated'` — a user is signed in. `user` and `idToken` are present.
 * - `'unauthenticated'` — no user is signed in.
 *
 * Adapters MUST initialize their state to `{ status: 'unknown' }` and only
 * transition to `'authenticated'` or `'unauthenticated'` after the underlying
 * auth provider has reported its first state.
 */
export type AuthState =
  | { readonly status: 'unknown' }
  | { readonly status: 'authenticated'; readonly user: AuthUser; readonly idToken: string | null }
  | { readonly status: 'unauthenticated' }
  | {
      readonly status: 'indeterminate';
      readonly issue: AuthStateIssue;
      readonly previousUser?: AuthUser;
    };

/** Safe reason why the current server-side authentication state could not be established. */
export interface AuthStateIssue {
  readonly kind: 'transport' | 'protocol' | 'provider' | 'operation';
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId?: string;
}

/**
 * Options for sending a passwordless sign-in link to an email.
 *
 * Mirrors Firebase's `ActionCodeSettings` for the fields used by the framework;
 * adapters that don't support passwordless flows can throw from the relevant
 * methods.
 */
export interface SignInLinkSettings {
  /** The URL the user is redirected to after clicking the email link. */
  url: string;
  /** Whether the link should be handled in the app rather than the browser. */
  handleCodeInApp: boolean;
}

/**
 * Authentication adapter — the framework's pluggable auth boundary.
 *
 * Every adapter exposes its current state as a {@link Signal} and provides
 * imperative methods for the sign-in flows. Adapters MUST pass the conformance
 * suite at `packages/core/testing` (importable as
 * `@sixthsummit/ship-angular/testing`) before being shipped.
 *
 * @example
 * ```ts
 * export class MyAuthAdapter implements AuthAdapter {
 *   private internal = signal<AuthState>({ status: 'unknown' });
 *   readonly state = this.internal.asReadonly();
 *
 *   async signIn(email: string, password: string): Promise<void> {
 *     // ... talk to your auth provider, then update `internal`.
 *   }
 *   // ... rest of the methods.
 * }
 * ```
 *
 * The optional `/firebase-auth` entrypoint provides the Firebase implementation.
 */
export interface PasswordAuthCapability {
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly register?: (email: string, password: string) => Promise<void>;
}

export interface SignOutAuthCapability {
  readonly signOut: () => Promise<void>;
}

export interface BearerTokenAuthCapability {
  readonly getToken: (forceRefresh?: boolean) => Promise<string | null>;
}

export interface EmailLinkAuthCapability {
  readonly send: (email: string, settings: SignInLinkSettings) => Promise<void>;
  readonly complete: (email: string, url: string) => Promise<void>;
  readonly recognizes: (url: string) => boolean;
}

export interface PopupAuthCapability {
  readonly signIn: (provider: unknown) => Promise<void>;
}

/** Optional provider actions are discoverable before an application renders or invokes them. */
export interface AuthAdapterCapabilities {
  readonly password?: PasswordAuthCapability;
  readonly signOut?: SignOutAuthCapability;
  readonly bearerToken?: BearerTokenAuthCapability;
  readonly emailLink?: EmailLinkAuthCapability;
  readonly popup?: PopupAuthCapability;
}

export type AuthCapabilityName = keyof AuthAdapterCapabilities;

export interface AuthAdapter {
  /**
   * Reactive auth state. Read by AuthService, components, guards, and
   * interceptors. Adapters update this signal in response to their underlying
   * auth provider's events.
   */
  readonly state: Signal<AuthState>;
  readonly capabilities: AuthAdapterCapabilities;
  /** Explicit initialization hook. No adapter should hide network I/O in its constructor. */
  readonly initialize?: (signal?: AbortSignal) => Promise<void>;
  readonly destroy?: () => void;
}
