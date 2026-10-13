import { signal, type Signal } from '@angular/core';
import type {
  AuthAdapter,
  AuthAdapterCapabilities,
  AuthState,
  AuthUser,
} from '@sixthsummit/ship-angular';

/**
 * <%= name %> — application-owned identity-provider adapter.
 *
 * This deterministic in-memory implementation keeps the generated conformance test green.
 * Replace the marked provider calls with your SDK while preserving explicit capabilities,
 * state transitions, deferred initialization, and teardown.
 */
export class <%= name %> implements AuthAdapter {
  private readonly internal = signal<AuthState>({ status: 'unknown' });
  readonly state: Signal<AuthState> = this.internal.asReadonly();
  readonly capabilities: AuthAdapterCapabilities = {
    password: {
      signIn: (email, password) => this.signIn(email, password),
      register: (email, password) => this.register(email, password),
    },
    signOut: { signOut: () => this.signOut() },
    bearerToken: { getToken: forceRefresh => this.getToken(forceRefresh) },
  };

  /** Establish provider state here; construction must remain browser/SSR side-effect free. */
  readonly initialize = async (_signal?: AbortSignal): Promise<void> => {
    // TODO: await the provider's current-session probe.
    if (this.internal().status === 'unknown') this.internal.set({ status: 'unauthenticated' });
  };

  readonly destroy = (): void => {
    // TODO: unsubscribe the provider's identity listener.
  };

  private async signIn(email: string, _password: string): Promise<void> {
    // TODO: replace with the provider call and map only client-safe identity fields.
    this.internal.set({
      status: 'authenticated',
      user: this.toAuthUser({ id: `provider-${email}`, email }),
      idToken: 'replace-with-current-provider-token',
    });
  }

  private async register(email: string, password: string): Promise<void> {
    // TODO: replace with the provider's registration call.
    await this.signIn(email, password);
  }

  private async signOut(): Promise<void> {
    // TODO: await the provider sign-out call first.
    this.internal.set({ status: 'unauthenticated' });
  }

  private async getToken(_forceRefresh = false): Promise<string | null> {
    // TODO: resolve the provider's current token on every call; never capture it at bootstrap.
    const state = this.internal();
    return state.status === 'authenticated' ? state.idToken : null;
  }

  private toAuthUser(raw: {
    readonly id: string;
    readonly email?: string | null;
    readonly name?: string | null;
    readonly picture?: string | null;
  }): AuthUser {
    return {
      uid: raw.id,
      email: raw.email ?? null,
      displayName: raw.name ?? null,
      photoURL: raw.picture ?? null,
    };
  }
}
