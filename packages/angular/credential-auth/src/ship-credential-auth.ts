import { computed, signal } from '@angular/core';
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
import { memorySessionStorage, type ShipCredentialSessionStorage } from './session-storage';

export const DEFAULT_CREDENTIAL_AUTH_PREFIX = 'auth';

export interface ShipCredentialAuthOptions {
  /** The operation client the application already provides (any `OperationClient`). */
  readonly client: ShipCredentialAuthClient | (() => ShipCredentialAuthClient);
  /** The auth module id the operations are namespaced by. Defaults to `auth`. */
  readonly prefix?: string;
  /** Where the bearer is kept. Defaults to memory. */
  readonly storage?: ShipCredentialSessionStorage;
}

/**
 * Signal-first client for one mounted credential-auth module: sign-in with
 * the MFA challenge and recovery steps, enrolment, sessions and the account
 * flows. Declared failures (a lockout, a wrong code, a rate limit) land in
 * `failure` as values so the screens render them inline; the session bearer
 * is handed to the operation client through {@link ShipCredentialAuth.getToken}.
 */
export class ShipCredentialAuth {
  private readonly clientFactory: () => ShipCredentialAuthClient;
  private readonly prefix: string;
  private readonly storage: ShipCredentialSessionStorage;
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
    this.storage = options.storage ?? memorySessionStorage();
  }

  operationId(suffix: string): string {
    return `${this.prefix}.${suffix}`;
  }

  /** The current bearer, for a `BearerCredentialCapability` (`getToken`). */
  async getToken(): Promise<string | null> {
    return this.storage.read();
  }

  clearFailure(): void {
    this.lastFailure.set(undefined);
  }

  clearRecoveryCodes(): void {
    this.recoveryCodesState.set(undefined);
  }

  /** Establishes the state from a stored bearer; construction never performs I/O. */
  async initialize(): Promise<CredentialAuthState> {
    const token = this.storage.read();
    if (token === null) {
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
      token,
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
      body: { email, password },
    });
    if (!result) return undefined;
    if (result.status === 'mfa-required') {
      this.internal.set({ status: 'challenged', challenge: result.challenge });
    } else {
      this.storage.write(result.session.token);
      this.internal.set(
        result.status === 'mfa-enrolment-required'
          ? { status: 'enrolment-required', account: result.account, session: result.session }
          : { status: 'signed-in', account: result.account, session: result.session }
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
    if (this.storage.read() !== null) await this.call('sign-out', {}, { silent: true });
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

  async enrolTotp(password: string): Promise<CredentialTotpEnrolment | undefined> {
    return this.call<CredentialTotpEnrolment>('totp.enrol', { body: { password } });
  }

  async confirmTotp(code: string): Promise<readonly string[] | undefined> {
    const result = await this.call<{ recoveryCodes: readonly string[] }>('totp.confirm', {
      body: { code },
    });
    if (!result) return undefined;
    this.recoveryCodesState.set(result.recoveryCodes);
    const state = this.internal();
    if (state.status === 'enrolment-required') {
      this.internal.set({
        status: 'signed-in',
        account: { ...state.account, mfaEnabled: true },
        session: { ...state.session, mfaState: 'verified' },
      });
    } else if (state.status === 'signed-in') {
      this.internal.set({
        ...state,
        account: { ...state.account, mfaEnabled: true },
        session: { ...state.session, mfaState: 'verified' },
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
      body: { challenge: state.challenge.token, code },
    });
    if (!result) {
      const failure = this.lastFailure();
      // An expired or consumed challenge sends the person back to the password step.
      if (failure?.code === 'AUTH_TOKEN_INVALID') this.internal.set({ status: 'anonymous' });
      return undefined;
    }
    this.storage.write(result.session.token);
    this.internal.set({ status: 'signed-in', account: result.account, session: result.session });
    return result;
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
