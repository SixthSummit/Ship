import {
  authenticatedAccess,
  defineOperation,
  operationFailure,
  publicAccess,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { generateRecoveryCode, hashRecoveryCode, hashToken } from "../crypto/tokens.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../crypto/totp.js";
import {
  authAccountDisabled,
  authAccountLocked,
  authInvalidCredentials,
  authMfaAlreadyEnrolled,
  authMfaInvalidCode,
  authMfaNotEnrolled,
  authRateLimited,
  authRecoveryCodeInvalid,
  authTokenInvalid,
} from "../errors.js";
import {
  audit,
  type CredentialAuthRuntime,
  clearFailedAttempts,
  currentSessionId,
  issueSession,
  lockedFailure,
  lockRemainingSeconds,
  recordFailedAttempt,
  sessionTokenView,
} from "../runtime.js";
import type { AuthAccount, AuthToken, CredentialStore } from "../store.js";
import {
  accountView,
  accountViewSchema,
  codeSchema,
  passwordSchema,
  sessionTokenSchema,
  tokenSchema,
} from "../views.js";
import { requireAccount } from "./session.js";

const enrolBody = z.object({ password: passwordSchema });
const enrolledSchema = z.object({ secret: z.string(), otpauthUrl: z.string() });
const confirmBody = z.object({ code: codeSchema });
const confirmedSchema = z.object({ recoveryCodes: z.array(z.string()) });
const challengeBody = z.object({ challenge: tokenSchema, code: codeSchema });
const challengePassedSchema = z.object({
  status: z.literal("signed-in"),
  session: sessionTokenSchema,
  account: accountViewSchema,
  recoveryCodesRemaining: z.number().int().nonnegative().optional(),
});

export function defineMfaOperations<const TId extends string>(
  id: TId,
  runtime: CredentialAuthRuntime,
) {
  const { basePath } = runtime;
  const totp = {
    digits: runtime.policies.mfa.digits,
    periodSeconds: runtime.policies.mfa.periodSeconds,
    window: runtime.policies.mfa.window,
  };

  /** Resolves a live challenge and its account, or fails without saying which part was wrong. */
  const resolveChallenge = async (
    store: CredentialStore,
    challenge: string,
    now: Date,
  ): Promise<{ readonly token: AuthToken; readonly account: AuthAccount }> => {
    const token = await store.findToken({
      tokenHash: hashToken(challenge),
      purpose: "mfa-challenge",
      now,
    });
    const account = token ? await store.findAccount(token.accountId) : undefined;
    if (!token || !account || account.status !== "active") throw operationFailure(authTokenInvalid);
    return { token, account };
  };

  const failChallenge = async (
    store: CredentialStore,
    account: AuthAccount,
    requestId: string,
    now: Date,
    event: string,
  ): Promise<never> => {
    const failure = await recordFailedAttempt(runtime, store, account, now);
    await audit(runtime, store, requestId, {
      event: failure.lockedUntil ? "sign-in.locked" : event,
      outcome: "failure",
      accountId: account.id,
      details: { reason: "wrong-code", attempts: failure.attempts },
    });
    if (failure.lockedUntil) {
      throw lockedFailure(Math.ceil(runtime.policies.lockout.durationMs / 1000));
    }
    throw operationFailure(event === "mfa.recover" ? authRecoveryCodeInvalid : authMfaInvalidCode);
  };

  const completeChallenge = async (
    store: CredentialStore,
    token: AuthToken,
    account: AuthAccount,
    requestId: string,
    now: Date,
    event: string,
  ) => {
    const consumed = await store.consumeToken({
      tokenHash: token.tokenHash,
      purpose: "mfa-challenge",
      now,
    });
    if (!consumed) throw operationFailure(authTokenInvalid);
    await clearFailedAttempts(store, account, now);
    const issued = await issueSession(runtime, store, account, "verified", requestId, now);
    await audit(runtime, store, requestId, {
      event,
      outcome: "success",
      accountId: account.id,
      sessionId: issued.session.id,
    });
    return issued;
  };

  const enrol = defineOperation({
    id: `${id}.totp.enrol` as const,
    transport: http.post(`${basePath}/totp/enrol`),
    input: { body: enrolBody },
    output: { 200: enrolledSchema },
    successStatus: 200,
    errors: [
      authInvalidCredentials,
      authAccountLocked,
      authAccountDisabled,
      authMfaAlreadyEnrolled,
    ],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) throw lockedFailure(remaining);
      const existing = await services.store.findMfaSecret(account.id);
      if (existing?.enabledAt) throw operationFailure(authMfaAlreadyEnrolled);
      const credential = await services.store.findCredential(account.id);
      const valid =
        credential !== undefined &&
        (await runtime.hasher.verify(input.body.password, credential.passwordHash));
      if (!valid) {
        const failure = await recordFailedAttempt(runtime, services.store, account, now);
        await audit(runtime, services.store, context.requestId, {
          event: "mfa.enrol",
          outcome: "failure",
          accountId: account.id,
          details: { reason: "wrong-password", attempts: failure.attempts },
        });
        if (failure.lockedUntil) {
          throw lockedFailure(Math.ceil(runtime.policies.lockout.durationMs / 1000));
        }
        throw operationFailure(authInvalidCredentials);
      }
      const secret = generateTotpSecret();
      await services.store.upsertMfaSecret({
        accountId: account.id,
        secretCiphertext: runtime.secrets.encrypt(secret),
        keyId: runtime.secrets.currentKeyId,
        enabledAt: null,
        now,
      });
      await audit(runtime, services.store, context.requestId, {
        event: "mfa.enrol",
        outcome: "success",
        accountId: account.id,
      });
      return {
        secret,
        otpauthUrl: otpauthUrl({
          issuer: runtime.policies.mfa.issuer,
          account: account.email,
          secret,
          digits: totp.digits,
          periodSeconds: totp.periodSeconds,
        }),
      };
    },
  });

  const confirm = defineOperation({
    id: `${id}.totp.confirm` as const,
    transport: http.post(`${basePath}/totp/confirm`),
    input: { body: confirmBody },
    output: { 200: confirmedSchema },
    successStatus: 200,
    errors: [
      authMfaInvalidCode,
      authAccountLocked,
      authAccountDisabled,
      authMfaNotEnrolled,
      authMfaAlreadyEnrolled,
    ],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const account = await requireAccount(services.store, context.actor.id);
      const now = runtime.clock();
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) throw lockedFailure(remaining);
      const pending = await services.store.findMfaSecret(account.id);
      if (!pending) throw operationFailure(authMfaNotEnrolled);
      if (pending.enabledAt) throw operationFailure(authMfaAlreadyEnrolled);
      const secret = runtime.secrets.decrypt(pending.secretCiphertext);
      const step = verifyTotp(secret, input.body.code, {
        ...totp,
        now,
        lastUsedStep: pending.lastUsedStep,
      });
      if (step === undefined || !(await services.store.claimMfaStep(account.id, step, now))) {
        await failChallenge(services.store, account, context.requestId, now, "mfa.confirm");
      }
      await services.store.upsertMfaSecret({
        accountId: account.id,
        secretCiphertext: pending.secretCiphertext,
        keyId: pending.keyId,
        enabledAt: now,
        now,
      });
      const codes = Array.from({ length: runtime.policies.recoveryCodes.count }, () =>
        generateRecoveryCode(),
      );
      await services.store.replaceRecoveryCodes(account.id, codes.map(hashRecoveryCode), now);
      const sessionId = currentSessionId(context.identity);
      if (sessionId) await services.store.updateSession(sessionId, { mfaState: "verified" });
      await clearFailedAttempts(services.store, account, now);
      await audit(runtime, services.store, context.requestId, {
        event: "mfa.enrolled",
        outcome: "success",
        accountId: account.id,
        ...(sessionId ? { sessionId } : {}),
        details: { recoveryCodes: codes.length },
      });
      return { recoveryCodes: codes };
    },
  });

  const verify = defineOperation({
    id: `${id}.totp.verify` as const,
    transport: http.post(`${basePath}/totp/verify`),
    input: { body: challengeBody },
    output: { 200: challengePassedSchema },
    successStatus: 200,
    errors: [
      authTokenInvalid,
      authMfaInvalidCode,
      authAccountLocked,
      authMfaNotEnrolled,
      authRateLimited,
    ],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const now = runtime.clock();
      const { token, account } = await resolveChallenge(services.store, input.body.challenge, now);
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) throw lockedFailure(remaining);
      const enrolled = await services.store.findMfaSecret(account.id);
      if (!enrolled?.enabledAt) throw operationFailure(authMfaNotEnrolled);
      const secret = runtime.secrets.decrypt(enrolled.secretCiphertext);
      const step = verifyTotp(secret, input.body.code, {
        ...totp,
        now,
        lastUsedStep: enrolled.lastUsedStep,
      });
      if (step === undefined || !(await services.store.claimMfaStep(account.id, step, now))) {
        await failChallenge(services.store, account, context.requestId, now, "mfa.verify");
      }
      const issued = await completeChallenge(
        services.store,
        token,
        account,
        context.requestId,
        now,
        "mfa.verify",
      );
      return {
        status: "signed-in" as const,
        session: sessionTokenView(issued),
        account: accountView(account, true),
      };
    },
  });

  const recover = defineOperation({
    id: `${id}.recovery.consume` as const,
    transport: http.post(`${basePath}/recovery/consume`),
    input: { body: challengeBody },
    output: { 200: challengePassedSchema },
    successStatus: 200,
    errors: [authTokenInvalid, authRecoveryCodeInvalid, authAccountLocked, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const now = runtime.clock();
      const { token, account } = await resolveChallenge(services.store, input.body.challenge, now);
      const remaining = lockRemainingSeconds(account, now);
      if (remaining !== undefined) throw lockedFailure(remaining);
      const consumed = await services.store.consumeRecoveryCode({
        accountId: account.id,
        codeHash: hashRecoveryCode(input.body.code),
        now,
      });
      if (!consumed) {
        await failChallenge(services.store, account, context.requestId, now, "mfa.recover");
      }
      const issued = await completeChallenge(
        services.store,
        token,
        account,
        context.requestId,
        now,
        "mfa.recover",
      );
      const counts = await services.store.countRecoveryCodes(account.id);
      return {
        status: "signed-in" as const,
        session: sessionTokenView(issued),
        account: accountView(account, true),
        recoveryCodesRemaining: counts.remaining,
      };
    },
  });

  return Object.freeze({ enrol, confirm, verify, recover });
}
