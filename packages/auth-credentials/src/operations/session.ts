import {
  authenticatedAccess,
  defineOperation,
  operationFailure,
  publicAccess,
  respond,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { CHALLENGE_TOKEN_PREFIX, generateToken, hashToken } from "../crypto/tokens.js";
import {
  authAccountDisabled,
  authAccountLocked,
  authEmailUnverified,
  authInvalidCredentials,
  authRateLimited,
  authSessionNotFound,
} from "../errors.js";
import { mfaRequiredFor } from "../policy.js";
import {
  audit,
  type CredentialAuthRuntime,
  clearFailedAttempts,
  clearSessionCookieHeaders,
  currentSessionId,
  issueSession,
  lockedFailure,
  lockRemainingSeconds,
  recordFailedAttempt,
  resolveTransport,
  sessionCookieHeaders,
  sessionTokenView,
} from "../runtime.js";
import type { AuthAccount, CredentialStore } from "../store.js";
import {
  accountView,
  accountViewSchema,
  emailSchema,
  passwordSchema,
  sessionView,
  sessionViewSchema,
  signInOutputSchema,
} from "../views.js";

const signedOutSchema = z.object({ signedOut: z.literal(true) });
const meSchema = z.object({
  account: accountViewSchema,
  session: sessionViewSchema,
});
const sessionsSchema = z.object({ sessions: z.array(sessionViewSchema) });
const revokeBody = z.object({ sessionId: z.string().min(1) });
const revokedSchema = z.object({ revoked: z.number().int().nonnegative() });
const revokeAllBody = z.object({ keepCurrent: z.boolean().optional() });

/** Loads the signed-in account or fails closed; a missing row means the actor is stale. */
export async function requireAccount(
  store: CredentialStore,
  actorId: string,
): Promise<AuthAccount> {
  const account = await store.findAccount(actorId);
  if (!account || account.status !== "active") throw operationFailure(authAccountDisabled);
  return account;
}

export function defineSessionOperations<const TId extends string>(
  id: TId,
  runtime: CredentialAuthRuntime,
) {
  const { basePath } = runtime;
  // Only the enabled transports validate, so a client asking for a cookie
  // from a bearer-only module gets a validation error naming the field
  // rather than a token it did not expect.
  const signInBody = z.object({
    email: emailSchema,
    password: passwordSchema,
    transport: z.enum(runtime.sessions.transports).optional(),
  });

  const signIn = defineOperation({
    id: `${id}.sign-in` as const,
    transport: http.post(`${basePath}/sign-in`),
    input: { body: signInBody },
    output: { 200: signInOutputSchema },
    successStatus: 200,
    errors: [
      authInvalidCredentials,
      authAccountLocked,
      authAccountDisabled,
      authEmailUnverified,
      authRateLimited,
    ],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const now = runtime.clock();
      const store = services.store;
      const account = await store.findAccountByEmail(input.body.email);
      const credential = account ? await store.findCredential(account.id) : undefined;
      if (!account || !credential) {
        // Same hashing cost as a real attempt, so timing does not reveal the account.
        await runtime.hasher.verify(input.body.password, await runtime.decoyHash);
        await audit(runtime, store, context.requestId, {
          event: "sign-in",
          outcome: "failure",
          details: { reason: "unknown-email" },
        });
        throw operationFailure(authInvalidCredentials);
      }
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) {
        await audit(runtime, store, context.requestId, {
          event: "sign-in",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "locked", retryAfterSeconds: remaining },
        });
        throw lockedFailure(remaining);
      }
      const valid = await runtime.hasher.verify(input.body.password, credential.passwordHash);
      if (!valid) {
        const failure = await recordFailedAttempt(runtime, store, account, now);
        await audit(runtime, store, context.requestId, {
          event: failure.lockedUntil ? "sign-in.locked" : "sign-in",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "wrong-password", attempts: failure.attempts },
        });
        if (failure.lockedUntil) {
          throw lockedFailure(Math.ceil(runtime.policies.lockout.durationMs / 1000));
        }
        throw operationFailure(authInvalidCredentials);
      }
      if (account.status !== "active") {
        await audit(runtime, store, context.requestId, {
          event: "sign-in",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "disabled" },
        });
        throw operationFailure(authAccountDisabled);
      }
      if (runtime.policies.requireVerifiedEmail && !account.emailVerifiedAt) {
        await audit(runtime, store, context.requestId, {
          event: "sign-in",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "email-unverified" },
        });
        throw operationFailure(authEmailUnverified);
      }
      await clearFailedAttempts(store, account, now);
      if (runtime.hasher.needsRehash(credential.passwordHash)) {
        await store.setCredential(account.id, {
          passwordHash: await runtime.hasher.hash(input.body.password),
          algorithm: runtime.hasher.algorithm,
          now,
        });
      }
      const secret = await store.findMfaSecret(account.id);
      if (secret?.enabledAt) {
        const challenge = generateToken(CHALLENGE_TOKEN_PREFIX);
        const record = await store.createToken({
          accountId: account.id,
          purpose: "mfa-challenge",
          tokenHash: hashToken(challenge),
          expiresAt: new Date(now.getTime() + runtime.policies.mfa.challengeTtlMs),
          now,
        });
        await audit(runtime, store, context.requestId, {
          event: "mfa.challenged",
          outcome: "success",
          accountId: account.id,
        });
        return {
          status: "mfa-required" as const,
          challenge: { token: challenge, expiresAt: record.expiresAt.toISOString() },
        };
      }
      const mustEnrol = mfaRequiredFor(runtime.policies.mfa, account);
      const issued = await issueSession(
        runtime,
        store,
        account,
        mustEnrol ? "pending-enrolment" : "none",
        context.requestId,
        now,
      );
      const transport = resolveTransport(runtime, input.body.transport);
      await audit(runtime, store, context.requestId, {
        event: "sign-in",
        outcome: "success",
        accountId: account.id,
        sessionId: issued.session.id,
        details: { transport, ...(mustEnrol ? { mfaEnrolmentRequired: true } : {}) },
      });
      const body = {
        status: mustEnrol ? ("mfa-enrolment-required" as const) : ("signed-in" as const),
        session: sessionTokenView(issued, transport),
        account: accountView(account, false),
      };
      const headers = sessionCookieHeaders(runtime, issued, transport, now);
      return headers ? respond(200, body, { headers }) : body;
    },
  });

  const signOut = defineOperation({
    id: `${id}.sign-out` as const,
    transport: http.post(`${basePath}/sign-out`),
    input: {},
    output: { 200: signedOutSchema },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ services, context }) => {
      const now = runtime.clock();
      const sessionId = currentSessionId(context.identity);
      if (sessionId) {
        await services.store.revokeSession(sessionId, { now, reason: "sign-out" });
      }
      await audit(runtime, services.store, context.requestId, {
        event: "sign-out",
        outcome: "success",
        accountId: context.actor.id,
        ...(sessionId ? { sessionId } : {}),
      });
      const headers = clearSessionCookieHeaders(runtime, context.requestId);
      return headers
        ? respond(200, { signedOut: true as const }, { headers })
        : { signedOut: true as const };
    },
  });

  const me = defineOperation({
    id: `${id}.me` as const,
    transport: http.get(`${basePath}/me`),
    input: {},
    output: { 200: meSchema },
    successStatus: 200,
    errors: [authAccountDisabled, authSessionNotFound],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const sessionId = currentSessionId(context.identity);
      const session = sessionId ? await services.store.findSession(sessionId) : undefined;
      if (!session || session.accountId !== account.id) throw operationFailure(authSessionNotFound);
      const secret = await services.store.findMfaSecret(account.id);
      return {
        account: accountView(account, secret?.enabledAt !== undefined),
        session: sessionView(session, session.id),
      };
    },
  });

  const listSessions = defineOperation({
    id: `${id}.sessions.list` as const,
    transport: http.get(`${basePath}/sessions`),
    input: {},
    output: { 200: sessionsSchema },
    successStatus: 200,
    errors: [authAccountDisabled],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const current = currentSessionId(context.identity);
      const sessions = await services.store.listSessions(account.id);
      return {
        sessions: sessions
          .filter((session) => session.expiresAt.getTime() > now.getTime())
          .map((session) => sessionView(session, current)),
      };
    },
  });

  const revokeSession = defineOperation({
    id: `${id}.sessions.revoke` as const,
    transport: http.post(`${basePath}/sessions/revoke`),
    input: { body: revokeBody },
    output: { 200: revokedSchema },
    successStatus: 200,
    errors: [authAccountDisabled, authSessionNotFound],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const session = await services.store.findSession(input.body.sessionId);
      if (!session || session.accountId !== account.id || session.revokedAt) {
        throw operationFailure(authSessionNotFound);
      }
      const revoked = await services.store.revokeSession(session.id, { now, reason: "revoked" });
      await audit(runtime, services.store, context.requestId, {
        event: "session.revoke",
        outcome: revoked ? "success" : "failure",
        accountId: account.id,
        sessionId: session.id,
      });
      if (!revoked) throw operationFailure(authSessionNotFound);
      // Revoking the session behind this very request also takes its cookie away.
      const headers =
        session.id === currentSessionId(context.identity)
          ? clearSessionCookieHeaders(runtime, context.requestId)
          : undefined;
      return headers ? respond(200, { revoked: 1 }, { headers }) : { revoked: 1 };
    },
  });

  const revokeAllSessions = defineOperation({
    id: `${id}.sessions.revoke-all` as const,
    transport: http.post(`${basePath}/sessions/revoke-all`),
    input: { body: revokeAllBody },
    output: { 200: revokedSchema },
    successStatus: 200,
    errors: [authAccountDisabled],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const current = currentSessionId(context.identity);
      const keepCurrent = input.body.keepCurrent === true && current !== undefined;
      const revoked = await services.store.revokeSessions(account.id, {
        now,
        reason: "revoke-all",
        ...(keepCurrent ? { except: current } : {}),
      });
      if (!keepCurrent) {
        // The cutoff also catches a session row a concurrent sign-in commits after the loop.
        await services.store.updateAccount(account.id, { sessionsInvalidBefore: now }, now);
      }
      await audit(runtime, services.store, context.requestId, {
        event: "sessions.revoke-all",
        outcome: "success",
        accountId: account.id,
        ...(current ? { sessionId: current } : {}),
        details: { revoked, keepCurrent },
      });
      const headers = keepCurrent
        ? undefined
        : clearSessionCookieHeaders(runtime, context.requestId);
      return headers ? respond(200, { revoked }, { headers }) : { revoked };
    },
  });

  return Object.freeze({ signIn, signOut, me, listSessions, revokeSession, revokeAllSessions });
}
