/** Type-level CI contract for direct operation calls and discriminated results. */
import { z } from "zod";
import { permission } from "./access.js";
import { defineApp } from "./application.js";
import { dependency, type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor } from "./executor.js";
import { defineModule } from "./module.js";
import { defineOperation, respond } from "./operation.js";
import {
  type OperationErrorDefinition,
  operationError,
  operationFailure,
} from "./operation-error.js";
import { valueProvider } from "./provider.js";

const repositoryToken = dependency<{ find(id: string): { id: string } }>("accounts.repository");
const transactionToken = unitOfWorkDependency<{
  readonly accounts: { save(id: string): { id: string } };
}>("database.primary");
const accountNotFound = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
  details: z.object({ accountId: z.string() }),
});
const rateLimited = operationError({
  code: "RATE_LIMITED",
  status: 429,
  message: "Try again later",
  headers: ["Retry-After"] as const,
});
operationFailure(rateLimited, { headers: { "Retry-After": "120" } });
// @ts-expect-error declared failure headers are required
operationFailure(rateLimited);
const widenedError: OperationErrorDefinition<string, number, undefined> = operationError({
  code: "WIDENED_ERROR",
  status: 400,
  message: "Widened error",
});
operationFailure(widenedError);
operationFailure(accountNotFound, {
  details: { accountId: "a" },
  // @ts-expect-error undeclared failure headers cannot be supplied
  headers: { "Retry-After": "120" },
});
const operation = defineOperation({
  id: "accounts.get",
  input: { params: z.object({ accountId: z.string() }) },
  output: {
    200: z.object({ id: z.string() }),
    202: z.object({ queued: z.literal(true) }),
  },
  successStatus: 200,
  errors: [accountNotFound],
  access: permission("accounts:read"),
  transaction: "none",
  dependencies: { accounts: repositoryToken },
  handler: ({ input, services }) =>
    input.params.accountId === "queued"
      ? respond(202, { queued: true as const }, { headers: { ETag: '"queued"' } })
      : services.accounts.find(input.params.accountId),
});
const module = defineModule({
  id: "accounts",
  operations: [operation],
  providers: [valueProvider(repositoryToken, { find: (id) => ({ id }) })],
  imports: [],
  exports: [],
});
const executor = createExecutor(defineApp({ id: "accounts-api", modules: [module] }));

const transactionController: UnitOfWork<{
  readonly accounts: { save(id: string): { id: string } };
}> = {
  kind: "ship.unit-of-work",
  id: "database.primary",
  run: async (_mode, work) => work({ accounts: { save: (id) => ({ id }) } }),
};
const saveOperation = defineOperation({
  id: "accounts.save",
  input: { body: z.object({ accountId: z.string() }) },
  output: { 200: z.object({ id: z.string() }) },
  successStatus: 200,
  errors: [],
  access: permission("accounts:write"),
  transaction: "write",
  dependencies: { tx: transactionToken },
  handler: ({ input, services }) => {
    const saved: { id: string } = services.tx.accounts.save(input.body.accountId);
    // @ts-expect-error the controller and base database are not handler capabilities
    services.tx.run;
    // @ts-expect-error only declared transaction repositories are visible
    services.tx.payments;
    return saved;
  },
});
const saveModule = defineModule({
  id: "accounts",
  operations: [saveOperation],
  providers: [valueProvider(transactionToken, transactionController)],
  imports: [],
  exports: [],
});
const transactionExecutor = createExecutor(
  defineApp({ id: "accounts-write-api", modules: [saveModule] }),
);

async function verifyExecutorTypes(): Promise<void> {
  const result = await executor.run(
    "accounts.get",
    { params: { accountId: "account-1" } },
    { actor: { id: "actor-1", kind: "human", permissions: new Set(["accounts:read"]) } },
  );

  if (result.ok) {
    result.headers?.etag satisfies string | undefined;
    if (result.status === 200) {
      const id: string = result.data.id;
      void id;
    } else {
      const queued: true = result.data.queued;
      void queued;
    }
  } else if (result.error.code === "ACCOUNT_NOT_FOUND") {
    const accountId: string | undefined = result.error.details?.accountId;
    void accountId;
  }

  // @ts-expect-error operation ids are the exact compiled application keys
  await executor.run("accounts.missing", { params: { accountId: "account-1" } });
  // @ts-expect-error required input locations and their schema inputs are preserved
  await executor.run("accounts.get", { body: { accountId: "account-1" } });

  await transactionExecutor.run(
    "accounts.save",
    { body: { accountId: "account-1" } },
    { actor: { id: "actor-1", kind: "human", permissions: new Set(["accounts:write"]) } },
  );
}

async function verifyTryRunTypes(): Promise<void> {
  const outcome = await executor.tryRun("accounts.get", { params: { accountId: "account-1" } });
  if (outcome.ok) {
    outcome.status satisfies 200 | 202;
  } else if (outcome.status === 500) {
    // The absorbed throw keeps its typed diagnostic and the original error.
    const code: string | undefined = outcome.error.details?.code;
    const original: Error = outcome.cause;
    void [code, original];
  } else {
    outcome.error.code satisfies "ACCOUNT_NOT_FOUND" | (string & {});
  }
  // @ts-expect-error tryRun keeps the same exact operation ids as run
  await executor.tryRun("accounts.missing", { params: { accountId: "account-1" } });
}

void verifyTryRunTypes;

operationFailure(accountNotFound, { details: { accountId: "account-1" } });
// @ts-expect-error errors with a details schema require typed details
operationFailure(accountNotFound);

void verifyExecutorTypes;
