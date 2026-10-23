import { defineOperation, operationFailure, publicAccess } from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import type { MailSender } from "@sixthsummit/ship-mail";
import { z } from "zod";
import { ACTION_TOKEN_PREFIX, generateToken, hashToken } from "../crypto/tokens.js";
import {
  authEmailTaken,
  authMailQueueFull,
  authPasswordPolicy,
  authRateLimited,
  authTokenInvalid,
} from "../errors.js";
import {
  assertPasswordPolicy,
  audit,
  type CredentialAuthRuntime,
  parseRoles,
  sendCredentialMail,
} from "../runtime.js";
import { type AuthAccount, type CredentialStore, normalizeEmail } from "../store.js";
import { emailSchema, passwordSchema, tokenSchema } from "../views.js";

const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional(),
});
const registeredSchema = z.object({ status: z.literal("verification-sent") });
const verifyBody = z.object({ token: tokenSchema });
const verifiedSchema = z.object({ verified: z.literal(true) });
const resendBody = z.object({ email: emailSchema });
const acceptedSchema = z.object({ accepted: z.literal(true) });

/** Issues a fresh verification token for an unverified account and mails it. */
async function issueVerification(
  id: string,
  runtime: CredentialAuthRuntime,
  store: CredentialStore,
  mail: MailSender,
  account: AuthAccount,
  requestId: Parameters<typeof audit>[2],
): Promise<void> {
  const now = runtime.clock();
  await store.revokeTokens({ accountId: account.id, purpose: "verify-email", now });
  const token = generateToken(ACTION_TOKEN_PREFIX);
  const record = await store.createToken({
    accountId: account.id,
    purpose: "verify-email",
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + runtime.policies.tokens.verifyEmailTtlMs),
    now,
  });
  await audit(runtime, store, requestId, {
    event: "email.verification-resent",
    outcome: "success",
    accountId: account.id,
  });
  await sendCredentialMail(runtime, mail, "verifyEmail", {
    to: account.email,
    url: runtime.links.verifyEmail(token),
    idempotencyKey: `${id}:verify:${account.id}:${record.id}`,
  });
}

export function defineAccountOperations<const TId extends string>(
  id: TId,
  runtime: CredentialAuthRuntime,
) {
  const { basePath } = runtime;

  const register = defineOperation({
    id: `${id}.register` as const,
    transport: http.post(`${basePath}/register`),
    input: { body: registerBody },
    output: { 201: registeredSchema },
    successStatus: 201,
    errors: [authEmailTaken, authPasswordPolicy, authMailQueueFull, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store, mail: runtime.mail },
    handler: async ({ input, services, context }) => {
      assertPasswordPolicy(runtime, input.body.password);
      const now = runtime.clock();
      const email = normalizeEmail(input.body.email);
      const passwordHash = await runtime.hasher.hash(input.body.password);
      const created = await services.store.createAccount({
        email,
        ...(input.body.name !== undefined ? { name: input.body.name } : {}),
        roles: parseRoles(runtime.defaultRoles),
        passwordHash,
        algorithm: runtime.hasher.algorithm,
        now,
      });
      if (!created.ok) {
        await audit(runtime, services.store, context.requestId, {
          event: "register",
          outcome: "failure",
          details: { reason: "email-taken" },
        });
        if (runtime.policies.onExistingEmail === "reject") throw operationFailure(authEmailTaken);
        // Conceal: answer exactly like a fresh registration and tell the owner
        // of the address instead. An unverified account gets its verification
        // link again; a verified one gets a notice pointing at sign-in.
        const existing = await services.store.findAccountByEmail(email);
        if (existing && existing.status === "active") {
          if (existing.emailVerifiedAt) {
            await sendCredentialMail(runtime, services.mail, "existingAccount", {
              to: existing.email,
              url: runtime.links.signIn ?? "",
              idempotencyKey: `${id}:existing:${existing.id}:${context.requestId}`,
            });
          } else {
            await issueVerification(
              id,
              runtime,
              services.store,
              services.mail,
              existing,
              context.requestId,
            );
          }
        }
        return { status: "verification-sent" as const };
      }
      const account = created.account;
      await audit(runtime, services.store, context.requestId, {
        event: "register",
        outcome: "success",
        accountId: account.id,
      });
      const token = generateToken(ACTION_TOKEN_PREFIX);
      const record = await services.store.createToken({
        accountId: account.id,
        purpose: "verify-email",
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + runtime.policies.tokens.verifyEmailTtlMs),
        now,
      });
      await sendCredentialMail(runtime, services.mail, "verifyEmail", {
        to: account.email,
        url: runtime.links.verifyEmail(token),
        idempotencyKey: `${id}:verify:${account.id}:${record.id}`,
      });
      return { status: "verification-sent" as const };
    },
  });

  const verifyEmail = defineOperation({
    id: `${id}.verify-email` as const,
    transport: http.post(`${basePath}/verify-email`),
    input: { body: verifyBody },
    output: { 200: verifiedSchema },
    successStatus: 200,
    errors: [authTokenInvalid, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store },
    handler: async ({ input, services, context }) => {
      const now = runtime.clock();
      const token = await services.store.consumeToken({
        tokenHash: hashToken(input.body.token),
        purpose: "verify-email",
        now,
      });
      if (!token) {
        await audit(runtime, services.store, context.requestId, {
          event: "email.verify",
          outcome: "failure",
          details: { reason: "token-invalid" },
        });
        throw operationFailure(authTokenInvalid);
      }
      await services.store.updateAccount(token.accountId, { emailVerifiedAt: now }, now);
      await audit(runtime, services.store, context.requestId, {
        event: "email.verify",
        outcome: "success",
        accountId: token.accountId,
      });
      return { verified: true as const };
    },
  });

  const resendVerification = defineOperation({
    id: `${id}.resend-verification` as const,
    transport: http.post(`${basePath}/resend-verification`),
    input: { body: resendBody },
    output: { 202: acceptedSchema },
    successStatus: 202,
    errors: [authMailQueueFull, authRateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: { store: runtime.store, mail: runtime.mail },
    handler: async ({ input, services, context }) => {
      const account = await services.store.findAccountByEmail(input.body.email);
      // Always 202: the response never says whether the email has an account.
      if (!account || account.emailVerifiedAt || account.status !== "active") {
        return { accepted: true as const };
      }
      await issueVerification(
        id,
        runtime,
        services.store,
        services.mail,
        account,
        context.requestId,
      );
      return { accepted: true as const };
    },
  });

  return Object.freeze({ register, verifyEmail, resendVerification });
}
