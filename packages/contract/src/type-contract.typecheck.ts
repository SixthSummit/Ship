import type { OperationClient } from "./client.js";
import type { ClientContract } from "./manifest.js";
import type { OperationStreamHandle } from "./stream.js";
import type { ClientTypeContract } from "./type-contract.js";

const manifest = {
  schemaVersion: 1,
  appId: "generated-type-fixture",
  fingerprint: `sha256:${"0".repeat(64)}`,
  operations: [
    {
      id: "accounts.read",
      input: {
        params: {
          vendor: "zod",
          jsonSchema: {
            type: "object",
            properties: { accountId: { type: "string" } },
            required: ["accountId"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "zod",
          jsonSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              role: { enum: ["admin", "member"] },
            },
            required: ["id", "role"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "ACCOUNT_NOT_FOUND",
          status: 404,
          message: "Account not found",
          details: {
            vendor: "zod",
            jsonSchema: {
              type: "object",
              properties: { accountId: { type: "string" } },
              required: ["accountId"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: { kind: "authenticated" },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: { method: "GET", path: "/accounts/:accountId", response: "json" },
      },
      publishes: ["accounts.activity"],
    },
    {
      id: "clock.ticks",
      input: {},
      success: [
        {
          status: 200,
          vendor: "zod",
          jsonSchema: {
            type: "object",
            properties: { ticks: { type: "integer" } },
            required: ["ticks"],
            additionalProperties: false,
          },
        },
      ],
      errors: [],
      access: { kind: "public" },
      transaction: "none",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: { method: "POST", path: "/clock/ticks", response: "stream" },
      },
      response: {
        mode: "stream",
        framing: "sse",
        frame: {
          vendor: "zod",
          jsonSchema: {
            type: "object",
            properties: { tick: { type: "integer" } },
            required: ["tick"],
            additionalProperties: false,
          },
        },
        terminal: {
          vendor: "zod",
          jsonSchema: {
            type: "object",
            properties: { ticks: { type: "integer" } },
            required: ["ticks"],
            additionalProperties: false,
          },
        },
        limits: { heartbeatMs: 1000, maxDurationMs: 5000, maxFrames: 10 },
      },
    },
    {
      id: "files.export",
      input: {},
      success: [
        {
          status: 200,
          vendor: "zod",
          jsonSchema: { type: "string", format: "binary" },
        },
      ],
      errors: [],
      access: { kind: "authenticated" },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "GET /files/export",
        metadata: {
          method: "GET",
          path: "/files/export",
          response: "binary",
          contentType: "text/csv; charset=utf-8",
          contentTypes: ["text/csv; charset=utf-8", "application/octet-stream"],
        },
      },
    },
    {
      id: "files.upload",
      input: {
        body: {
          vendor: "zod",
          jsonSchema: {
            type: "object",
            properties: { file: { type: "string", format: "binary" } },
            required: ["file"],
          },
        },
      },
      success: [{ status: 200, vendor: "zod", jsonSchema: { type: "object" } }],
      errors: [],
      access: { kind: "authenticated" },
      transaction: "none",
      transport: {
        kind: "http",
        binding: "POST /files/upload",
        metadata: {
          method: "POST",
          path: "/files/upload",
          requestBody: { mode: "multipart", maxBytes: 1024, maxFiles: 1, maxFileBytes: 1024 },
          response: "json",
        },
      },
    },
  ],
  channels: {
    "accounts.activity": {
      scope: "actor",
      payload: {
        vendor: "zod",
        jsonSchema: {
          type: "object",
          properties: { accountId: { type: "string" }, status: { enum: ["open", "closed"] } },
          required: ["accountId", "status"],
          additionalProperties: false,
        },
      },
      presence: true,
    },
  },
} as const satisfies ClientContract;

type ActivityChannel = AppContract["channels"]["accounts.activity"];
const activityScope: "actor" = null as unknown as ActivityChannel["scope"];
const activityPresence: true = null as unknown as ActivityChannel["presence"];
const activityPayload: { readonly accountId: string; readonly status: "open" | "closed" } =
  null as unknown as ActivityChannel["payload"];
void [activityScope, activityPresence, activityPayload];
// @ts-expect-error channel ids remain exact
const missingChannel: AppContract["channels"]["accounts.missing"] = null as never;
void missingChannel;

type AppContract = ClientTypeContract<typeof manifest>;
// Unary operations have no stream property, including under exact optional
// property checking used by packed consumers.
// @ts-expect-error only streaming operations carry a stream type
export type UnaryStream = AppContract["operations"]["accounts.read"]["stream"];
declare const client: OperationClient<AppContract>;

const result = client.call("accounts.read", { params: { accountId: "account-1" } });
void result;

async function narrowGeneratedResult(): Promise<void> {
  const response = await result;
  if (response.ok) {
    const id: string = response.data.id;
    const role: "admin" | "member" = response.data.role;
    void id;
    void role;
  } else if (response.status === 404) {
    const code: "ACCOUNT_NOT_FOUND" = response.error.code;
    const accountId: string = response.error.details.accountId;
    void code;
    void accountId;
  }
}

void narrowGeneratedResult;

const stream = client.call("clock.ticks", {});
stream satisfies OperationStreamHandle<{ readonly tick: number }, { readonly ticks: number }>;
void stream;

async function narrowBinaryResult(): Promise<void> {
  const response = await client.call("files.export", {});
  if (response.ok) {
    const bytes: Uint8Array = response.data;
    void bytes;
    // @ts-expect-error HTTP binary responses decode to bytes, not JSON-schema strings
    const asString: string = response.data;
    void asString;
  }
}
void narrowBinaryResult;

// @ts-expect-error operation IDs remain exact
client.call("accounts.missing", {});

// @ts-expect-error input locations and required fields remain exact
client.call("accounts.read", { params: {} });

client.call("files.upload", { body: new FormData() });
// @ts-expect-error multipart HTTP calls require FormData even when OpenAPI describes a file object
client.call("files.upload", { body: { file: "image.png" } });
