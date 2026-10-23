/** Wire shapes of the `@sixthsummit/ship-auth-credentials` operations, as the Angular screens read them. */

export type CredentialSessionMfaState = 'none' | 'pending-enrolment' | 'verified';

export interface CredentialAccount {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly status: 'active' | 'disabled';
  readonly roles: readonly string[];
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly createdAt: string;
}

export interface CredentialSessionToken {
  readonly token: string;
  readonly id: string;
  readonly expiresAt: string;
  readonly mfaState: CredentialSessionMfaState;
}

export interface CredentialChallenge {
  readonly token: string;
  readonly expiresAt: string;
}

export type CredentialSignInResult =
  | {
      readonly status: 'signed-in';
      readonly session: CredentialSessionToken;
      readonly account: CredentialAccount;
    }
  | { readonly status: 'mfa-required'; readonly challenge: CredentialChallenge }
  | {
      readonly status: 'mfa-enrolment-required';
      readonly session: CredentialSessionToken;
      readonly account: CredentialAccount;
    };

export interface CredentialChallengePassed {
  readonly status: 'signed-in';
  readonly session: CredentialSessionToken;
  readonly account: CredentialAccount;
  readonly recoveryCodesRemaining?: number;
}

export interface CredentialSessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly mfaState: CredentialSessionMfaState;
  readonly current: boolean;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface CredentialMe {
  readonly account: CredentialAccount;
  readonly session: CredentialSessionView;
}

export interface CredentialTotpEnrolment {
  readonly secret: string;
  readonly otpauthUrl: string;
}

export interface CredentialAuditEvent {
  readonly id: string;
  readonly event: string;
  readonly outcome: 'success' | 'failure';
  readonly accountId?: string;
  readonly sessionId?: string;
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
}

/** A declared failure kept as a value: the screens render it inline. */
export interface CredentialFailure {
  readonly operation: string;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Seconds to wait, from `Retry-After`, for lockouts and rate limits. */
  readonly retryAfterSeconds?: number;
}

/** What the sign-in service knows about the current person. */
export type CredentialAuthState =
  | { readonly status: 'unknown' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'challenged'; readonly challenge: CredentialChallenge }
  | {
      readonly status: 'enrolment-required';
      readonly account: CredentialAccount;
      readonly session: CredentialSessionToken;
    }
  | {
      readonly status: 'signed-in';
      readonly account: CredentialAccount;
      readonly session: CredentialSessionToken;
    };
