import { z } from "zod";
import type { AuthAccount, AuthAuditEvent, AuthSession } from "./store.js";

const isoDate = z.string().min(1);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** Length limits only; the policy check runs in the handler so the failure is a declared one. */
export const passwordSchema = z.string().min(1).max(1024);
export const tokenSchema = z.string().min(1).max(128);
export const codeSchema = z.string().trim().min(1).max(64);

export const accountViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().optional(),
  status: z.enum(["active", "disabled"]),
  roles: z.array(z.string()),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: isoDate,
});

export type CredentialAccountView = z.infer<typeof accountViewSchema>;

export const sessionTokenSchema = z.object({
  /** The bearer the client presents as `Authorization: Bearer <token>`. */
  token: z.string(),
  id: z.string(),
  expiresAt: isoDate,
  mfaState: z.enum(["none", "pending-enrolment", "verified"]),
});

export const sessionViewSchema = z.object({
  id: z.string(),
  createdAt: isoDate,
  expiresAt: isoDate,
  lastSeenAt: isoDate,
  mfaState: z.enum(["none", "pending-enrolment", "verified"]),
  current: z.boolean(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
});

export type CredentialSessionView = z.infer<typeof sessionViewSchema>;

export const signInOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("signed-in"),
    session: sessionTokenSchema,
    account: accountViewSchema,
  }),
  z.object({
    status: z.literal("mfa-required"),
    challenge: z.object({ token: z.string(), expiresAt: isoDate }),
  }),
  z.object({
    status: z.literal("mfa-enrolment-required"),
    session: sessionTokenSchema,
    account: accountViewSchema,
  }),
]);

export type CredentialSignInOutput = z.infer<typeof signInOutputSchema>;

export const auditEventViewSchema = z.object({
  id: z.string(),
  event: z.string(),
  outcome: z.enum(["success", "failure"]),
  accountId: z.string().optional(),
  sessionId: z.string().optional(),
  requestId: z.string(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  createdAt: isoDate,
});

export type CredentialAuditEventView = z.infer<typeof auditEventViewSchema>;

export function accountView(account: AuthAccount, mfaEnabled: boolean): CredentialAccountView {
  return {
    id: account.id,
    email: account.email,
    ...(account.name !== undefined ? { name: account.name } : {}),
    status: account.status,
    roles: [...account.roles],
    emailVerified: account.emailVerifiedAt !== undefined,
    mfaEnabled,
    createdAt: account.createdAt.toISOString(),
  };
}

export function sessionView(
  session: AuthSession,
  currentSessionId?: string,
): CredentialSessionView {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    mfaState: session.mfaState,
    current: session.id === currentSessionId,
    ...(session.ip !== undefined ? { ip: session.ip } : {}),
    ...(session.userAgent !== undefined ? { userAgent: session.userAgent } : {}),
  };
}

export function auditEventView(event: AuthAuditEvent): CredentialAuditEventView {
  return {
    id: event.id,
    event: event.event,
    outcome: event.outcome,
    ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    requestId: event.requestId,
    ...(event.ip !== undefined ? { ip: event.ip } : {}),
    ...(event.userAgent !== undefined ? { userAgent: event.userAgent } : {}),
    ...(event.details ? { details: { ...event.details } } : {}),
    createdAt: event.createdAt.toISOString(),
  };
}
