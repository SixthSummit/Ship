/** Type-level CI contract for browser clients derived from application operations. */

import {
  defineApp,
  defineChannel,
  defineModule,
  defineOperation,
  defineWebhook,
  defineWebhookVerifier,
  idempotencyStoreDependency,
  operationError,
  publicAccess,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import type {
  ApplicationContractOf,
  ChannelPayloadNotProjectable,
  ChannelPayloadOf,
} from "./application.js";
import type { OperationClient } from "./client.js";
import { contractSchema } from "./schema.js";
import type { OperationStreamHandle } from "./stream.js";

const accountNotFound = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
  details: z.object({ accountId: z.string() }),
});

const readAccount = defineOperation({
  id: "accounts.read",
  transport: http.get("/accounts/:accountId"),
  input: { params: z.object({ accountId: z.string() }) },
  output: { 200: z.object({ accountId: z.string(), name: z.string() }) },
  successStatus: 200,
  errors: [accountNotFound],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ input }) => ({ accountId: input.params.accountId, name: "Ada" }),
});

const readClock = defineOperation({
  id: "clock.read",
  transport: http.get("/clock"),
  input: {},
  output: {
    200: contractSchema(z.date(), {
      jsonSchema: { type: "string", format: "date-time" },
      codec: "date.iso",
    }),
  },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => new Date(),
});

const recalculate = defineOperation({
  id: "accounts.recalculate",
  input: {},
  output: { 200: z.object({ accepted: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => ({ accepted: true as const }),
});

const tickFrame = z.object({ tick: z.number().int(), label: z.string().default("tick") });
const streamTicks = defineOperation({
  id: "clock.ticks",
  transport: http.post("/clock/ticks", {
    response: {
      mode: "stream",
      framing: "sse",
      frame: tickFrame,
      heartbeatMs: 1000,
      maxDurationMs: 5000,
      maxFrames: 10,
    },
  }),
  input: { body: z.object({ ticks: z.number().int() }) },
  output: { 200: z.object({ ticks: z.number().int() }) },
  successStatus: 200,
  errors: [accountNotFound],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: async ({ input, stream }) => {
    await stream.emit({ tick: 1 });
    return { ticks: input.body.ticks };
  },
});

// Channel payloads: a Zod schema and a contractSchema() project; an opaque vendor does not.
const activity = defineChannel({
  id: "accounts.activity",
  scope: "actor",
  payload: z.object({ accountId: z.string(), version: z.number().int() }),
  presence: true,
});
const heartbeat = defineChannel({
  id: "accounts.heartbeat",
  scope: "tenant",
  payload: contractSchema(z.date(), { jsonSchema: { type: "string", format: "date-time" } }),
});
const opaque = defineChannel({
  id: "accounts.opaque",
  scope: "actor",
  payload: {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate: (value: unknown) => ({ value: value as { readonly n: number } }),
    },
  },
});

const application = defineApp({
  id: "client-types",
  modules: [
    defineModule({
      id: "accounts",
      operations: [readAccount, recalculate],
      providers: [],
      imports: [],
      exports: [],
      channels: [activity, heartbeat, opaque],
    }),
    defineModule({
      id: "clock",
      operations: [readClock, streamTicks],
      providers: [],
      imports: [],
      exports: [],
    }),
  ],
});

declare const client: OperationClient<ApplicationContractOf<typeof application>>;

/** Shape emitted into a client-only application contract package. */
type PublishedContract = {
  readonly operations: {
    readonly "accounts.read": {
      readonly transport: "http";
      readonly input: { readonly params: { readonly accountId: string } };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: { readonly accountId: string; readonly name: string };
          }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: {
              readonly code: "ACCOUNT_NOT_FOUND";
              readonly message: string;
              readonly details: { readonly accountId: string };
            };
          };
    };
  };
};
declare const publishedClient: OperationClient<PublishedContract>;

async function verifyClientTypes(): Promise<void> {
  const result = await client.call("accounts.read", { params: { accountId: "account-1" } });
  if (result.ok) {
    const name: string = result.data.name;
    const status: 200 = result.status;
    void name;
    void status;
  } else if (result.error.code === "ACCOUNT_NOT_FOUND") {
    const accountId: string | undefined = result.error.details?.accountId;
    void accountId;
  } else if (result.error.code === "VALIDATION_ERROR") {
    result.error.details?.issues satisfies
      | readonly { readonly path: readonly (string | number)[] }[]
      | undefined;
  }
  if (!result.ok && result.status === 404) {
    result.error.code satisfies "ACCOUNT_NOT_FOUND";
  }

  const clock = await client.call("clock.read", {});
  if (clock.ok) clock.data satisfies Date;

  const stream = client.call("clock.ticks", { body: { ticks: 3 } });
  stream satisfies OperationStreamHandle<
    { readonly tick: number; readonly label: string },
    { readonly ticks: number }
  >;
  for await (const frame of stream.frames) {
    const tick: number = frame.tick;
    const label: string = frame.label;
    void tick;
    void label;
  }
  const terminal: { readonly ticks: number } | undefined = await stream.terminal;
  const status: "connecting" | "open" | "closed" | "error" | "aborted" = stream.status;
  stream.abort();
  void terminal;
  void status;
  // @ts-expect-error stream handles are synchronous, not promises
  await client.call("clock.ticks", { body: { ticks: 3 } }).then(() => undefined);

  // @ts-expect-error operation ids are the exact compiled application keys
  await client.call("accounts.missing", {});
  // @ts-expect-error input locations and schema inputs are preserved
  await client.call("accounts.read", { body: { accountId: "account-1" } });
  // @ts-expect-error operations without an HTTP transport are not remotely callable
  await client.call("accounts.recalculate", {});

  const published = await publishedClient.call("accounts.read", {
    params: { accountId: "account-1" },
  });
  if (published.ok) published.data.name satisfies string;
  // @ts-expect-error a client-only contract preserves exact operation ids
  await publishedClient.call("accounts.missing", {});
}

void verifyClientTypes;

// Inbound webhooks are provider-facing and never appear in the browser contract.
{
  const verifier = defineWebhookVerifier({
    id: "fixture",
    guarantees: { signature: true, freshness: false, replay: false },
    verify: () => ({ ok: true }),
  });
  const hook = defineWebhook({
    id: "accounts.hook",
    path: "/webhooks/fixture",
    provider: webhookVerifierToken({ verifier, secret: webhookSecret("s") }),
    body: { maxBytes: 1024, mediaTypes: ["application/json"] },
    idempotency: {
      windowMs: 1,
      store: idempotencyStoreDependency("platform.idempotency"),
      inFlight: { kind: "retry", status: 409 },
    },
    output: { 200: z.object({ ok: z.boolean() }) },
    successStatus: 200,
    transaction: "none",
    dependencies: {},
    handler: () => ({ ok: true }),
  });
  const withWebhook = defineApp({
    id: "webhook-typing",
    modules: [
      defineModule({
        id: "accounts",
        operations: [hook.operation],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
  type WebhookAppContract = ApplicationContractOf<typeof withWebhook>;
  const keys: keyof WebhookAppContract["operations"] extends never ? true : false = true;
  void keys;
  const mixed = defineApp({
    id: "webhook-typing-mixed",
    modules: [
      defineModule({
        id: "accounts",
        operations: [readAccount, hook.operation, recalculate],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
  type MixedContract = ApplicationContractOf<typeof mixed>;
  const mixedKeys: keyof MixedContract["operations"] = "accounts.read";
  void mixedKeys;
  // Direct (non-HTTP) operations stay in the contract with transport "direct".
  const directKey: keyof MixedContract["operations"] = "accounts.recalculate";
  void directKey;
  const directTransport: MixedContract["operations"]["accounts.recalculate"]["transport"] =
    "direct";
  void directTransport;
  // @ts-expect-error webhook ids are removed from the client contract keys
  const hookKey: keyof MixedContract["operations"] = "accounts.hook";
  void hookKey;
}

// Channel ids and payload types are part of the application contract.
type Channels = ApplicationContractOf<typeof application>["channels"];
declare const channels: Channels;
channels["accounts.activity"].scope satisfies "actor";
channels["accounts.activity"].presence satisfies true;
channels["accounts.activity"].payload.accountId satisfies string;
channels["accounts.heartbeat"].payload satisfies Date;
// A payload the manifest cannot project is named as such instead of silently becoming unknown.
channels["accounts.opaque"].payload satisfies ChannelPayloadNotProjectable<"accounts.opaque">;
// @ts-expect-error the unprojectable payload is not the schema's output type
channels["accounts.opaque"].payload.n satisfies number;
// @ts-expect-error channel ids stay exact
channels["accounts.missing"].scope satisfies string;
type ChannelIds = keyof Channels;
const ids: ChannelIds[] = ["accounts.activity", "accounts.heartbeat", "accounts.opaque"];
void ids;
const projected: ChannelPayloadOf<typeof activity> = { accountId: "a", version: 1 };
void projected;
