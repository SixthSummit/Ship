import {
  authenticatedAccess,
  defineOperation,
  operationFailure,
  publicAccess,
  respond,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { ACTION_TOKEN_PREFIX, generateToken, hashToken } from "../crypto/tokens.js";
import {
  authAccountDisabled,
  authAccountLocked,
  authEmailTaken,
  authInvalidCredentials,
  authMailQueueFull,
  authPasswordPolicy,
  authRateLimited,
  authTokenInvalid,
} from "../errors.js";
import {
  assertPasswordPolicy,
  audit,
  type CredentialAuthRuntime,
  clearFailedAttempts,
  currentSessionId,
  issueSession,
  lockedFailure,
  lockRemainingSeconds,
  recordFailedAttempt,
  requestTransport,
  sendCredentialMail,
  sessionCookieHeaders,
  sessionTokenView,
} from "../runtime.js";
import { normalizeEmail } from "../store.js";
import { emailSchema, passwordSchema, sessionTokenSchema, tokenSchema } from "../views.js";
import { requireAccount } from "./session.js";

const forgotBody = z.object({ email: emailSchema });
const acceptedSchema = z.object({ accepted: z.literal(true) });
const resetBody = z.object({ token: tokenSchema, password: passwordSchema });
const resetSchema = z.object({ reset: z.literal(true) });
const changePasswordBody = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
  /** Defaults to `true`: every other session of the account is revoked. */
  signOutOtherSessions: z.boolean().optional(),
});
const passwordChangedSchema = z.object({
  changed: z.literal(true),
  /** How many other sessions were revoked. */
  revoked: z.number().int().nonnegative(),
  /**
   * The rotated current session, present when the request came through a
   * credential session: a bearer client adopts the new token, a cookie
   * client received it in `Set-Cookie`. The old token is revoked.
   */
  session: sessionTokenSchema.optional(),
});
const changeEmailBody = z.object({ password: passwordSchema, newEmail: emailSchema });
const confirmBody = z.object({ token: tokenSchema });
const emailChangedSchema = z.object({ email: z.string() });

export function definePasswordOperations<const TId extends string>(
  id: TId,
  runtime: CredentialAuthRuntime,
) {
  const { basePath } = runtime;

  const forgotPassword = defineOperation({
    id: `${id}.forgot-password` as const,
    transport: http.post(`${basePath}/password/forgot`),
    input: { body: forgotBody },
    output: { 202: acceptedSchema },
    successStatus: 202,
    errors: [authMailQueueFull, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store, mail: runtime.mail },
    handler: async ({ input, services, context }) => {
      const now = runtime.clock();
      const account = await services.store.findAccountByEmail(input.body.email);
      // Always 202 so the endpoint cannot be used to enumerate accounts.
      if (!account || account.status !== "active") return { accepted: true as const };
      await services.store.revokeTokens({ accountId: account.id, purpose: "reset-password", now });
      const token = generateToken(ACTION_TOKEN_PREFIX);
      const record = await services.store.createToken({
        accountId: account.id,
        purpose: "reset-password",
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + runtime.policies.tokens.resetPasswordTtlMs),
        now,
      });
      await audit(runtime, services.store, context.requestId, {
        event: "password.reset-requested",
        outcome: "success",
        accountId: account.id,
      });
      await sendCredentialMail(runtime, services.mail, "resetPassword", {
        to: account.email,
        url: runtime.links.resetPassword(token),
        idempotencyKey: `${id}:reset:${account.id}:${record.id}`,
      });
      return { accepted: true as const };
    },
  });

  const resetPassword = defineOperation({
    id: `${id}.reset-password` as const,
    transport: http.post(`${basePath}/password/reset`),
    input: { body: resetBody },
    output: { 200: resetSchema },
    successStatus: 200,
    errors: [authTokenInvalid, authPasswordPolicy, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      assertPasswordPolicy(runtime, input.body.password);
      const now = runtime.clock();
      const token = await services.store.consumeToken({
        tokenHash: hashToken(input.body.token),
        purpose: "reset-password",
        now,
      });
      if (!token) {
        await audit(runtime, services.store, context.requestId, {
          event: "password.reset",
          outcome: "failure",
          details: { reason: "token-invalid" },
        });
        throw operationFailure(authTokenInvalid);
      }
      const account = await services.store.findAccount(token.accountId);
      if (!account) throw operationFailure(authTokenInvalid);
      await services.store.setCredential(account.id, {
        passwordHash: await runtime.hasher.hash(input.body.password),
        algorithm: runtime.hasher.algorithm,
        now,
      });
      // A reset proves control of the mailbox, clears any lock and signs every
      // other device out: sessions created before now are invalid everywhere.
      const revoked = await services.store.revokeSessions(account.id, {
        now,
        reason: "password-reset",
      });
      await services.store.updateAccount(
        account.id,
        {
          failedAttempts: 0,
          lastFailedAt: null,
          lockedUntil: null,
          sessionsInvalidBefore: now,
          ...(account.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
        },
        now,
      );
      await audit(runtime, services.store, context.requestId, {
        event: "password.reset",
        outcome: "success",
        accountId: account.id,
        details: { sessionsRevoked: revoked },
      });
      return { reset: true as const };
    },
  });

  const changePassword = defineOperation({
    id: `${id}.change-password` as const,
    transport: http.post(`${basePath}/password/change`),
    input: { body: changePasswordBody },
    output: { 200: passwordChangedSchema },
    successStatus: 200,
    errors: [authInvalidCredentials, authAccountLocked, authAccountDisabled, authPasswordPolicy],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      assertPasswordPolicy(runtime, input.body.newPassword);
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) throw lockedFailure(remaining);
      const credential = await services.store.findCredential(account.id);
      const valid =
        credential !== undefined &&
        (await runtime.hasher.verify(input.body.currentPassword, credential.passwordHash));
      if (!valid) {
        const failure = await recordFailedAttempt(runtime, services.store, account, now);
        await audit(runtime, services.store, context.requestId, {
          event: "password.changed",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "wrong-password", attempts: failure.attempts },
        });
        if (failure.lockedUntil) {
          throw lockedFailure(Math.ceil(runtime.policies.lockout.durationMs / 1000));
        }
        throw operationFailure(authInvalidCredentials);
      }
      await services.store.setCredential(account.id, {
        passwordHash: await runtime.hasher.hash(input.body.newPassword),
        algorithm: runtime.hasher.algorithm,
        now,
      });
      await clearFailedAttempts(services.store, account, now);
      const sessionId = currentSessionId(context.identity);
      const signOutOthers = input.body.signOutOtherSessions !== false;
      // A changed password is the moment to shed a stolen token: the other
      // sessions go (by default) and the current one is rotated, whatever its
      // transport, because a captured token is the same token this request
      // carries. The session keeps its MFA state; nothing about the second
      // factor changed.
      const revoked = signOutOthers
        ? await services.store.revokeSessions(account.id, {
            now,
            reason: "password-changed",
            ...(sessionId !== undefined ? { except: sessionId } : {}),
          })
        : 0;
      let rotated: Awaited<ReturnType<typeof issueSession>> | undefined;
      if (sessionId !== undefined) {
        const current = await services.store.findSession(sessionId);
        rotated = await issueSession(
          runtime,
          services.store,
          account,
          current?.mfaState ?? "none",
          context.requestId,
          now,
        );
        await services.store.revokeSession(sessionId, { now, reason: "rotated" });
      }
      await audit(runtime, services.store, context.requestId, {
        event: "password.changed",
        outcome: "success",
        accountId: account.id,
        ...(sessionId !== undefined ? { sessionId } : {}),
        details: {
          sessionsRevoked: revoked,
          ...(rotated ? { rotatedTo: rotated.session.id } : {}),
        },
      });
      if (!rotated) return { changed: true as const, revoked };
      const transport = requestTransport(runtime, context.requestId) ?? "bearer";
      const body = {
        changed: true as const,
        revoked,
        session: sessionTokenView(rotated, transport),
      };
      const headers = sessionCookieHeaders(runtime, rotated, transport, now);
      return headers ? respond(200, body, { headers }) : body;
    },
  });

  const changeEmail = defineOperation({
    id: `${id}.change-email` as const,
    transport: http.post(`${basePath}/email/change`),
    input: { body: changeEmailBody },
    output: { 202: acceptedSchema },
    successStatus: 202,
    errors: [
      authInvalidCredentials,
      authAccountLocked,
      authAccountDisabled,
      authEmailTaken,
      authMailQueueFull,
    ],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store, mail: runtime.mail },
    handler: async ({ input, services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) throw lockedFailure(remaining);
      const credential = await services.store.findCredential(account.id);
      const valid =
        credential !== undefined &&
        (await runtime.hasher.verify(input.body.password, credential.passwordHash));
      if (!valid) {
        const failure = await recordFailedAttempt(runtime, services.store, account, now);
        await audit(runtime, services.store, context.requestId, {
          event: "email.change-requested",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "wrong-password", attempts: failure.attempts },
        });
        if (failure.lockedUntil) {
          throw lockedFailure(Math.ceil(runtime.policies.lockout.durationMs / 1000));
        }
        throw operationFailure(authInvalidCredentials);
      }
      const newEmail = normalizeEmail(input.body.newEmail);
      if (await services.store.findAccountByEmail(newEmail)) throw operationFailure(authEmailTaken);
      await services.store.revokeTokens({ accountId: account.id, purpose: "change-email", now });
      const token = generateToken(ACTION_TOKEN_PREFIX);
      const record = await services.store.createToken({
        accountId: account.id,
        purpose: "change-email",
        tokenHash: hashToken(token),
        payload: { email: newEmail },
        expiresAt: new Date(now.getTime() + runtime.policies.tokens.changeEmailTtlMs),
        now,
      });
      await audit(runtime, services.store, context.requestId, {
        event: "email.change-requested",
        outcome: "success",
        accountId: account.id,
      });
      await sendCredentialMail(runtime, services.mail, "changeEmail", {
        to: newEmail,
        url: runtime.links.changeEmail(token),
        idempotencyKey: `${id}:change-email:${account.id}:${record.id}`,
      });
      return { accepted: true as const };
    },
  });

  const confirmEmailChange = defineOperation({
    id: `${id}.confirm-email-change` as const,
    transport: http.post(`${basePath}/email/confirm`),
    input: { body: confirmBody },
    output: { 200: emailChangedSchema },
    successStatus: 200,
    errors: [authTokenInvalid, authEmailTaken, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const now = runtime.clock();
      const token = await services.store.consumeToken({
        tokenHash: hashToken(input.body.token),
        purpose: "change-email",
        now,
      });
      const email = token?.payload?.email;
      if (!token || !email) {
        await audit(runtime, services.store, context.requestId, {
          event: "email.changed",
          outcome: "failure",
          details: { reason: "token-invalid" },
        });
        throw operationFailure(authTokenInvalid);
      }
      const updated = await services.store.updateAccount(
        token.accountId,
        { email, emailVerifiedAt: now },
        now,
      );
      if (!updated.ok) {
        await audit(runtime, services.store, context.requestId, {
          event: "email.changed",
          outcome: "failure",
          accountId: token.accountId,
          details: { reason: updated.reason },
        });
        throw operationFailure(
          updated.reason === "email-taken" ? authEmailTaken : authTokenInvalid,
        );
      }
      await audit(runtime, services.store, context.requestId, {
        event: "email.changed",
        outcome: "success",
        accountId: token.accountId,
      });
      return { email: updated.account.email };
    },
  });

  return Object.freeze({
    forgotPassword,
    resetPassword,
    changePassword,
    changeEmail,
    confirmEmailChange,
  });
}
