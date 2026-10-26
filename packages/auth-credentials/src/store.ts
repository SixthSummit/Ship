import { type DependencyToken, dependency } from "@sixthsummit/ship-core";

export const CREDENTIAL_STORE_ID = "ship.auth-credentials.store";

export type AuthAccountStatus = "active" | "disabled";

/** An account row. Never carries a password hash or a secret. */
export interface AuthAccount {
  readonly id: string;
  /** Normalised (trimmed, lower-cased). */
  readonly email: string;
  readonly name?: string;
  readonly status: AuthAccountStatus;
  /** Application-defined role slugs the consumer maps to permissions. */
  readonly roles: readonly string[];
  readonly emailVerifiedAt?: Date;
  /** Failed sign-in or MFA attempts inside the current lockout window. */
  readonly failedAttempts: number;
  readonly lastFailedAt?: Date;
  readonly lockedUntil?: Date;
  /** Sessions created before this instant are invalid (revoke-all, password reset). */
  readonly sessionsInvalidBefore?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AuthAccountPatch {
  readonly email?: string;
  readonly name?: string | null;
  readonly status?: AuthAccountStatus;
  readonly roles?: readonly string[];
  readonly emailVerifiedAt?: Date | null;
  readonly failedAttempts?: number;
  readonly lastFailedAt?: Date | null;
  readonly lockedUntil?: Date | null;
  readonly sessionsInvalidBefore?: Date | null;
}

export interface AuthCredential {
  readonly accountId: string;
  readonly passwordHash: string;
  readonly algorithm: string;
  readonly updatedAt: Date;
}

export type AuthTokenPurpose = "verify-email" | "reset-password" | "change-email" | "mfa-challenge";

export interface AuthToken {
  readonly id: string;
  readonly accountId: string;
  readonly purpose: AuthTokenPurpose;
  /** SHA-256 of the token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly payload?: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
  readonly createdAt: Date;
}

export interface AuthMfaSecret {
  readonly accountId: string;
  /** The TOTP secret sealed by the secret box; `keyId` names the sealing key. */
  readonly secretCiphertext: string;
  readonly keyId: string;
  /** Unset while enrolment is pending confirmation. */
  readonly enabledAt?: Date;
  /** The last TOTP step a code was accepted for; replay guard. */
  readonly lastUsedStep?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AuthSessionMfaState = "none" | "pending-enrolment" | "verified";

export interface AuthSession {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly mfaState: AuthSessionMfaState;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt?: Date;
  readonly revokedReason?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export type AuthAuditOutcome = "success" | "failure";

export interface AuthAuditEvent {
  readonly id: string;
  readonly event: string;
  readonly outcome: AuthAuditOutcome;
  readonly accountId?: string;
  readonly sessionId?: string;
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Safe, non-secret context (reason codes, counts). Never a token, code or hash. */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: Date;
}

export interface AuthAuditQuery {
  readonly accountId?: string;
  readonly event?: string;
  readonly outcome?: AuthAuditOutcome;
  readonly before?: Date;
  readonly limit: number;
}

export type CreateAccountResult =
  | { readonly ok: true; readonly account: AuthAccount }
  | { readonly ok: false; readonly reason: "email-taken" };

/**
 * Everything the credential operations and the actor resolver persist. The
 * in-memory store proves the contract; `@sixthsummit/ship-auth-credentials/drizzle`
 * implements it over the package-owned PostgreSQL tables. Every mutation that
 * must not race (consuming a token, a recovery code or a TOTP step, revoking a
 * session) is a conditional write that reports whether it won.
 */
export interface CredentialStore {
  readonly kind: "ship.credential-store";
  readonly adapter: string;

  createAccount(input: {
    readonly email: string;
    readonly name?: string;
    readonly roles: readonly string[];
    readonly passwordHash: string;
    readonly algorithm: string;
    readonly emailVerifiedAt?: Date;
    readonly now: Date;
  }): Promise<CreateAccountResult>;
  findAccount(id: string): Promise<AuthAccount | undefined>;
  findAccountByEmail(email: string): Promise<AuthAccount | undefined>;
  /** Applies the patch and bumps `updatedAt`; email conflicts report `email-taken`. */
  updateAccount(
    id: string,
    patch: AuthAccountPatch,
    now: Date,
  ): Promise<
    | { readonly ok: true; readonly account: AuthAccount }
    | { readonly ok: false; readonly reason: "not-found" | "email-taken" }
  >;

  findCredential(accountId: string): Promise<AuthCredential | undefined>;
  setCredential(
    accountId: string,
    credential: { readonly passwordHash: string; readonly algorithm: string; readonly now: Date },
  ): Promise<void>;

  createToken(input: {
    readonly accountId: string;
    readonly purpose: AuthTokenPurpose;
    readonly tokenHash: string;
    readonly payload?: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<AuthToken>;
  /** The live (unconsumed, unexpired) token with this hash, without consuming it. */
  findToken(input: {
    readonly tokenHash: string;
    readonly purpose: AuthTokenPurpose;
    readonly now: Date;
  }): Promise<AuthToken | undefined>;
  /** Marks the live token consumed and returns it; `undefined` when unknown, expired or used. */
  consumeToken(input: {
    readonly tokenHash: string;
    readonly purpose: AuthTokenPurpose;
    readonly now: Date;
  }): Promise<AuthToken | undefined>;
  /** Invalidates every live token of one purpose for an account (a newer one supersedes). */
  revokeTokens(input: {
    readonly accountId: string;
    readonly purpose: AuthTokenPurpose;
    readonly now: Date;
  }): Promise<number>;

  findMfaSecret(accountId: string): Promise<AuthMfaSecret | undefined>;
  upsertMfaSecret(input: {
    readonly accountId: string;
    readonly secretCiphertext: string;
    readonly keyId: string;
    readonly enabledAt?: Date | null;
    readonly now: Date;
  }): Promise<AuthMfaSecret>;
  /** Records the accepted step only when it is newer than the last one; false means a replay lost. */
  claimMfaStep(accountId: string, step: number, now: Date): Promise<boolean>;
  deleteMfaSecret(accountId: string): Promise<void>;

  replaceRecoveryCodes(accountId: string, codeHashes: readonly string[], now: Date): Promise<void>;
  /** Marks one unused code used; false when unknown or already consumed. */
  consumeRecoveryCode(input: {
    readonly accountId: string;
    readonly codeHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  countRecoveryCodes(
    accountId: string,
  ): Promise<{ readonly remaining: number; readonly used: number }>;

  createSession(input: {
    readonly accountId: string;
    readonly tokenHash: string;
    readonly mfaState: AuthSessionMfaState;
    readonly expiresAt: Date;
    readonly ip?: string;
    readonly userAgent?: string;
    readonly now: Date;
  }): Promise<AuthSession>;
  findSession(id: string): Promise<AuthSession | undefined>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSession | undefined>;
  listSessions(
    accountId: string,
    options?: { readonly includeRevoked?: boolean },
  ): Promise<readonly AuthSession[]>;
  touchSession(id: string, now: Date): Promise<void>;
  updateSession(
    id: string,
    patch: { readonly mfaState?: AuthSessionMfaState; readonly expiresAt?: Date },
  ): Promise<AuthSession | undefined>;
  /** Revokes one live session; false when it is unknown or already revoked. */
  revokeSession(
    id: string,
    revocation: { readonly now: Date; readonly reason: string },
  ): Promise<boolean>;
  /** Revokes every live session of an account except `except`; returns how many. */
  revokeSessions(
    accountId: string,
    revocation: { readonly now: Date; readonly reason: string; readonly except?: string },
  ): Promise<number>;

  recordAudit(event: Omit<AuthAuditEvent, "id">): Promise<AuthAuditEvent>;
  listAudit(query: AuthAuditQuery): Promise<readonly AuthAuditEvent[]>;

  /** Deletes consumed or expired tokens and revoked or expired sessions older than `before`. */
  cleanup(options: {
    readonly before: Date;
  }): Promise<{ readonly tokens: number; readonly sessions: number }>;
}

/** The dependency token the operations and the console extension bind. */
export function credentialStoreDependency(): DependencyToken<CredentialStore> {
  return dependency<CredentialStore>(CREDENTIAL_STORE_ID);
}

export function isCredentialStore(value: unknown): value is CredentialStore {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.credential-store" &&
    typeof Reflect.get(value, "adapter") === "string" &&
    [
      "createAccount",
      "findAccount",
      "findAccountByEmail",
      "updateAccount",
      "findCredential",
      "setCredential",
      "createToken",
      "findToken",
      "consumeToken",
      "revokeTokens",
      "findMfaSecret",
      "upsertMfaSecret",
      "claimMfaStep",
      "deleteMfaSecret",
      "replaceRecoveryCodes",
      "consumeRecoveryCode",
      "countRecoveryCodes",
      "createSession",
      "findSession",
      "findSessionByTokenHash",
      "listSessions",
      "touchSession",
      "updateSession",
      "revokeSession",
      "revokeSessions",
      "recordAudit",
      "listAudit",
      "cleanup",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}

/** Lower-cases and trims an email the way every lookup and uniqueness check does. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
