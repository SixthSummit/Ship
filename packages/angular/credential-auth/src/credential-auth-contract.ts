import type {
  CredentialAccount,
  CredentialAuditEvent,
  CredentialChallengePassed,
  CredentialMe,
  CredentialSessionToken,
  CredentialSessionView,
  CredentialSignInResult,
  CredentialTotpEnrolment,
} from './credential-auth-views';

/** Framework codes the generated HTTP client adds to every operation. */
export type CredentialAuthFrameworkErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'INTERNAL_SERVER_ERROR'
  | 'AUTHENTICATION_UNAVAILABLE';

type SuccessResult<TSuccess extends object> = {
  readonly [TStatus in keyof TSuccess]: TStatus extends number
    ? { readonly ok: true; readonly status: TStatus; readonly data: TSuccess[TStatus] }
    : never;
}[keyof TSuccess];

type FailureResult<TCode extends string> = {
  readonly ok: false;
  readonly status: number;
  readonly error: { readonly code: TCode; readonly message: string };
};

/** One credential-auth operation in the canonical generated-contract shape. */
export interface CredentialAuthOperation<
  TInput,
  TSuccess extends object,
  TErrors extends string = CredentialAuthFrameworkErrorCode,
> {
  readonly transport: 'http';
  readonly input: TInput;
  readonly result:
    | SuccessResult<TSuccess>
    | FailureResult<TErrors | CredentialAuthFrameworkErrorCode>;
}

type NoInput = Record<string, never>;
type Accepted = { readonly 202: { readonly accepted: true } };
type Transport = { readonly transport?: 'bearer' | 'cookie' };
type Credentials = {
  readonly body: { readonly email: string; readonly password: string } & Transport;
};
type ChallengeInput = {
  readonly body: { readonly challenge: string; readonly code: string } & Transport;
};
type TokenInput = { readonly body: { readonly token: string } };

/**
 * The structural contract of `defineCredentialAuthModule()` mounted with the
 * default `auth` id. Type an operation client against it
 * (`OperationClient<ShipCredentialAuthContract>`) and pass it to
 * {@link provideShipCredentialAuth}; another module id uses `prefix` and the
 * untyped {@link ShipCredentialAuthClient}.
 */
export interface ShipCredentialAuthContract {
  readonly operations: {
    readonly 'auth.register': CredentialAuthOperation<
      {
        readonly body: {
          readonly email: string;
          readonly password: string;
          readonly name?: string;
        };
      },
      { readonly 201: { readonly status: 'verification-sent' } },
      'AUTH_EMAIL_TAKEN' | 'AUTH_PASSWORD_POLICY' | 'AUTH_MAIL_QUEUE_FULL' | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.verify-email': CredentialAuthOperation<
      TokenInput,
      { readonly 200: { readonly verified: true } },
      'AUTH_TOKEN_INVALID' | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.resend-verification': CredentialAuthOperation<
      { readonly body: { readonly email: string } },
      Accepted,
      'AUTH_MAIL_QUEUE_FULL' | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.sign-in': CredentialAuthOperation<
      Credentials,
      { readonly 200: CredentialSignInResult },
      | 'AUTH_INVALID_CREDENTIALS'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_ACCOUNT_DISABLED'
      | 'AUTH_EMAIL_UNVERIFIED'
      | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.sign-out': CredentialAuthOperation<
      NoInput,
      { readonly 200: { readonly signedOut: true } }
    >;
    readonly 'auth.me': CredentialAuthOperation<
      NoInput,
      { readonly 200: CredentialMe },
      'AUTH_ACCOUNT_DISABLED' | 'AUTH_SESSION_NOT_FOUND'
    >;
    readonly 'auth.sessions.list': CredentialAuthOperation<
      NoInput,
      { readonly 200: { readonly sessions: readonly CredentialSessionView[] } },
      'AUTH_ACCOUNT_DISABLED'
    >;
    readonly 'auth.sessions.revoke': CredentialAuthOperation<
      { readonly body: { readonly sessionId: string } },
      { readonly 200: { readonly revoked: number } },
      'AUTH_ACCOUNT_DISABLED' | 'AUTH_SESSION_NOT_FOUND'
    >;
    readonly 'auth.sessions.revoke-all': CredentialAuthOperation<
      { readonly body: { readonly keepCurrent?: boolean } },
      { readonly 200: { readonly revoked: number } },
      'AUTH_ACCOUNT_DISABLED'
    >;
    readonly 'auth.forgot-password': CredentialAuthOperation<
      { readonly body: { readonly email: string } },
      Accepted,
      'AUTH_MAIL_QUEUE_FULL' | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.reset-password': CredentialAuthOperation<
      { readonly body: { readonly token: string; readonly password: string } },
      { readonly 200: { readonly reset: true } },
      'AUTH_TOKEN_INVALID' | 'AUTH_PASSWORD_POLICY' | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.change-password': CredentialAuthOperation<
      {
        readonly body: {
          readonly currentPassword: string;
          readonly newPassword: string;
          readonly signOutOtherSessions?: boolean;
        };
      },
      {
        readonly 200: {
          readonly changed: true;
          readonly revoked: number;
          /** Whether the password-changed notice was queued for the account's address. */
          readonly notified: boolean;
          /** The rotated current session; the old token is revoked. */
          readonly session?: CredentialSessionToken;
        };
      },
      | 'AUTH_INVALID_CREDENTIALS'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_ACCOUNT_DISABLED'
      | 'AUTH_PASSWORD_POLICY'
    >;
    readonly 'auth.change-email': CredentialAuthOperation<
      { readonly body: { readonly password: string; readonly newEmail: string } },
      Accepted,
      | 'AUTH_INVALID_CREDENTIALS'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_ACCOUNT_DISABLED'
      | 'AUTH_EMAIL_TAKEN'
      | 'AUTH_MAIL_QUEUE_FULL'
    >;
    readonly 'auth.confirm-email-change': CredentialAuthOperation<
      TokenInput,
      { readonly 200: { readonly email: string } },
      'AUTH_TOKEN_INVALID' | 'AUTH_EMAIL_TAKEN' | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.totp.enrol': CredentialAuthOperation<
      { readonly body: { readonly password: string } },
      { readonly 200: CredentialTotpEnrolment },
      | 'AUTH_INVALID_CREDENTIALS'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_ACCOUNT_DISABLED'
      | 'AUTH_MFA_ALREADY_ENROLLED'
    >;
    readonly 'auth.totp.confirm': CredentialAuthOperation<
      { readonly body: { readonly code: string } },
      {
        readonly 200: {
          readonly recoveryCodes: readonly string[];
          /** The rotated session when enrolment replaced a cookie session. */
          readonly session?: CredentialSessionToken;
        };
      },
      | 'AUTH_MFA_INVALID_CODE'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_ACCOUNT_DISABLED'
      | 'AUTH_MFA_NOT_ENROLLED'
      | 'AUTH_MFA_ALREADY_ENROLLED'
    >;
    readonly 'auth.totp.verify': CredentialAuthOperation<
      ChallengeInput,
      { readonly 200: CredentialChallengePassed },
      | 'AUTH_TOKEN_INVALID'
      | 'AUTH_MFA_INVALID_CODE'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_MFA_NOT_ENROLLED'
      | 'AUTH_RATE_LIMITED'
    >;
    readonly 'auth.recovery.consume': CredentialAuthOperation<
      ChallengeInput,
      { readonly 200: CredentialChallengePassed },
      | 'AUTH_TOKEN_INVALID'
      | 'AUTH_RECOVERY_CODE_INVALID'
      | 'AUTH_ACCOUNT_LOCKED'
      | 'AUTH_RATE_LIMITED'
    >;
  };
}

/** The console auth-audit panel contract, for an `OperationClient` typed over the default mount. */
export interface ShipAuthAuditContract {
  readonly operations: {
    readonly 'console.auth-audit.events': CredentialAuthOperation<
      {
        readonly query: {
          readonly accountId?: string;
          readonly email?: string;
          readonly event?: string;
          readonly outcome?: 'success' | 'failure';
          readonly before?: string;
          readonly limit?: number;
        };
      },
      { readonly 200: { readonly events: readonly CredentialAuditEvent[] } },
      'AUTH_AUDIT_ACCOUNT_NOT_FOUND'
    >;
    readonly 'console.auth-audit.account': CredentialAuthOperation<
      { readonly query: { readonly accountId?: string; readonly email?: string } },
      {
        readonly 200: {
          readonly account: CredentialAccount;
          readonly locked: boolean;
          readonly lockedUntil?: string;
          readonly failedAttempts: number;
          readonly sessions: readonly CredentialSessionView[];
          readonly recoveryCodes: { readonly remaining: number; readonly used: number };
        };
      },
      'AUTH_AUDIT_ACCOUNT_NOT_FOUND'
    >;
    readonly 'console.auth-audit.revoke': CredentialAuthOperation<
      { readonly body: { readonly accountId: string; readonly sessionId?: string } },
      { readonly 200: { readonly revoked: number } },
      'AUTH_AUDIT_ACCOUNT_NOT_FOUND' | 'AUTH_SESSION_NOT_FOUND'
    >;
    readonly 'console.auth-audit.unlock': CredentialAuthOperation<
      { readonly body: { readonly accountId: string } },
      { readonly 200: { readonly unlocked: true } },
      'AUTH_AUDIT_ACCOUNT_NOT_FOUND'
    >;
    readonly 'console.auth-audit.status': CredentialAuthOperation<
      { readonly body: { readonly accountId: string; readonly status: 'active' | 'disabled' } },
      {
        readonly 200: { readonly status: 'active' | 'disabled'; readonly sessionsRevoked: number };
      },
      'AUTH_AUDIT_ACCOUNT_NOT_FOUND'
    >;
  };
}

/** The result shape the service reads from any operation client. */
export type ShipCredentialAuthCallResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly notModified?: boolean;
      readonly data?: unknown;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: { readonly code: string; readonly message: string };
      /** The operation client's response metadata; `retryAfterMs` comes from `Retry-After`. */
      readonly headers?: { readonly retryAfterMs?: number };
    };

/**
 * The minimal client the screens call. Every `OperationClient<TContract>`
 * from `@sixthsummit/ship-angular/operations` satisfies it structurally.
 */
export interface ShipCredentialAuthClient {
  call(operation: string, input: unknown): Promise<ShipCredentialAuthCallResult>;
}
