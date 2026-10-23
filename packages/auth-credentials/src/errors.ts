import { operationError } from "@sixthsummit/ship-core";
import { z } from "zod";

/** Wrong email or password, or an account the policy refuses to say anything about. */
export const authInvalidCredentials = operationError({
  code: "AUTH_INVALID_CREDENTIALS",
  status: 401,
  message: "Email or password is incorrect",
});

/** Too many failed attempts; `Retry-After` carries the remaining lock in seconds. */
export const authAccountLocked = operationError({
  code: "AUTH_ACCOUNT_LOCKED",
  status: 423,
  message: "The account is temporarily locked after too many failed attempts",
  headers: ["Retry-After"] as const,
});

export const authAccountDisabled = operationError({
  code: "AUTH_ACCOUNT_DISABLED",
  status: 403,
  message: "The account is disabled",
});

export const authEmailUnverified = operationError({
  code: "AUTH_EMAIL_UNVERIFIED",
  status: 403,
  message: "Verify your email address before signing in",
});

export const authEmailTaken = operationError({
  code: "AUTH_EMAIL_TAKEN",
  status: 409,
  message: "An account with this email already exists",
});

/** The verification, reset, change-email or MFA challenge token is unknown, expired or already used. */
export const authTokenInvalid = operationError({
  code: "AUTH_TOKEN_INVALID",
  status: 400,
  message: "The token is invalid, expired or already used",
});

export const authPasswordPolicy = operationError({
  code: "AUTH_PASSWORD_POLICY",
  status: 422,
  message: "The password does not satisfy the password policy",
  details: z.object({ minLength: z.number().int(), maxLength: z.number().int() }),
});

export const authMfaInvalidCode = operationError({
  code: "AUTH_MFA_INVALID_CODE",
  status: 401,
  message: "The one-time code is incorrect, expired or already used",
});

export const authMfaNotEnrolled = operationError({
  code: "AUTH_MFA_NOT_ENROLLED",
  status: 409,
  message: "Two-factor authentication is not set up for this account",
});

export const authMfaAlreadyEnrolled = operationError({
  code: "AUTH_MFA_ALREADY_ENROLLED",
  status: 409,
  message: "Two-factor authentication is already enabled for this account",
});

export const authRecoveryCodeInvalid = operationError({
  code: "AUTH_RECOVERY_CODE_INVALID",
  status: 401,
  message: "The recovery code is incorrect or already used",
});

export const authSessionNotFound = operationError({
  code: "AUTH_SESSION_NOT_FOUND",
  status: 404,
  message: "No active session with that id belongs to this account",
});

/** Returned by the pre-validation rate-limit policy; `Retry-After` is in seconds. */
export const authRateLimited = operationError({
  code: "AUTH_RATE_LIMITED",
  status: 429,
  message: "Too many attempts; try again later",
  headers: ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining"] as const,
});

export const authMailQueueFull = operationError({
  code: "AUTH_MAIL_QUEUE_FULL",
  status: 503,
  message: "The mail queue refused the message; try again later",
});

/** The signed-in session has not completed the MFA step this account requires. */
export const authMfaRequired = operationError({
  code: "AUTH_MFA_REQUIRED",
  status: 403,
  message: "Set up two-factor authentication to continue",
});

export type CredentialAuthDiagnosticCode =
  | "SHIP_AUTH_OPTIONS_INVALID"
  | "SHIP_AUTH_POLICY_INVALID"
  | "SHIP_AUTH_STORE_INVALID"
  | "SHIP_AUTH_KEY_INVALID"
  | "SHIP_AUTH_MAILER_INVALID";

export class InvalidCredentialAuthDefinitionError extends Error {
  readonly code: CredentialAuthDiagnosticCode;
  readonly field?: string;

  constructor(
    code: CredentialAuthDiagnosticCode,
    message: string,
    options: { readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidCredentialAuthDefinitionError";
    this.code = code;
    this.field = options.field;
  }
}
