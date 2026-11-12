import {
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  publicAccess,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";

/**
 * One operation with a non-default transaction policy, so the graph commands
 * can show the policy the client contract no longer carries.
 */
const database = unitOfWorkDependency<Record<string, never>>("database.primary");
const unitOfWork: UnitOfWork<Record<string, never>> = {
  kind: "ship.unit-of-work",
  id: "database.primary",
  run: async (_mode, work) => work({}),
};
const stale = operationError({ code: "ACCOUNT_STALE", status: 409, message: "Account is stale" });

const renameAccount = defineOperation({
  id: "accounts.rename",
  transport: http.post("/accounts/:accountId/rename"),
  input: {
    params: z.object({ accountId: z.string() }),
    body: z.object({ name: z.string().min(1) }),
  },
  output: { 200: z.object({ accountId: z.string(), name: z.string() }) },
  successStatus: 200,
  errors: [stale],
  access: publicAccess(),
  transaction: {
    mode: "write",
    isolation: "serializable",
    retry: { on: ["serialization", "ACCOUNT_STALE"], attempts: 3 },
  },
  dependencies: { database },
  handler: ({ input }) => ({ accountId: input.params.accountId, name: input.body.name }),
});

const readAccount = defineOperation({
  id: "accounts.read",
  transport: http.get("/accounts/:accountId"),
  input: { params: z.object({ accountId: z.string() }) },
  output: { 200: z.object({ accountId: z.string() }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "read",
  dependencies: { database },
  handler: ({ input }) => ({ accountId: input.params.accountId }),
});

export const app = defineApp({
  id: "transaction-policy-fixture",
  modules: [
    defineModule({
      id: "accounts",
      operations: [renameAccount, readAccount],
      providers: [valueProvider(database, unitOfWork)],
      imports: [],
      exports: [],
    }),
  ],
});
