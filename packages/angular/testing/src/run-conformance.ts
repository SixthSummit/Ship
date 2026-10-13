import type { AuthAdapter } from '@sixthsummit/ship-angular';

/**
 * Test-runner-agnostic interface for the conformance suite. Vitest provides
 * a compatible global `describe` / `it` / `expect`; consumers using a
 * different framework can pass in their own bindings.
 */
export interface ConformanceContext {
  describe: (label: string, body: () => void) => void;
  it: (label: string, body: () => Promise<void> | void) => void;
  expect: (actual: unknown) => {
    toBe: (expected: unknown) => void;
    toBeNull: () => void;
    toBeTruthy: () => void;
    toBeFalsy: () => void;
    toEqual: (expected: unknown) => void;
  };
  beforeEach: (body: () => Promise<void> | void) => void;
}

declare const describe: ConformanceContext['describe'];
declare const it: ConformanceContext['it'];
declare const expect: ConformanceContext['expect'];
declare const beforeEach: ConformanceContext['beforeEach'];

/**
 * Run the {@link AuthAdapter} conformance suite against a factory.
 *
 * The suite verifies the contract every adapter must hold. It is the source
 * of truth — the TypeScript interface alone doesn't capture state-transition
 * invariants. New adapter implementations MUST pass this suite before being
 * shipped.
 *
 * The suite runs against a Vitest- or Jest-compatible global runner by
 * default. To run under a custom runner, pass a {@link ConformanceContext}.
 *
 * @example
 * ```ts
 * // packages/core/src/auth/adapters/conformance.spec.ts
 * import { runConformance, MockAuthAdapter } from '@sixthsummit/ship-angular/testing';
 *
 * runConformance(() => new MockAuthAdapter());
 * ```
 *
 * For provider-backed adapters that need real credentials (e.g. Firebase
 * with the emulator), the factory is responsible for setup/teardown.
 */
export function runConformance(makeAdapter: () => AuthAdapter, ctx?: ConformanceContext): void {
  const $describe = ctx?.describe ?? describe;
  const $it = ctx?.it ?? it;
  const $expect = ctx?.expect ?? expect;
  const $beforeEach = ctx?.beforeEach ?? beforeEach;

  $describe('AuthAdapter conformance', () => {
    let adapter: AuthAdapter;

    $beforeEach(() => {
      adapter = makeAdapter();
    });

    $describe('contract', () => {
      $it('exposes state as a callable signal', () => {
        $expect(typeof adapter.state).toBe('function');
        $expect(typeof adapter.state()).toBe('object');
      });

      $it('initializes state to { status: "unknown" }', () => {
        $expect(adapter.state().status).toBe('unknown');
      });

      $it('exposes valid shapes for every advertised capability', () => {
        $expect(typeof adapter.capabilities).toBe('object');
        if (adapter.capabilities.password !== undefined) {
          $expect(typeof adapter.capabilities.password.signIn).toBe('function');
          if (adapter.capabilities.password.register !== undefined) {
            $expect(typeof adapter.capabilities.password.register).toBe('function');
          }
        }
        if (adapter.capabilities.signOut !== undefined) {
          $expect(typeof adapter.capabilities.signOut.signOut).toBe('function');
        }
        if (adapter.capabilities.bearerToken !== undefined) {
          $expect(typeof adapter.capabilities.bearerToken.getToken).toBe('function');
        }
        if (adapter.capabilities.emailLink !== undefined) {
          $expect(typeof adapter.capabilities.emailLink.send).toBe('function');
          $expect(typeof adapter.capabilities.emailLink.complete).toBe('function');
          $expect(typeof adapter.capabilities.emailLink.recognizes).toBe('function');
        }
        if (adapter.capabilities.popup !== undefined) {
          $expect(typeof adapter.capabilities.popup.signIn).toBe('function');
        }
      });

      $it('isSignInWithEmailLink is synchronous', () => {
        // Should not return a Promise.
        if (adapter.capabilities.emailLink === undefined) return;
        const result = adapter.capabilities.emailLink.recognizes('https://example.test/');
        $expect(typeof result).toBe('boolean');
      });
    });

    $describe('lifecycle', () => {
      $it('signIn transitions state to "authenticated"', async () => {
        if (adapter.capabilities.password === undefined) return;
        await adapter.capabilities.password.signIn('conformance@test.local', 'password');
        const s = adapter.state();
        $expect(s.status).toBe('authenticated');
      });

      $it('signed-in state exposes a non-null user with the supplied email', async () => {
        if (adapter.capabilities.password === undefined) return;
        const email = 'conformance-user@test.local';
        await adapter.capabilities.password.signIn(email, 'password');
        const s = adapter.state();
        if (s.status !== 'authenticated') {
          throw new Error('expected authenticated state');
        }
        $expect(s.user.email).toBe(email);
        $expect(typeof s.user.uid).toBe('string');
      });

      $it('getIdToken returns a string when authenticated', async () => {
        if (
          adapter.capabilities.password === undefined ||
          adapter.capabilities.bearerToken === undefined
        ) {
          return;
        }
        await adapter.capabilities.password.signIn('token-user@test.local', 'password');
        const token = await adapter.capabilities.bearerToken.getToken();
        $expect(typeof token).toBe('string');
      });

      $it('signOut transitions state to "unauthenticated"', async () => {
        if (
          adapter.capabilities.password === undefined ||
          adapter.capabilities.signOut === undefined
        ) {
          return;
        }
        await adapter.capabilities.password.signIn('signout@test.local', 'password');
        await adapter.capabilities.signOut.signOut();
        $expect(adapter.state().status).toBe('unauthenticated');
      });

      $it('getIdToken returns null after signOut', async () => {
        if (
          adapter.capabilities.password === undefined ||
          adapter.capabilities.signOut === undefined ||
          adapter.capabilities.bearerToken === undefined
        ) {
          return;
        }
        await adapter.capabilities.password.signIn('post-signout@test.local', 'password');
        await adapter.capabilities.signOut.signOut();
        const token = await adapter.capabilities.bearerToken.getToken();
        $expect(token).toBeNull();
      });

      $it('register populates an authenticated state with the supplied email', async () => {
        if (adapter.capabilities.password?.register === undefined) return;
        const email = 'newuser@test.local';
        await adapter.capabilities.password.register(email, 'password');
        const s = adapter.state();
        if (s.status !== 'authenticated') {
          throw new Error('expected authenticated after register');
        }
        $expect(s.user.email).toBe(email);
      });
    });

    $describe('SSR safety', () => {
      $it('does not access window/document/localStorage at construction', () => {
        // If the factory called any browser-only API at construction, an SSR
        // build would throw. The conformance suite construction itself runs
        // in jsdom for vitest, but adapters that need browser globals must
        // defer them to method calls — never the constructor.
        // Smoke test: calling state() without any prior method calls works.
        $expect(adapter.state().status).toBe('unknown');
      });
    });
  });
}
