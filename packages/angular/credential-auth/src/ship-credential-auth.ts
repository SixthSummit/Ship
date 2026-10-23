import { computed, signal } from '@angular/core';
import type { CredentialCapability } from '@sixthsummit/ship-angular/operations';
import type {
  ShipCredentialAuthCallResult,
  ShipCredentialAuthClient,
} from './credential-auth-contract';
import type {
  CredentialAccount,
  CredentialAuthState,
  CredentialChallengePassed,
  CredentialFailure,
  CredentialMe,
  CredentialSessionToken,
  CredentialSessionView,
  CredentialSignInResult,
  CredentialTotpEnrolment,
} from './credential-auth-views';
import {
  type CredentialSessionTransport,
  cookieSessionStorage,
  type ShipCredentialSessionStorage,
} from './session-storage';

export const DEFAULT_CREDENTIAL_AUTH_PREFIX = 'auth';

export interface ShipCredentialAuthOptions {
  /** The operation client the application already provides (any `OperationClient`). */
  readonly client: ShipCredentialAuthClient | (() => ShipCredentialAuthClient);
  /** The auth module id the operations are namespaced by. Defaults to `auth`. */
  readonly prefix?: string;
  /**
   * How the session is kept. Defaults to {@link cookieSessionStorage}: the
   * server's `httpOnly` cookie, nothing in script's reach, reload-safe.
   * `memorySessionStorage()` or `browserSessionStorage()` select the bearer
   * transport for a native shell or a non-browser host.
   */
  readonly storage?: ShipCredentialSessionStorage;
}

/**
 * Signal-first client for one mounted credential-auth module: sign-in with
 * the MFA challenge and recovery steps, enrolment, sessions and the account
 * flows. Declared failures (a lockout, a wrong code, a rate limit) land in
 * `failure` as values so the screens render them inline. In cookie mode (the
 * default) the session token never reaches the client; in bearer mode it is
 * handed to the operation client through {@link ShipCredentialAuth.getToken}.
 * {@link ShipCredentialAuth.credential} is the matching capability for the
 * application's policy client either way.
 */
export class ShipCredentialAuth {
  private readonly clientFactory: () => ShipCredentialAuthClient;
  private readonly prefix: string;
  private readonly storage: ShipCredentialSessionStorage;
  /** How sessions travel for this client: `cookie` (the default) or `bearer`. */
  readonly transport: CredentialSessionTransport;
  private readonly inFlight = signal(0);
  private readonly lastFailure = signal<CredentialFailure | undefined>(undefined);
  private readonly internal = signal<CredentialAuthState>({ status: 'unknown' });
  private readonly sessionsState = signal<readonly CredentialSessionView[]>([]);
  private readonly recoveryCodesState = signal<readonly string[] | undefined>(undefined);

  readonly state = this.internal.asReadonly();
  readonly busy = computed(() => this.inFlight() > 0);
  readonly failure = this.lastFailure.asReadonly();
  readonly sessions = this.sessionsState.asReadonly();
  /** The codes `confirmTotp` returned; shown once, then cleared by the screen. */
  readonly recoveryCodes = this.recoveryCodesState.asReadonly();
  readonly account = computed<CredentialAccount | undefined>(() => {
    const state = this.internal();
    return state.status === 'signed-in' || state.status === 'enrolment-required'
      ? state.account
      : undefined;
  });
  readonly signedIn = computed(() => this.internal().status === 'signed-in');

  constructor(options: ShipCredentialAuthOptions) {
    const { client } = options;
    this.clientFactory = typeof client === 'function' ? client : () => client;
    this.prefix = options.prefix ?? DEFAULT_CREDENTIAL_AUTH_PREFIX;
    this.storage = options.storage ?? cookieSessionStorage();
    this.transport = this.storage.transport ?? 'bearer';
  }

  operationId(suffix: string): string {
    return `${this.prefix}.${suffix}`;
  }

  /** The current bearer, for a `BearerCredentialCapability` (`getToken`); always `null` in cookie mode. */
  async getToken(): Promise<string | null> {
    return this.transport === 'cookie' ? null : this.storage.read();
  }

  /**
   * The credential capability for the application's policy client: the
   * cookie capability (credentials included, CSRF cookie echoed) in cookie
   * mode, a bearer capability over {@link getToken} otherwise.
   */
  credential<TContract extends object>(): CredentialCapability<TContract> {
    const storage = this.storage;
    if (this.transport === 'cookie' && 'credential' in storage) {
      return (
        storage as { credential<T extends object>(): CredentialCapability<T> }
      ).credential<TContract>();
    }
    if (this.transport === 'cookie') return cookieSessionStorage().credential<TContract>();
    return { kind: 'bearer', getToken: () => this.getToken() };
  }

  clearFailure(): void {
    this.lastFailure.set(undefined);
  }

  clearRecoveryCodes(): void {
    this.recoveryCodesState.set(undefined);
  }

  /**
   * Establishes the state; construction never performs I/O. In cookie mode
   * `me` is always asked (the cookie is the browser's to send, and the
   * response also restores the CSRF cookie when it is missing); in bearer
   * mode only when a token is stored.
   */
  async initialize(): Promise<CredentialAuthState> {
    const token = this.transport === 'cookie' ? null : this.storage.read();
    if (this.transport === 'bearer' && token === null) {
      this.internal.set({ status: 'anonymous' });
      return this.internal();
    }
    const me = await this.call<CredentialMe>('me', {}, { silent: true });
    if (!me) {
      this.storage.write(null);
      this.internal.set({ status: 'anonymous' });
      return this.internal();
    }
    const session: CredentialSessionToken = {
      transport: this.transport,
      ...(token === null ? {} : { token }),
      id: me.session.id,
      expiresAt: me.session.expiresAt,
      mfaState: me.session.mfaState,
    };
    this.internal.set(
      me.session.mfaState === 'pending-enrolment'
        ? { status: 'enrolment-required', account: me.account, session }
        : { status: 'signed-in', account: me.account, session }
    );
    return this.internal();
  }

  async signIn(email: string, password: string): Promise<CredentialSignInResult | undefined> {
    const result = await this.call<CredentialSignInResult>('sign-in', {
      body: { email, password, ...this.transportInput() },
    });
    if (!result) return undefined;
    if (result.status === 'mfa-required') {
      this.internal.set({ status: 'challenged', challenge: result.challenge });
    } else {
      const session = this.keep(result.session);
      this.internal.set(
        result.status === 'mfa-enrolment-required'
          ? { status: 'enrolment-required', account: result.account, session }
          : { status: 'signed-in', account: result.account, session }
      );
    }
    return result;
  }

  /** Answers the pending challenge with a TOTP code. */
  async verifyTotp(code: string): Promise<CredentialChallengePassed | undefined> {
    return this.answerChallenge('totp.verify', code);
  }

  /** Answers the pending challenge with a recovery code. */
  async recover(code: string): Promise<CredentialChallengePassed | undefined> {
    return this.answerChallenge('recovery.consume', code);
  }

  async signOut(): Promise<void> {
    // The cookie is the server's to clear, so cookie mode always asks; bearer
    // mode only when a token is held. Either way the client ends anonymous.
    const signedIn =
      this.transport === 'cookie'
        ? this.internal().status !== 'anonymous'
        : this.storage.read() !== null;
    if (signedIn) await this.call('sign-out', {}, { silent: true });
    this.storage.write(null);
    this.sessionsState.set([]);
    this.internal.set({ status: 'anonymous' });
  }

  async register(email: string, password: string, name?: string): Promise<boolean> {
    const result = await this.call<{ status: string }>('register', {
      body: { email, password, ...(name === undefined ? {} : { name }) },
    });
    return result !== undefined;
  }

  async verifyEmail(token: string): Promise<boolean> {
    return (await this.call<{ verified: true }>('verify-email', { body: { token } })) !== undefined;
  }

  async resendVerification(email: string): Promise<boolean> {
    return (await this.call('resend-verification', { body: { email } })) !== undefined;
  }

  async forgotPassword(email: string): Promise<boolean> {
    return (await this.call('forgot-password', { body: { email } })) !== undefined;
  }

  async resetPassword(token: string, password: string): Promise<boolean> {
    return (await this.call('reset-password', { body: { token, password } })) !== undefined;
  }

  /**
   * Changes the password after re-entering the current one. The server
   * rotates the current session (a bearer client adopts the new token here;
   * a cookie client received it in `Set-Cookie`) and, unless
   * `signOutOtherSessions` is `false`, revokes every other session.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    signOutOtherSessions = true
  ): Promise<boolean> {
    const result = await this.call<{
      changed: true;
      revoked: number;
      session?: CredentialSessionToken;
    }>('change-password', { body: { currentPassword, newPassword, signOutOtherSessions } });
    if (!result) return false;
    const state = this.internal();
    if (result.session && (state.status === 'signed-in' || state.status === 'enrolment-required')) {
      this.internal.set({ ...state, session: this.keep(result.session) });
    }
    if (signOutOtherSessions)
      this.sessionsState.update(sessions => sessions.filter(session => session.current));
    return true;
  }

  async enrolTotp(password: string): Promise<CredentialTotpEnrolment | undefined> {
    return this.call<CredentialTotpEnrolment>('totp.enrol', { body: { password } });
  }

  async confirmTotp(code: string): Promise<readonly string[] | undefined> {
    const result = await this.call<{
      recoveryCodes: readonly string[];
      session?: CredentialSessionToken;
    }>('totp.confirm', { body: { code } });
    if (!result) return undefined;
    this.recoveryCodesState.set(result.recoveryCodes);
    const state = this.internal();
    if (state.status === 'enrolment-required' || state.status === 'signed-in') {
      // Enrolment may rotate the session (cookie mode); adopt the replacement.
      const session = result.session
        ? this.keep(result.session)
        : { ...state.session, mfaState: 'verified' as const };
      this.internal.set({
        status: 'signed-in',
        account: { ...state.account, mfaEnabled: true },
        session,
      });
    }
    return result.recoveryCodes;
  }

  async loadSessions(): Promise<readonly CredentialSessionView[] | undefined> {
    const result = await this.call<{ sessions: readonly CredentialSessionView[] }>(
      'sessions.list',
      {}
    );
    if (result) this.sessionsState.set(result.sessions);
    return result?.sessions;
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const result = await this.call<{ revoked: number }>('sessions.revoke', { body: { sessionId } });
    if (result)
      this.sessionsState.update(sessions => sessions.filter(session => session.id !== sessionId));
    return result !== undefined;
  }

  async revokeAllSessions(keepCurrent = true): Promise<number | undefined> {
    const result = await this.call<{ revoked: number }>('sessions.revoke-all', {
      body: { keepCurrent },
    });
    if (!result) return undefined;
    if (keepCurrent)
      this.sessionsState.update(sessions => sessions.filter(session => session.current));
    else await this.signOut();
    return result.revoked;
  }

  private async answerChallenge(
    suffix: string,
    code: string
  ): Promise<CredentialChallengePassed | undefined> {
    const state = this.internal();
    if (state.status !== 'challenged') return undefined;
    const result = await this.call<CredentialChallengePassed>(suffix, {
      body: { challenge: state.challenge.token, code, ...this.transportInput() },
    });
    if (!result) {
      const failure = this.lastFailure();
      // An expired or consumed challenge sends the person back to the password step.
      if (failure?.code === 'AUTH_TOKEN_INVALID') this.internal.set({ status: 'anonymous' });
      return undefined;
    }
    this.internal.set({
      status: 'signed-in',
      account: result.account,
      session: this.keep(result.session),
    });
    return result;
  }

  /** The `transport` a session-issuing call asks for; bearer mode sends nothing and takes the server default. */
  private transportInput(): { readonly transport?: 'cookie' } {
    return this.transport === 'cookie' ? { transport: 'cookie' } : {};
  }

  /**
   * Stores a bearer session's token and returns the session as the state
   * keeps it. In cookie mode the token, should a server ever send one, is
   * dropped on the floor: nothing in script holds it.
   */
  private keep(session: CredentialSessionToken): CredentialSessionToken {
    if (this.transport === 'cookie' || session.transport === 'cookie') {
      const { token: _token, ...rest } = session;
      return { ...rest, transport: 'cookie' };
    }
    if (session.token !== undefined) this.storage.write(session.token);
    return session;
  }

  private async call<TData>(
    suffix: string,
    input: unknown,
    options: { readonly silent?: boolean } = {}
  ): Promise<TData | undefined> {
    const operation = this.operationId(suffix);
    this.inFlight.update(count => count + 1);
    try {
      const result: ShipCredentialAuthCallResult = await this.clientFactory().call(
        operation,
        input
      );
      if (result.ok) {
        if (!options.silent) this.lastFailure.set(undefined);
        return result.data as TData;
      }
      if (!options.silent) this.lastFailure.set(failureOf(operation, result));
      return undefined;
    } finally {
      this.inFlight.update(count => count - 1);
    }
  }
}

function failureOf(
  operation: string,
  result: Extract<ShipCredentialAuthCallResult, { readonly ok: false }>
): CredentialFailure {
  const retryAfterMs = result.headers?.retryAfterMs;
  return {
    operation,
    status: result.status,
    code: result.error.code,
    message: result.error.message,
    ...(retryAfterMs !== undefined && retryAfterMs > 0
      ? { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }
      : {}),
  };
}
