import { InvalidCredentialAuthDefinitionError } from "./errors.js";
import type { AuthAccount } from "./store.js";

export interface PasswordPolicy {
  /** Defaults to 12 (NIST SP 800-63B recommends length over composition rules). */
  readonly minLength: number;
  /** Defaults to 256; bounds hashing cost per attempt. */
  readonly maxLength: number;
}

export interface LockoutPolicy {
  /** Failed attempts inside `windowMs` that lock the account. Defaults to 5. */
  readonly threshold: number;
  /** Counting window. Defaults to 15 minutes. */
  readonly windowMs: number;
  /** How long the lock holds. Defaults to 15 minutes. */
  readonly durationMs: number;
}

export interface SessionPolicy {
  /** Absolute lifetime of a session. Defaults to 30 days. */
  readonly maxAgeMs: number;
  /** A session unused for this long expires. Defaults to 0 (disabled). */
  readonly idleTimeoutMs: number;
  /** How often `lastSeenAt` is written back. Defaults to 60 s. */
  readonly touchIntervalMs: number;
}

export interface MfaPolicy {
  /**
   * Whether this account must have TOTP enabled before a sign-in yields a
   * full session. `"never"`, `"always"` or a function of the account (for
   * example by role). An account that must enrol gets a `pending-enrolment`
   * session that only reaches the enrolment, sign-out and `me` operations.
   */
  readonly required: "never" | "always" | ((account: AuthAccount) => boolean);
  /** Issuer label in the otpauth URI. Defaults to the module id. */
  readonly issuer: string;
  /** How long a sign-in MFA challenge stays valid. Defaults to 5 minutes. */
  readonly challengeTtlMs: number;
  /** TOTP steps of drift accepted each way. Defaults to 1. */
  readonly window: number;
  readonly digits: number;
  readonly periodSeconds: number;
}

export interface TokenPolicy {
  /** Defaults to 24 hours. */
  readonly verifyEmailTtlMs: number;
  /** Defaults to 1 hour. */
  readonly resetPasswordTtlMs: number;
  /** Defaults to 1 hour. */
  readonly changeEmailTtlMs: number;
}

export interface RecoveryCodePolicy {
  /** Codes issued on enrolment. Defaults to 10. */
  readonly count: number;
}

export interface CredentialAuthPolicies {
  readonly password: PasswordPolicy;
  readonly lockout: LockoutPolicy;
  readonly session: SessionPolicy;
  readonly mfa: MfaPolicy;
  readonly tokens: TokenPolicy;
  readonly recoveryCodes: RecoveryCodePolicy;
  /** Whether sign-in requires a verified email. Defaults to true. */
  readonly requireVerifiedEmail: boolean;
  /**
   * What `register` answers when the email already has an account:
   * `"reject"` (409, the usable default) or `"conceal"` (201 with no new
   * account and no mail, so the endpoint cannot enumerate accounts).
   */
  readonly onExistingEmail: "reject" | "conceal";
}

/** Partial policies as the consumer writes them; nested objects are merged over the defaults. */
export interface CredentialAuthPolicyOptions {
  readonly password?: Partial<PasswordPolicy>;
  readonly lockout?: Partial<LockoutPolicy>;
  readonly session?: Partial<SessionPolicy>;
  readonly mfa?: Partial<MfaPolicy>;
  readonly tokens?: Partial<TokenPolicy>;
  readonly recoveryCodes?: Partial<RecoveryCodePolicy>;
  readonly requireVerifiedEmail?: boolean;
  readonly onExistingEmail?: "reject" | "conceal";
}

export const DEFAULT_CREDENTIAL_AUTH_POLICIES: Omit<CredentialAuthPolicies, "mfa"> & {
  readonly mfa: Omit<MfaPolicy, "issuer">;
} = Object.freeze({
  password: Object.freeze({ minLength: 12, maxLength: 256 }),
  lockout: Object.freeze({ threshold: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 }),
  session: Object.freeze({
    maxAgeMs: 30 * 24 * 60 * 60_000,
    idleTimeoutMs: 0,
    touchIntervalMs: 60_000,
  }),
  mfa: Object.freeze({
    required: "never" as const,
    challengeTtlMs: 5 * 60_000,
    window: 1,
    digits: 6,
    periodSeconds: 30,
  }),
  tokens: Object.freeze({
    verifyEmailTtlMs: 24 * 60 * 60_000,
    resetPasswordTtlMs: 60 * 60_000,
    changeEmailTtlMs: 60 * 60_000,
  }),
  recoveryCodes: Object.freeze({ count: 10 }),
  requireVerifiedEmail: true,
  onExistingEmail: "reject" as const,
});

export function resolvePolicies(
  options: CredentialAuthPolicyOptions | undefined,
  issuer: string,
): CredentialAuthPolicies {
  const defaults = DEFAULT_CREDENTIAL_AUTH_POLICIES;
  const policies: CredentialAuthPolicies = {
    password: { ...defaults.password, ...options?.password },
    lockout: { ...defaults.lockout, ...options?.lockout },
    session: { ...defaults.session, ...options?.session },
    mfa: { issuer, ...defaults.mfa, ...options?.mfa },
    tokens: { ...defaults.tokens, ...options?.tokens },
    recoveryCodes: { ...defaults.recoveryCodes, ...options?.recoveryCodes },
    requireVerifiedEmail: options?.requireVerifiedEmail ?? defaults.requireVerifiedEmail,
    onExistingEmail: options?.onExistingEmail ?? defaults.onExistingEmail,
  };
  assertPolicies(policies);
  return Object.freeze({
    password: Object.freeze(policies.password),
    lockout: Object.freeze(policies.lockout),
    session: Object.freeze(policies.session),
    mfa: Object.freeze(policies.mfa),
    tokens: Object.freeze(policies.tokens),
    recoveryCodes: Object.freeze(policies.recoveryCodes),
    requireVerifiedEmail: policies.requireVerifiedEmail,
    onExistingEmail: policies.onExistingEmail,
  });
}

export function mfaRequiredFor(policy: MfaPolicy, account: AuthAccount): boolean {
  if (policy.required === "always") return true;
  if (policy.required === "never") return false;
  return policy.required(account) === true;
}

function assertPolicies(policies: CredentialAuthPolicies): void {
  const integer = (field: string, value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new InvalidCredentialAuthDefinitionError(
        "SHIP_AUTH_POLICY_INVALID",
        `policy ${field} must be an integer between ${min} and ${max}; received ${JSON.stringify(value)}`,
        { field },
      );
    }
  };
  integer("password.minLength", policies.password.minLength, 8, 1024);
  integer("password.maxLength", policies.password.maxLength, policies.password.minLength, 1024);
  integer("lockout.threshold", policies.lockout.threshold, 1, 1000);
  integer("lockout.windowMs", policies.lockout.windowMs, 1000);
  integer("lockout.durationMs", policies.lockout.durationMs, 1000);
  integer("session.maxAgeMs", policies.session.maxAgeMs, 1000);
  integer("session.idleTimeoutMs", policies.session.idleTimeoutMs, 0);
  integer("session.touchIntervalMs", policies.session.touchIntervalMs, 0);
  integer("mfa.challengeTtlMs", policies.mfa.challengeTtlMs, 1000);
  integer("mfa.window", policies.mfa.window, 0, 10);
  integer("mfa.digits", policies.mfa.digits, 6, 8);
  integer("mfa.periodSeconds", policies.mfa.periodSeconds, 15, 120);
  integer("tokens.verifyEmailTtlMs", policies.tokens.verifyEmailTtlMs, 1000);
  integer("tokens.resetPasswordTtlMs", policies.tokens.resetPasswordTtlMs, 1000);
  integer("tokens.changeEmailTtlMs", policies.tokens.changeEmailTtlMs, 1000);
  integer("recoveryCodes.count", policies.recoveryCodes.count, 1, 50);
  const required = policies.mfa.required;
  if (required !== "never" && required !== "always" && typeof required !== "function") {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_POLICY_INVALID",
      'policy mfa.required must be "never", "always" or a function of the account',
      { field: "mfa.required" },
    );
  }
  if (typeof policies.mfa.issuer !== "string" || policies.mfa.issuer.trim().length === 0) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_POLICY_INVALID",
      "policy mfa.issuer must be a non-empty string",
      { field: "mfa.issuer" },
    );
  }
  if (policies.onExistingEmail !== "reject" && policies.onExistingEmail !== "conceal") {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_POLICY_INVALID",
      'policy onExistingEmail must be "reject" or "conceal"',
      { field: "onExistingEmail" },
    );
  }
  if (typeof policies.requireVerifiedEmail !== "boolean") {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_POLICY_INVALID",
      "policy requireVerifiedEmail must be a boolean",
      { field: "requireVerifiedEmail" },
    );
  }
}
