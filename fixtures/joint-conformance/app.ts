import {
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  publicAccess,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import { z } from "zod";

const base = { errors: [], access: publicAccess(), transaction: "none", dependencies: {} } as const;
const missing = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
  details: z.object({ accountId: z.string(), extension: z.string() }),
});
const get = defineOperation({
  ...base,
  id: "accounts.get",
  transport: http.get("/accounts/:accountId"),
  input: { params: z.object({ accountId: z.string() }) },
  output: { 200: z.object({ id: z.string(), ownerId: z.string().nullable() }) },
  successStatus: 200,
  errors: [missing],
  handler: ({ input }) => {
    if (input.params.accountId === "missing")
      throw operationFailure(missing, {
        details: { accountId: "missing", extension: "preserved" },
      });
    return { id: input.params.accountId, ownerId: null };
  },
});
const create = defineOperation({
  ...base,
  id: "accounts.create",
  transport: http.post("/accounts"),
  input: {
    body: z.object({
      name: z.string().min(1),
      note: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  output: { 201: z.object({ id: z.string(), name: z.string() }) },
  successStatus: 201,
  handler: ({ input }) => ({ id: "created", name: input.body.name }),
});
const remove = defineOperation({
  ...base,
  id: "accounts.delete",
  transport: http.delete("/accounts/:accountId"),
  input: { params: z.object({ accountId: z.string() }) },
  output: { 204: z.undefined() },
  successStatus: 204,
  handler: () => undefined,
});
const status = defineOperation({
  ...base,
  id: "public.status",
  transport: http.get("/status"),
  input: { query: z.object({ delayMs: z.coerce.number().optional() }) },
  output: { 200: z.object({ ready: z.boolean() }) },
  successStatus: 200,
  handler: async ({ input }) => {
    if (input.query.delayMs)
      await new Promise((resolve) => setTimeout(resolve, input.query.delayMs));
    return { ready: true };
  },
});
const expired = operationError({
  code: "SESSION_EXPIRED",
  status: 401,
  message: "Session expired",
});
const sessions = new Set<string>();
const sessionInput = { headers: z.object({ cookie: z.string().optional() }) };
const me = defineOperation({
  ...base,
  id: "session.me",
  transport: http.get("/session/me"),
  input: sessionInput,
  output: { 200: z.object({ id: z.string(), email: z.string() }) },
  successStatus: 200,
  errors: [expired],
  handler: ({ input }) => {
    const cookie = input.headers.cookie ?? "";
    if (!cookie.includes("sid=") || !sessions.has(cookie)) throw operationFailure(expired);
    return { id: "fixture-user", email: "fixture@example.test" };
  },
});
const refresh = defineOperation({
  ...base,
  errors: [expired],
  id: "session.refresh",
  transport: http.post("/session/refresh"),
  input: sessionInput,
  output: { 204: z.undefined() },
  successStatus: 204,
  handler: ({ input }) => {
    if (!input.headers.cookie?.includes("sid=")) throw operationFailure(expired);
    sessions.add(input.headers.cookie);
    return undefined;
  },
});
const signOut = defineOperation({
  ...base,
  id: "session.sign-out",
  transport: http.post("/session/sign-out"),
  input: sessionInput,
  output: { 204: z.undefined() },
  successStatus: 204,
  handler: ({ input }) => {
    sessions.delete(input.headers.cookie ?? "");
    return undefined;
  },
});
export const app = defineApp({
  id: "joint-conformance",
  modules: [
    defineModule({
      id: "accounts",
      operations: [get, create, remove],
      providers: [],
      imports: [],
      exports: [],
    }),
    defineModule({ id: "public", operations: [status], providers: [], imports: [], exports: [] }),
    defineModule({
      id: "session",
      operations: [me, refresh, signOut],
      providers: [],
      imports: [],
      exports: [],
    }),
  ],
});
export const adapter = createHonoAdapter(app, { generateRequestId: () => "joint-request" });
