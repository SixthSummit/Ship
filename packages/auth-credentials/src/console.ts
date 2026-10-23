import { consoleAccess } from "@sixthsummit/ship-console";
import type { DependencyToken } from "@sixthsummit/ship-core";
import { defineOperation, operationError, operationFailure } from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { authSessionNotFound } from "./errors.js";
import { type CredentialStore, credentialStoreDependency } from "./store.js";
import {
  accountView,
  accountViewSchema,
  auditEventView,
  auditEventViewSchema,
  sessionView,
  sessionViewSchema,
} from "./views.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const DEFAULT_AUTH_AUDIT_EXTENSION_ID = "auth-audit";

export const authAuditAccountNotFound = operationError({
  code: "AUTH_AUDIT_ACCOUNT_NOT_FOUND",
  status: 404,
  message: "No account matches the id or email",
});

const eventsQuery = z.object({
  accountId: z.string().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  event: z.string().min(1).optional(),
  outcome: z.enum(["success", "failure"]).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});
const eventsOutput = z.object({ events: z.array(auditEventViewSchema) });
const accountQuery = z
  .object({ accountId: z.string().min(1).optional(), email: z.string().trim().min(1).optional() })
  .refine((value) => value.accountId !== undefined || value.email !== undefined, {
    message: "accountId or email is required",
  });
const accountOutput = z.object({
  account: accountViewSchema,
  locked: z.boolean(),
  lockedUntil: z.string().optional(),
  failedAttempts: z.number().int(),
  sessions: z.array(sessionViewSchema),
  recoveryCodes: z.object({ remaining: z.number().int(), used: z.number().int() }),
});
const revokeBody = z.object({
  accountId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});
const revokedOutput = z.object({ revoked: z.number().int().nonnegative() });
const accountBody = z.object({ accountId: z.string().min(1) });
const unlockedOutput = z.object({ unlocked: z.literal(true) });
const statusBody = z.object({
  accountId: z.string().min(1),
  status: z.enum(["active", "disabled"]),
});
const statusOutput = z.object({
  status: z.enum(["active", "disabled"]),
  sessionsRevoked: z.number().int(),
});

export interface CredentialAuthConsoleExtensionOptions {
  /** The console module id. Defaults to `console`. */
  readonly consoleId?: string;
  /** The console base path. Defaults to `/console`. */
  readonly basePath?: string;
  /** The panel id. Defaults to `auth-audit`. */
  readonly extensionId?: string;
  /** The store token the auth module exports; the console must import that module. */
  readonly store?: DependencyToken<CredentialStore>;
  readonly clock?: () => Date;
}

/**
 * The auth-audit panel for `defineConsoleModule({ extensions })`: read the
 * audit log, inspect an account's lock state and sessions, revoke sessions,
 * unlock, and disable or re-enable an account. Every operation is namespaced
 * `<consoleId>.<extensionId>.` and gated by exactly `console.operate`, as the
 * console's extension seam requires. Add the auth module id to the console's
 * `imports` so the store token resolves.
 */
export function credentialAuthConsoleExtension(
  options: CredentialAuthConsoleExtensionOptions = {},
) {
  const consoleId = options.consoleId ?? "console";
  const basePath = options.basePath ?? "/console";
  const extensionId = options.extensionId ?? DEFAULT_AUTH_AUDIT_EXTENSION_ID;
  const store = options.store ?? credentialStoreDependency();
  const clock = options.clock ?? (() => new Date());
  const prefix = `${consoleId}.${extensionId}` as const;
  const path = `${basePath}/${extensionId}` as const;

  const resolveAccount = async (
    service: CredentialStore,
    query: { readonly accountId?: string; readonly email?: string },
  ) => {
    const account =
      query.accountId !== undefined
        ? await service.findAccount(query.accountId)
        : query.email !== undefined
          ? await service.findAccountByEmail(query.email)
          : undefined;
    if (!account) throw operationFailure(authAuditAccountNotFound);
    return account;
  };

  const operatorAudit = async (
    service: CredentialStore,
    input: {
      readonly event: string;
      readonly accountId: string;
      readonly sessionId?: string;
      readonly operator: string;
      readonly requestId: string;
      readonly details?: Readonly<Record<string, string | number | boolean>>;
    },
  ) => {
    await service.recordAudit({
      event: input.event,
      outcome: "success",
      accountId: input.accountId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      requestId: input.requestId,
      details: { operator: input.operator, ...input.details },
      createdAt: clock(),
    });
  };

  const events = defineOperation({
    id: `${prefix}.events` as const,
    transport: http.get(`${path}/events`),
    input: { query: eventsQuery },
    output: { 200: eventsOutput },
    successStatus: 200,
    errors: [authAuditAccountNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { store },
    handler: async ({ input, services }) => {
      const accountId =
        input.query.email !== undefined && input.query.accountId === undefined
          ? (await resolveAccount(services.store, { email: input.query.email })).id
          : input.query.accountId;
      const rows = await services.store.listAudit({
        ...(accountId !== undefined ? { accountId } : {}),
        ...(input.query.event !== undefined ? { event: input.query.event } : {}),
        ...(input.query.outcome !== undefined ? { outcome: input.query.outcome } : {}),
        ...(input.query.before !== undefined ? { before: new Date(input.query.before) } : {}),
        limit: input.query.limit ?? DEFAULT_LIMIT,
      });
      return { events: rows.map(auditEventView) };
    },
  });

  const account = defineOperation({
    id: `${prefix}.account` as const,
    transport: http.get(`${path}/account`),
    input: { query: accountQuery },
    output: { 200: accountOutput },
    successStatus: 200,
    errors: [authAuditAccountNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { store },
    handler: async ({ input, services }) => {
      const found = await resolveAccount(services.store, input.query);
      const now = clock();
      const [secret, sessions, recoveryCodes] = await Promise.all([
        services.store.findMfaSecret(found.id),
        services.store.listSessions(found.id),
        services.store.countRecoveryCodes(found.id),
      ]);
      const locked = found.lockedUntil !== undefined && found.lockedUntil.getTime() > now.getTime();
      return {
        account: accountView(found, secret?.enabledAt !== undefined),
        locked,
        ...(locked && found.lockedUntil ? { lockedUntil: found.lockedUntil.toISOString() } : {}),
        failedAttempts: found.failedAttempts,
        sessions: sessions
          .filter((session) => session.expiresAt.getTime() > now.getTime())
          .map((session) => sessionView(session)),
        recoveryCodes,
      };
    },
  });

  const revoke = defineOperation({
    id: `${prefix}.revoke` as const,
    transport: http.post(`${path}/revoke`),
    input: { body: revokeBody },
    output: { 200: revokedOutput },
    successStatus: 200,
    errors: [authAuditAccountNotFound, authSessionNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { store },
    handler: async ({ input, services, context }) => {
      const found = await resolveAccount(services.store, { accountId: input.body.accountId });
      const now = clock();
      if (input.body.sessionId !== undefined) {
        const session = await services.store.findSession(input.body.sessionId);
        if (!session || session.accountId !== found.id) throw operationFailure(authSessionNotFound);
        const revoked = await services.store.revokeSession(session.id, { now, reason: "console" });
        if (!revoked) throw operationFailure(authSessionNotFound);
        await operatorAudit(services.store, {
          event: "console.session-revoked",
          accountId: found.id,
          sessionId: session.id,
          operator: context.actor.id,
          requestId: context.requestId,
        });
        return { revoked: 1 };
      }
      const revoked = await services.store.revokeSessions(found.id, { now, reason: "console" });
      await services.store.updateAccount(found.id, { sessionsInvalidBefore: now }, now);
      await operatorAudit(services.store, {
        event: "console.sessions-revoked-all",
        accountId: found.id,
        operator: context.actor.id,
        requestId: context.requestId,
        details: { revoked },
      });
      return { revoked };
    },
  });

  const unlock = defineOperation({
    id: `${prefix}.unlock` as const,
    transport: http.post(`${path}/unlock`),
    input: { body: accountBody },
    output: { 200: unlockedOutput },
    successStatus: 200,
    errors: [authAuditAccountNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { store },
    handler: async ({ input, services, context }) => {
      const found = await resolveAccount(services.store, { accountId: input.body.accountId });
      const now = clock();
      await services.store.updateAccount(
        found.id,
        { failedAttempts: 0, lastFailedAt: null, lockedUntil: null },
        now,
      );
      await operatorAudit(services.store, {
        event: "console.unlocked",
        accountId: found.id,
        operator: context.actor.id,
        requestId: context.requestId,
      });
      return { unlocked: true as const };
    },
  });

  const status = defineOperation({
    id: `${prefix}.status` as const,
    transport: http.post(`${path}/status`),
    input: { body: statusBody },
    output: { 200: statusOutput },
    successStatus: 200,
    errors: [authAuditAccountNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { store },
    handler: async ({ input, services, context }) => {
      const found = await resolveAccount(services.store, { accountId: input.body.accountId });
      const now = clock();
      await services.store.updateAccount(found.id, { status: input.body.status }, now);
      // A disabled account keeps no live session (SAPI-284): revoke them with the status change.
      const sessionsRevoked =
        input.body.status === "disabled"
          ? await services.store.revokeSessions(found.id, { now, reason: "disabled" })
          : 0;
      if (input.body.status === "disabled") {
        await services.store.updateAccount(found.id, { sessionsInvalidBefore: now }, now);
      }
      await operatorAudit(services.store, {
        event: input.body.status === "disabled" ? "console.disabled" : "console.enabled",
        accountId: found.id,
        operator: context.actor.id,
        requestId: context.requestId,
        details: { sessionsRevoked },
      });
      return { status: input.body.status, sessionsRevoked };
    },
  });

  return Object.freeze({
    id: extensionId,
    title: "Auth audit",
    operations: [events, account, revoke, unlock, status] as const,
  });
}

export type CredentialAuthConsoleExtension = ReturnType<typeof credentialAuthConsoleExtension>;
