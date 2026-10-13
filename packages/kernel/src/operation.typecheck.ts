/** Type-level CI contract for operation schema and dependency inference. */
import { z } from "zod";
import { optionalIdentityAccess, permission, publicAccess } from "./access.js";
import { dependency, effectDependency } from "./dependency.js";
import type {
  InferOperationInput,
  InferOperationOutputs,
  InferOperationRawInput,
} from "./operation.js";
import { defineOperation, respond } from "./operation.js";
import { operationError } from "./operation-error.js";

interface AccountsRepository {
  find(id: string): Promise<{ id: string; displayName: string }>;
}

const repository = dependency<AccountsRepository>("accounts.repository");
const auditEffect = effectDependency<{ record(accountId: string): Promise<void> }>("audit.record", {
  delivery: "immediate",
});
const accountNotFound = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
});

const operation = defineOperation({
  id: "accounts.get",
  input: {
    params: z.object({ accountId: z.string().uuid().brand<"AccountId">() }),
    query: z.object({ includeDetails: z.stringbool().default(false) }),
  },
  output: {
    200: z.object({ id: z.string(), displayName: z.string() }),
    202: z.object({ queued: z.literal(true) }),
  },
  successStatus: 200,
  errors: [accountNotFound] as const,
  access: permission("accounts:read"),
  transaction: "read",
  dependencies: { accounts: repository },
  handler: async ({ input, services, context }) => {
    const accountId: string = input.params.accountId;
    const includeDetails: boolean = input.query.includeDetails;
    const requestId: string = context.requestId;
    const actorId: string = context.actor.id;
    void includeDetails;
    void requestId;
    void actorId;

    return services.accounts.find(accountId);
  },
});

const alternate = defineOperation({
  ...operation,
  id: "accounts.queue-get",
  handler: () => respond(202, { queued: true as const }),
});

defineOperation({
  id: "accounts.public-status",
  input: {},
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ context }) => {
    const optionalActorId: string | undefined = context.actor?.id;
    // @ts-expect-error public operations must handle an absent actor
    const requiredActorId: string = context.actor.id;
    void optionalActorId;
    void requiredActorId;
    return { ok: true as const };
  },
});

defineOperation({
  id: "accounts.optional-profile",
  input: {},
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: optionalIdentityAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ context }) => {
    const optionalActorId: string | undefined = context.actor?.id;
    const optionalSubject: string | undefined = context.identity?.subject;
    // @ts-expect-error optional-identity operations must handle an absent actor
    const requiredActorId: string = context.actor.id;
    void optionalActorId;
    void optionalSubject;
    void requiredActorId;
    return { ok: true as const };
  },
});

const auditedOperation = defineOperation({
  id: "accounts.audit",
  input: { body: z.object({ accountId: z.string() }) },
  output: { 202: z.object({ accepted: z.literal(true) }) },
  successStatus: 202,
  errors: [],
  access: permission("accounts:write"),
  transaction: "none",
  dependencies: { audit: auditEffect },
  effects: [auditEffect],
  handler: async ({ input, services }) => {
    await services.audit.record(input.body.accountId);
    return { accepted: true as const };
  },
});

// @ts-expect-error ordinary dependencies cannot be declared as external effects
defineOperation({ ...auditedOperation, effects: [repository] });

type Assert<TValue extends true> = TValue;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type _idIsLiteral = Assert<Equal<typeof operation.id, "accounts.get">>;
type _errorsAreLiteral = Assert<
  Equal<(typeof operation.errors)[number]["code"], "ACCOUNT_NOT_FOUND">
>;
type RawInput = InferOperationRawInput<typeof operation.input>;
type _rawAccountId = Assert<Equal<RawInput["params"]["accountId"], string>>;
type _rawQuery = Assert<Equal<RawInput["query"]["includeDetails"], string | undefined>>;
type _parsedInput = Assert<
  Equal<
    InferOperationInput<typeof operation.input>,
    {
      readonly params: { accountId: string & z.core.$brand<"AccountId"> };
      readonly query: { includeDetails: boolean };
    }
  >
>;
type _outputs = Assert<
  Equal<
    InferOperationOutputs<typeof operation.output>,
    {
      readonly 200: { id: string; displayName: string };
      readonly 202: { queued: true };
    }
  >
>;
type _alternateStatus = Assert<Equal<typeof alternate.successStatus, 200>>;
type _effectDeliveryIsLiteral = Assert<
  Equal<(typeof auditedOperation.effects)[0]["delivery"], "immediate">
>;

// Actor-kind access narrows the handler context, and idempotency keys read validated input.
import { systemAccess } from "./access.js";
import { idempotencyStoreDependency } from "./idempotency.js";

const idempotencyStore = idempotencyStoreDependency("platform.idempotency");
defineOperation({
  id: "jobs.run",
  input: { body: z.object({ runId: z.string() }) },
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: systemAccess(),
  transaction: "none",
  dependencies: {},
  idempotency: {
    key: (input) => input.body.runId,
    windowMs: 60_000,
    store: idempotencyStore,
  },
  handler: ({ context }) => {
    context.actor.kind satisfies "system";
    context.actor.onBehalfOf?.actorId satisfies string | undefined;
    return { ok: true as const };
  },
});

defineOperation({
  id: "jobs.run",
  input: { body: z.object({ runId: z.string() }) },
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: systemAccess(),
  transaction: "none",
  dependencies: {},
  idempotency: {
    // @ts-expect-error the key function receives the validated input shape
    key: (input) => input.body.missing,
    windowMs: 60_000,
    store: idempotencyStore,
  },
  handler: () => ({ ok: true as const }),
});
