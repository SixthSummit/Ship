import type { DependencyToken, OperationIdentity } from "@sixthsummit/ship-core";
import { operationFailure } from "@sixthsummit/ship-core";
import type { MailSender } from "@sixthsummit/ship-mail";
import type { RequestClientRegistry } from "./client.js";
import {
  type CredentialSessionPolicy,
  type CredentialSessionTransport,
  clearSessionCookie,
  serializeSessionCookie,
} from "./cookie.js";
import type { PasswordHasher } from "./crypto/password.js";
import type { SecretBox } from "./crypto/secretbox.js";
import { generateToken, hashToken, SESSION_TOKEN_PREFIX } from "./crypto/tokens.js";
import { authAccountLocked, authMailQueueFull, authPasswordPolicy } from "./errors.js";
import type { CredentialAuthMailer, CredentialMailMessage } from "./mailer.js";
import type { CredentialAuthPolicies } from "./policy.js";
import type {
  AuthAccount,
  AuthAuditOutcome,
  AuthSession,
  AuthSessionMfaState,
  CredentialStore,
} from "./store.js";

export interface CredentialAuthLinks {
  readonly verifyEmail: (token: string) => string;
  readonly resetPassword: (token: string) => string;
  readonly changeEmail: (token: string) => string;
  /**
   * The sign-in page. Required while `onExistingEmail` is `"conceal"` (the
   * default): the notice sent to an address that already has an account
   * points here instead of revealing anything to the caller.
   */
  readonly signIn?: string;
}

/** The identity provider every credential session resolves with; its subject is the session id. */
export const CREDENTIAL_IDENTITY_PROVIDER = "ship-credentials.session";

/** What the operations share: configuration, crypto and the store token. */
export interface CredentialAuthRuntime {
  readonly id: string;
  readonly basePath: string;
  readonly store: DependencyToken<CredentialStore>;
  readonly mail: DependencyToken<unknown, MailSender>;
  readonly mailer: CredentialAuthMailer;
  readonly appName: string;
  readonly links: CredentialAuthLinks;
  readonly policies: CredentialAuthPolicies;
  /** Which transports a session may use and the cookie attributes when one of them is `cookie`. */
  readonly sessions: CredentialSessionPolicy;
  readonly hasher: PasswordHasher;
  readonly secrets: SecretBox;
  readonly defaultRoles: readonly string[];
  readonly clients: RequestClientRegistry | undefined;
  readonly clock: () => Date;
  /** A real hash verified when the email is unknown, so timing does not reveal account existence. */
  readonly decoyHash: Promise<string>;
}

export interface AuditInput {
  readonly event: string;
  readonly outcome: AuthAuditOutcome;
  readonly accountId?: string;
  readonly sessionId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export async function audit(
  runtime: CredentialAuthRuntime,
  store: CredentialStore,
  requestId: string,
  input: AuditInput,
): Promise<void> {
  const client = runtime.clients?.get(requestId);
  await store.recordAudit({
    event: input.event,
    outcome: input.outcome,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    requestId,
    ...(client?.ip !== undefined ? { ip: client.ip } : {}),
    ...(client?.userAgent !== undefined ? { userAgent: client.userAgent } : {}),
    ...(input.details ? { details: input.details } : {}),
    createdAt: runtime.clock(),
  });
}

export function assertPasswordPolicy(runtime: CredentialAuthRuntime, password: string): void {
  const { minLength, maxLength } = runtime.policies.password;
  if (password.length < minLength || password.length > maxLength) {
    throw operationFailure(authPasswordPolicy, { details: { minLength, maxLength } });
  }
}

export function lockRemainingSeconds(account: AuthAccount, now: Date): number | undefined {
  if (!account.lockedUntil || account.lockedUntil.getTime() <= now.getTime()) return undefined;
  return Math.max(1, Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 1000));
}

export function lockedFailure(remainingSeconds: number) {
  return operationFailure(authAccountLocked, {
    headers: { "Retry-After": String(remainingSeconds) },
  });
}

/**
 * Counts one failed attempt against the lockout policy. Returns the lock
 * engaged by this failure, if any. A lock that already lapsed resets the
 * counter ("lockout reset").
 */
export async function recordFailedAttempt(
  runtime: CredentialAuthRuntime,
  store: CredentialStore,
  account: AuthAccount,
  now: Date,
): Promise<{ readonly attempts: number; readonly lockedUntil?: Date }> {
  const { threshold, windowMs, durationMs } = runtime.policies.lockout;
  const inWindow =
    account.lastFailedAt !== undefined && now.getTime() - account.lastFailedAt.getTime() < windowMs;
  const lapsedLock =
    account.lockedUntil !== undefined && account.lockedUntil.getTime() <= now.getTime();
  const attempts = inWindow && !lapsedLock ? account.failedAttempts + 1 : 1;
  if (attempts >= threshold) {
    const lockedUntil = new Date(now.getTime() + durationMs);
    await store.updateAccount(
      account.id,
      { failedAttempts: 0, lastFailedAt: now, lockedUntil },
      now,
    );
    return { attempts, lockedUntil };
  }
  await store.updateAccount(
    account.id,
    { failedAttempts: attempts, lastFailedAt: now, ...(lapsedLock ? { lockedUntil: null } : {}) },
    now,
  );
  return { attempts };
}

export async function clearFailedAttempts(
  store: CredentialStore,
  account: AuthAccount,
  now: Date,
): Promise<void> {
  if (account.failedAttempts === 0 && !account.lockedUntil && !account.lastFailedAt) return;
  await store.updateAccount(
    account.id,
    { failedAttempts: 0, lastFailedAt: null, lockedUntil: null },
    now,
  );
}

export interface IssuedSession {
  readonly token: string;
  readonly session: AuthSession;
}

export async function issueSession(
  runtime: CredentialAuthRuntime,
  store: CredentialStore,
  account: AuthAccount,
  mfaState: AuthSessionMfaState,
  requestId: string,
  now: Date,
): Promise<IssuedSession> {
  const token = generateToken(SESSION_TOKEN_PREFIX);
  const client = runtime.clients?.get(requestId);
  const session = await store.createSession({
    accountId: account.id,
    tokenHash: hashToken(token),
    mfaState,
    expiresAt: new Date(now.getTime() + runtime.policies.session.maxAgeMs),
    ...(client?.ip !== undefined ? { ip: client.ip } : {}),
    ...(client?.userAgent !== undefined ? { userAgent: client.userAgent } : {}),
    now,
  });
  return { token, session };
}

/**
 * The session as the client sees it. A `cookie` session carries no token: the
 * response headers from {@link sessionCookieHeaders} install it instead.
 */
export function sessionTokenView(issued: IssuedSession, transport: CredentialSessionTransport) {
  return {
    transport,
    ...(transport === "bearer" ? { token: issued.token } : {}),
    id: issued.session.id,
    expiresAt: issued.session.expiresAt.toISOString(),
    mfaState: issued.session.mfaState,
  };
}

/** The transport a sign-in uses: the one it asked for, else the module's default. */
export function resolveTransport(
  runtime: CredentialAuthRuntime,
  requested: CredentialSessionTransport | undefined,
): CredentialSessionTransport {
  if (requested !== undefined && runtime.sessions.transports.includes(requested)) return requested;
  return runtime.sessions.defaultTransport;
}

/** How the current request authenticated, as the resolver recorded it; `undefined` off HTTP or when anonymous. */
export function requestTransport(
  runtime: CredentialAuthRuntime,
  requestId: string,
): CredentialSessionTransport | undefined {
  return runtime.clients?.get(requestId)?.sessionTransport;
}

/** `Set-Cookie` headers that install a freshly issued cookie session; `undefined` for a bearer one. */
export function sessionCookieHeaders(
  runtime: CredentialAuthRuntime,
  issued: IssuedSession,
  transport: CredentialSessionTransport,
  now: Date,
): Readonly<Record<string, string>> | undefined {
  const cookie = runtime.sessions.cookie;
  if (transport !== "cookie" || !cookie) return undefined;
  const maxAgeSeconds = Math.ceil((issued.session.expiresAt.getTime() - now.getTime()) / 1000);
  return { "set-cookie": serializeSessionCookie(cookie, issued.token, maxAgeSeconds) };
}

/** `Set-Cookie` headers that remove the session cookie when the current request authenticated through it. */
export function clearSessionCookieHeaders(
  runtime: CredentialAuthRuntime,
  requestId: string,
): Readonly<Record<string, string>> | undefined {
  const cookie = runtime.sessions.cookie;
  if (!cookie || requestTransport(runtime, requestId) !== "cookie") return undefined;
  return { "set-cookie": clearSessionCookie(cookie) };
}

export async function sendCredentialMail(
  runtime: CredentialAuthRuntime,
  mail: MailSender,
  message: CredentialMailMessage,
  input: { readonly to: string; readonly url: string; readonly idempotencyKey: string },
): Promise<void> {
  const sent = await mail.send(runtime.mailer, message, {
    to: input.to,
    payload: { email: input.to, url: input.url, appName: runtime.appName },
    idempotencyKey: input.idempotencyKey,
  });
  if (!sent.accepted) throw operationFailure(authMailQueueFull);
}

/** The session id behind the current request, when the actor came from a credential session. */
export function currentSessionId(identity: OperationIdentity | undefined): string | undefined {
  return identity?.provider === CREDENTIAL_IDENTITY_PROVIDER ? identity.subject : undefined;
}

export function parseRoles(roles: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(roles)]);
}
