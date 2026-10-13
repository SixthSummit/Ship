---
name: add-auth-adapter
description: Use when the user asks to "add an auth adapter", "create a custom auth adapter", "wire up <provider> auth", "swap Firebase auth for X", "implement AuthAdapter for Y", or any request that maps to creating or replacing the AuthAdapter that backs the app's AuthService. The skill walks the AuthAdapter contract, the conformance suite that defines correctness, the signal-based state shape, and the SSR-safety invariants.
---

# Add a custom AuthAdapter to a ShipAngular app

`AuthService` is provider-agnostic — it talks to an `AuthAdapter` that abstracts the credential backend. ShipAngular ships two adapters out of the box:

- **`FirebaseAuthAdapter`** — Firebase modular SDK (`firebase/auth`).
- **`SessionAuthAdapter`** — cookie-session against ShipAPI v4 (`POST /auth/login` → `GET /auth/me`).

If neither fits, implement your own. The **conformance suite** in the framework's `testing` entrypoint (`@sixthsummit/ship-angular/testing`) is the authoritative contract — if your adapter passes `runConformance()`, it's correct.

## When to use this skill

- The user wants to use a credential provider neither shipped adapter covers (Auth0, Clerk, Cognito, custom OAuth, etc.).
- The user wants to fork `FirebaseAuthAdapter` or `SessionAuthAdapter` with project-specific changes.
- The user is composing a hybrid (e.g. Firebase auth + ShipAPI session sync).

## When NOT to use this skill

- The user can use `FirebaseAuthAdapter` or `SessionAuthAdapter` as-is — wire those instead (much less code, conformance already verified).
- The user wants a _role_ / _permission_ layer on top of auth — that's a separate concern; `AuthAdapter` is binary (signed in or not).
- The user wants SSO between subdomains — that's a cookie/CORS concern, not adapter-level.

## The contract

```typescript
import type { Signal } from '@angular/core';

interface AuthAdapter {
  readonly state: Signal<AuthState>;
  readonly idToken: Signal<string | null>;

  signIn(input: SignInInput): Promise<void>;
  signUp(input: SignUpInput): Promise<void>;
  signOut(): Promise<void>;
  sendPasswordResetEmail(email: string): Promise<void>;
  sendSignInLink(email: string, settings: SignInLinkSettings): Promise<void>;
  confirmSignInLink(email: string, link: string): Promise<void>;
  refreshIdToken(): Promise<string | null>;
}

type AuthState =
  { kind: 'unknown' } | { kind: 'authenticated'; user: AuthUser } | { kind: 'unauthenticated' };
```

### Invariants

1. **Start in `'unknown'`.** Never `'unauthenticated'` until the upstream provider reports its first event. Components rely on this to delay rendering until the truth is known.
2. **`state` is a `Signal`** — back it with `signal()` from `@angular/core` and expose `.asReadonly()`. Don't use `BehaviorSubject`.
3. **`idToken()` returns `null` for cookie-session flows** (no Bearer token to expose). `SessionAuthAdapter` does this.
4. **SSR safety**: don't touch `window`, `localStorage`, or `document` at module scope. Guard with `isPlatformBrowser()`. The framework runs SSR by default.
5. **Cleanup**: subscribe to provider events with `DestroyRef` (`inject(DestroyRef).onDestroy(...)`) so listeners drop on hot reload / test teardown.

## Authoring steps

1. **Create the adapter** under `src/app/auth/<provider>-auth-adapter.ts`:

   ```typescript
   import { DestroyRef, Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
   import { isPlatformBrowser } from '@angular/common';
   import type { AuthAdapter, AuthState, AuthUser } from '@sixthsummit/ship-angular';

   @Injectable({ providedIn: 'root' })
   export class MyProviderAuthAdapter implements AuthAdapter {
     private readonly platformId = inject(PLATFORM_ID);
     private readonly destroyRef = inject(DestroyRef);

     private readonly stateSignal = signal<AuthState>({ kind: 'unknown' });
     readonly state = this.stateSignal.asReadonly();

     private readonly tokenSignal = signal<string | null>(null);
     readonly idToken = this.tokenSignal.asReadonly();

     constructor() {
       if (!isPlatformBrowser(this.platformId)) {
         // SSR: stay in 'unknown' so guards don't render protected content.
         return;
       }
       const unsubscribe = this.subscribeToProvider();
       this.destroyRef.onDestroy(unsubscribe);
     }

     private subscribeToProvider(): () => void {
       // 1. Call the provider's auth-state listener.
       // 2. Map provider state → AuthState; set this.stateSignal.
       // 3. Map provider token → string | null; set this.tokenSignal.
       // 4. Return the unsubscribe function.
       return () => {};
     }

     async signIn(input: SignInInput): Promise<void> {
       /* ... */
     }
     async signUp(input: SignUpInput): Promise<void> {
       /* ... */
     }
     async signOut(): Promise<void> {
       /* ... */
     }
     async sendPasswordResetEmail(email: string): Promise<void> {
       /* ... */
     }
     async sendSignInLink(email: string, settings: SignInLinkSettings): Promise<void> {
       /* ... */
     }
     async confirmSignInLink(email: string, link: string): Promise<void> {
       /* ... */
     }
     async refreshIdToken(): Promise<string | null> {
       /* ... */
     }
   }
   ```

2. **Wire it into `app.config.ts`** via the `AUTH_ADAPTER` injection token:

   ```typescript
   import { AUTH_ADAPTER } from '@sixthsummit/ship-angular';
   import { MyProviderAuthAdapter } from './app/auth/my-provider-auth-adapter';

   export const appConfig: ApplicationConfig = {
     providers: [
       // ...
       { provide: AUTH_ADAPTER, useExisting: MyProviderAuthAdapter },
     ],
   };
   ```

3. **Write a conformance spec** under `src/app/auth/<provider>-auth-adapter.spec.ts`:

   ```typescript
   import { runConformance } from '@sixthsummit/ship-angular/testing';
   import { MyProviderAuthAdapter } from './my-provider-auth-adapter';

   runConformance(() => new MyProviderAuthAdapter(/* test config */));
   ```

   The suite covers: state initialization, sign-in lifecycle, sign-out, token refresh, SSR safety (no DOM access), and listener cleanup. If it passes, your adapter is correct by the framework's definition.

## Methods you can leave as no-ops

If your provider doesn't support a flow, throw a clear error rather than silently failing:

```typescript
async sendSignInLink(): Promise<void> {
  throw new Error('MyProviderAuthAdapter: email-link sign-in is not supported.');
}
```

The conformance suite will skip the test for the unsupported flow if you set a flag on the test config — read the suite source (`packages/core/src/auth/adapters/conformance.spec.ts` in the framework repo) for the exact opt-out shape.

## Verification

1. `pnpm test src/app/auth` → conformance spec passes.
2. `pnpm lint` → no warnings; the adapter file follows the framework conventions (signal-first, `inject()`, no `BehaviorSubject`).
3. `pnpm type-check` → clean.
4. Smoke in the browser: sign in, refresh the page, sign out, sign in again. `auth.state()` should never flicker through `'unauthenticated'` during a refresh of a signed-in session.
5. SSR smoke: `pnpm build:ssr && pnpm serve:ssr`, view source of `/dashboard` while signed out — the page should not render protected content (guards see `'unknown'` and hold).

## Common pitfalls

- **Starting in `'unauthenticated'`** — guards immediately redirect to `/signin` on first load before the provider has reported. Always start in `'unknown'`.
- **Synchronous DOM access in the constructor** — breaks SSR. Guard with `isPlatformBrowser()`.
- **Not unsubscribing on destroy** — leaks listeners across hot reloads; tests fail with stale state.
- **Returning `null` from `signIn()`** instead of throwing on failure — `AuthService.signIn()` won't know to surface the error to the UI.
- **Exposing `BehaviorSubject` for state** — fails the `no-rxjs-in-public-api` ESLint rule and breaks the contract.
- **Skipping the conformance suite** — you might pass type-check and lint but still violate the runtime contract. Run `runConformance()`.
