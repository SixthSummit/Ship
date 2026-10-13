import {
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  publicAccess,
  respond,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApplicationContractOf } from "./application.js";
import { createHttpOperationClient, OperationClientError } from "./client.js";
import { projectClientContract } from "./project.js";
import { contractSchema } from "./schema.js";

const missingAccount = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
  details: z.object({ accountId: z.string() }),
});

const updateAccount = defineOperation({
  id: "accounts.update",
  transport: http.patch("/accounts/:accountId"),
  input: {
    params: z.object({ accountId: z.string() }),
    query: z.object({ tags: z.array(z.string()), notify: z.enum(["true", "false"]) }),
    headers: z.object({ "x-client-id": z.string() }),
    body: z.object({ name: z.string().trim().min(1) }),
  },
  output: { 200: z.object({ accountId: z.string(), name: z.string(), tags: z.array(z.string()) }) },
  successStatus: 200,
  errors: [missingAccount],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ input }) => {
    if (input.params.accountId === "missing") {
      throw operationFailure(missingAccount, { details: { accountId: "missing" } });
    }
    return respond(
      200,
      {
        accountId: input.params.accountId,
        name: input.body.name,
        tags: input.query.tags,
      },
      { headers: { ETag: '"account-v2"' } },
    );
  },
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
  handler: () => new Date("2026-09-04T12:00:00.000Z"),
});

const download = defineOperation({
  id: "files.download",
  transport: http.get("/files/archive", {
    response: "binary",
    contentType: "application/octet-stream",
  }),
  input: {},
  output: { 200: z.instanceof(Uint8Array) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => new Uint8Array([0, 127, 255]),
});

const exportFiles = defineOperation({
  id: "files.export",
  transport: http.get("/files/export", {
    response: "binary",
    contentTypes: [
      "text/csv; charset=utf-8",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  }),
  input: { query: z.object({ format: z.enum(["csv", "xlsx"]) }) },
  output: { 200: z.instanceof(Uint8Array) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ input }) =>
    respond(200, new Uint8Array([0, 127, 255]), {
      headers: {
        "Content-Type":
          input.query.format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    }),
});

const uploadRaw = defineOperation({
  id: "files.upload-raw",
  transport: http.post("/files/raw", {
    requestBody: http.body.raw({ maxBytes: 1_024, contentTypes: ["application/pdf"] }),
  }),
  input: {
    body: contractSchema(z.instanceof(Uint8Array), {
      jsonSchema: { type: "string", format: "binary" },
    }),
  },
  output: { 201: z.object({ size: z.number().int() }) },
  successStatus: 201,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ input }) => ({ size: input.body.byteLength }),
});

const uploadMultipart = defineOperation({
  id: "files.upload-multipart",
  transport: http.post("/files/multipart", {
    requestBody: http.body.multipart({
      maxBytes: 2_048,
      maxFileBytes: 1_024,
      maxFiles: 1,
      maxFields: 1,
      maxFieldBytes: 32,
    }),
  }),
  input: {
    body: contractSchema(z.instanceof(FormData), {
      jsonSchema: {
        type: "object",
        properties: {
          file: { type: "string", format: "binary" },
          label: { type: "string" },
        },
        required: ["file"],
      },
    }),
  },
  output: { 201: z.object({ name: z.string(), label: z.string(), size: z.number().int() }) },
  successStatus: 201,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ input }) => {
    const file = input.body.get("file");
    if (!(file instanceof Blob)) throw new Error("file is required");
    return {
      name: String(Reflect.get(file, "name")),
      label: String(input.body.get("label")),
      size: file.size,
    };
  },
});

const clearFiles = defineOperation({
  id: "files.clear",
  transport: http.delete("/files"),
  input: {},
  output: { 204: z.undefined() },
  successStatus: 204,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => undefined,
});

const application = defineApp({
  id: "client-fixture",
  modules: [
    defineModule({
      id: "accounts",
      operations: [updateAccount],
      providers: [],
      imports: [],
      exports: [],
    }),
    defineModule({
      id: "clock",
      operations: [readClock],
      providers: [],
      imports: [],
      exports: [],
    }),
    defineModule({
      id: "files",
      operations: [download, exportFiles, uploadRaw, uploadMultipart, clearFiles],
      providers: [],
      imports: [],
      exports: [],
    }),
  ],
});

function fixtureClient(overrides: Parameters<typeof createHttpOperationClient>[1] = {}) {
  const hono = createHonoAdapter(application, { generateRequestId: () => "generated-request" });
  return createHttpOperationClient<ApplicationContractOf<typeof application>>(
    projectClientContract(application),
    {
      baseUrl: "https://api.example.test/",
      fetch: (input, init) => hono.request(input, init),
      codecs: {
        "date.iso": {
          decode: (value) => new Date(String(value)),
        },
      },
      ...overrides,
    },
  );
}

describe("createHttpOperationClient", () => {
  it("accepts the declared literal-key query mode in a projected contract", () => {
    const operation = defineOperation({
      id: "lookup.get",
      transport: http.get("/lookup", { queryParsing: "literal-keys" }),
      input: { query: z.object({ handle: z.string() }) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const app = defineApp({
      id: "literal-query-fixture",
      modules: [
        defineModule({
          id: "lookup",
          operations: [operation],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const contract = projectClientContract(app);
    expect(contract.operations[0]?.transport.metadata.queryParsing).toBe("literal-keys");
    expect(() =>
      createHttpOperationClient(contract, { baseUrl: "https://api.example.test" }),
    ).not.toThrow();
  });

  it("accepts a declared JSON compatibility media policy in the client contract", () => {
    const operation = defineOperation({
      id: "compat.update",
      transport: http.put("/compat", {
        requestBody: http.body.json({
          onNonJsonContentType: "ignore",
          onInvalidJson: "ignore",
          onEmptyJsonBody: "reject",
        }),
      }),
      input: { body: z.unknown().optional() },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const app = defineApp({
      id: "compat-policy-fixture",
      modules: [
        defineModule({
          id: "compat",
          operations: [operation],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const contract = projectClientContract(app);
    expect(contract.operations[0]?.transport?.metadata?.requestBody).toEqual({
      mode: "json",
      onNonJsonContentType: "ignore",
      onInvalidJson: "ignore",
      onEmptyJsonBody: "reject",
    });
    expect(() =>
      createHttpOperationClient(contract, { baseUrl: "https://api.example.test" }),
    ).not.toThrow();
  });

  it("returns declared Retry-After metadata and rejects a missing header", async () => {
    const limited = operationError({
      code: "BUG_REPORT_RATE_LIMITED",
      status: 429,
      message: "Try again later",
      headers: ["Retry-After"] as const,
    });
    const operation = defineOperation({
      id: "bugs.report",
      transport: http.post("/bug-reports"),
      input: {},
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [limited],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => {
        throw operationFailure(limited, { headers: { "Retry-After": "120" } });
      },
    });
    const app = defineApp({
      id: "rate-limit-fixture",
      modules: [
        defineModule({
          id: "bugs",
          operations: [operation],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const contract = projectClientContract(app);
    expect(contract.operations[0]?.errors[0]?.headers).toEqual(["Retry-After"]);
    const adapter = createHonoAdapter(app);
    const client = createHttpOperationClient<ApplicationContractOf<typeof app>>(contract, {
      baseUrl: "http://fixture.test",
      fetch: (input, init) => adapter.fetch(new Request(input, init)),
    });
    await expect(client.call("bugs.report", {})).resolves.toMatchObject({
      ok: false,
      status: 429,
      metadata: { retryAfter: "120" },
    });

    const missingHeaderClient = createHttpOperationClient<ApplicationContractOf<typeof app>>(
      contract,
      {
        baseUrl: "http://fixture.test",
        fetch: async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { code: "BUG_REPORT_RATE_LIMITED", message: "Later" },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json", "x-request-id": "rate-2" },
            },
          ),
      },
    );
    await expect(missingHeaderClient.call("bugs.report", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
    const emptyHeaderClient = createHttpOperationClient<ApplicationContractOf<typeof app>>(
      contract,
      {
        baseUrl: "http://fixture.test",
        fetch: async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { code: "BUG_REPORT_RATE_LIMITED", message: "Later" },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "x-request-id": "rate-3",
                "retry-after": "",
              },
            },
          ),
      },
    );
    await expect(emptyHeaderClient.call("bugs.report", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
  });
  it("serializes every HTTP input location and returns typed success metadata", async () => {
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      createHonoAdapter(application, { generateRequestId: () => "request-client-1" }).request(
        input,
        init,
      ),
    );
    const client = fixtureClient({ fetch: fetch as typeof globalThis.fetch });

    const result = await client.call(
      "accounts.update",
      {
        params: { accountId: "account/one" },
        query: { tags: ["alpha", "beta"], notify: "true" },
        headers: { "x-client-id": "angular" },
        body: { name: "  Ada  " },
      },
      {
        headers: { Authorization: "Bearer test" },
        idempotencyKey: "idem-1",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: { accountId: "account/one", name: "Ada", tags: ["alpha", "beta"] },
      requestId: "request-client-1",
      metadata: {
        requestId: "request-client-1",
        etag: '"account-v2"',
        contentType: "application/json; charset=UTF-8",
      },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.example.test/accounts/account%2Fone?notify=true&tags%5B%5D=alpha&tags%5B%5D=beta",
    );
    expect(new Headers(init?.headers).get("x-client-id")).toBe("angular");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-1");
  });

  it("returns declared failures as values with details and request identity", async () => {
    const result = await fixtureClient().call("accounts.update", {
      params: { accountId: "missing" },
      query: { tags: [], notify: "false" },
      headers: { "x-client-id": "angular" },
      body: { name: "Ada" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        status: 404,
        requestId: "generated-request",
        error: {
          code: "ACCOUNT_NOT_FOUND",
          message: "Account not found",
          details: { accountId: "missing" },
          requestId: "generated-request",
        },
      }),
    );
  });

  it("returns validation failures as framework values", async () => {
    const result = await fixtureClient().call("accounts.update", {
      params: { accountId: "one" },
      query: { tags: [], notify: "false" },
      headers: { "x-client-id": "angular" },
      body: { name: "" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: {
        code: "VALIDATION_ERROR",
        details: { issues: [{ path: ["body", "name"] }] },
      },
    });
  });

  it("uses explicit codecs for non-JSON domain values", async () => {
    const result = await fixtureClient().call("clock.read", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeInstanceOf(Date);
      expect(result.data.toISOString()).toBe("2026-09-04T12:00:00.000Z");
    }
  });

  it("sends byte-exact raw bodies with the contract media type", async () => {
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      createHonoAdapter(application, { generateRequestId: () => "raw-request" }).request(
        input,
        init,
      ),
    );
    const bytes = new Uint8Array([0, 127, 255]);
    const result = await fixtureClient({ fetch: fetch as typeof globalThis.fetch }).call(
      "files.upload-raw",
      { body: bytes },
    );

    expect(result).toMatchObject({ ok: true, status: 201, data: { size: 3 } });
    const [, init] = fetch.mock.calls[0];
    expect(init?.body).toBe(bytes);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/pdf");
  });

  it("passes FormData through so fetch owns the multipart boundary", async () => {
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      createHonoAdapter(application, { generateRequestId: () => "multipart-request" }).request(
        input,
        init,
      ),
    );
    const body = new FormData();
    body.set("label", "avatar");
    body.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "avatar.png");
    const result = await fixtureClient({ fetch: fetch as typeof globalThis.fetch }).call(
      "files.upload-multipart",
      { body },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      data: { name: "avatar.png", label: "avatar", size: 3 },
    });
    const [, init] = fetch.mock.calls[0];
    expect(init?.body).toBe(body);
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("rejects bodies that conflict with the declared request mode", async () => {
    const client = fixtureClient();
    await expect(
      client.call(
        "files.upload-multipart",
        { body: new FormData() },
        {
          headers: { "content-type": "multipart/form-data" },
        },
      ),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_BODY_INVALID" });
    await expect(
      client.call("files.upload-raw", { body: { not: "bytes" } } as never),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_BODY_INVALID" });
  });

  it.each([".", ".."])("rejects normalized dot path segment %s before Fetch", async (accountId) => {
    const fetch = vi.fn();
    const client = fixtureClient({ fetch });
    await expect(
      client.call("accounts.update", {
        params: { accountId },
        query: { tags: [], notify: "false" },
        headers: { "x-client-id": "angular" },
        body: { name: "test" },
      } as never),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_INPUT_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a 205 through direct execution, HTTP, and the generated client", async () => {
    const operation = defineOperation({
      id: "files.reset",
      transport: http.post("/reset"),
      input: {},
      output: { 205: z.undefined() },
      successStatus: 205,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => undefined,
    });
    const app = defineApp({
      id: "reset",
      modules: [
        defineModule({
          id: "files",
          operations: [operation],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const adapter = createHonoAdapter(app);
    const client = createHttpOperationClient<ApplicationContractOf<typeof app>>(
      projectClientContract(app),
      {
        baseUrl: "http://fixture.test",
        fetch: (input, init) => adapter.fetch(new Request(input, init)),
      },
    );
    await expect(createExecutor(app).run("files.reset", {})).resolves.toMatchObject({
      ok: true,
      status: 205,
      data: undefined,
    });
    await expect(client.call("files.reset", {})).resolves.toMatchObject({
      ok: true,
      status: 205,
      data: undefined,
    });
  });

  it("preserves binary bytes and 204 no-body semantics", async () => {
    const client = fixtureClient();
    const binary = await client.call("files.download", {});
    const empty = await client.call("files.clear", {});

    expect(binary).toMatchObject({ ok: true, status: 200, data: new Uint8Array([0, 127, 255]) });
    expect(empty).toMatchObject({ ok: true, status: 204, data: undefined });
  });

  it("accepts only declared binary download representations", async () => {
    const client = fixtureClient();
    for (const format of ["csv", "xlsx"] as const) {
      const result = await client.call("files.export", { query: { format } });
      expect(result).toMatchObject({ ok: true, status: 200, data: new Uint8Array([0, 127, 255]) });
    }
    const wrongType = fixtureClient({
      fetch: async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/pdf", "x-request-id": "unexpected-type" },
        }),
    });
    await expect(
      wrongType.call("files.export", { query: { format: "csv" } }),
    ).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
  });

  it("throws protocol errors for malformed, undeclared, and uncorrelated responses", async () => {
    const malformed = fixtureClient({
      fetch: async () =>
        new Response("not-json", { status: 502, headers: { "x-request-id": "proxy-1" } }),
    });
    const undeclared = fixtureClient({
      fetch: async () =>
        Response.json(
          { success: false, error: { code: "SURPRISE", message: "nope" } },
          { status: 418, headers: { "x-request-id": "server-1" } },
        ),
    });
    const uncorrelated = fixtureClient({
      fetch: async () => Response.json({ accountId: "one", name: "Ada", tags: [] }),
    });
    const wrongSuccessType = fixtureClient({
      fetch: async () =>
        Response.json(new Uint8Array([1]), {
          status: 200,
          headers: { "x-request-id": "wrong-content-1" },
        }),
    });

    await expect(malformed.call("files.clear", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
    await expect(undeclared.call("files.clear", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
    await expect(uncorrelated.call("files.clear", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
    await expect(wrongSuccessType.call("files.download", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
  });

  it("preserves unknown additive fields on declared failures", async () => {
    const client = fixtureClient({
      fetch: async () =>
        Response.json(
          {
            success: false,
            trace: "additive-envelope-field",
            error: {
              code: "ACCOUNT_NOT_FOUND",
              message: "Account not found",
              details: { accountId: "account-1" },
              category: "account",
            },
          },
          { status: 404, headers: { "x-request-id": "additive-1" } },
        ),
    });

    const result = await client.call("accounts.update", {
      params: { accountId: "account-1" },
      query: { tags: [], notify: "false" },
      headers: { "x-client-id": "angular" },
      body: { name: "Ada" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: { category: "account", requestId: "additive-1" },
    });
  });

  it("rejects framework codes returned with the wrong status", async () => {
    const client = fixtureClient({
      fetch: async () =>
        Response.json(
          { success: false, error: { code: "VALIDATION_ERROR", message: "Wrong status" } },
          { status: 422, headers: { "x-request-id": "wrong-status-1" } },
        ),
    });

    await expect(client.call("files.clear", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    });
  });

  it("requires declared input locations and flat query values", async () => {
    const client = fixtureClient();
    await expect(
      client.call("accounts.update", {
        params: { accountId: "one" },
        query: { tags: ["ok", { nested: true }], notify: "true" },
        headers: { "x-client-id": "angular" },
        body: { name: "Ada" },
      } as never),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_QUERY_INVALID" });
    await expect(
      client.call("accounts.update", {
        params: { accountId: "one" },
        query: { tags: [], notify: "true" },
        headers: { "x-client-id": "angular" },
      } as never),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_INPUT_INVALID" });
    await expect(
      client.call("files.clear", {}, { headers: { "bad header": "unsafe" } }),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_HEADER_INVALID" });
    await expect(
      client.call("files.clear", {}, { idempotencyKey: "unsafe\nvalue" }),
    ).rejects.toMatchObject({ code: "SHIP_CLIENT_HEADER_INVALID" });
  });

  it("fails explicitly when a required codec is not configured", async () => {
    const hono = createHonoAdapter(application, { generateRequestId: () => "codec-request" });
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
      projectClientContract(application),
      {
        baseUrl: "https://api.example.test",
        fetch: (input, init) => hono.request(input, init),
      },
    );

    await expect(client.call("clock.read", {})).rejects.toMatchObject({
      code: "SHIP_CLIENT_CODEC_MISSING",
      operationId: "clock.read",
    });
  });

  it("forwards keepalive to fetch only when set", async () => {
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      createHonoAdapter(application).request(input, init),
    );
    const client = fixtureClient({ fetch: fetch as typeof globalThis.fetch });

    await client.call("files.clear", {}, { keepalive: true });
    await client.call("files.clear", {}, { keepalive: false });
    await client.call("files.clear", {});
    await client.call("files.clear", {}, { keepalive: undefined });

    const inits = fetch.mock.calls.map(([, init]) => init);
    expect(inits[0]?.keepalive).toBe(true);
    expect(inits[1]?.keepalive).toBe(false);
    expect(Object.hasOwn(inits[2] ?? {}, "keepalive")).toBe(false);
    expect(Object.hasOwn(inits[3] ?? {}, "keepalive")).toBe(false);
  });

  it("keeps keepalive alongside signal, headers, and idempotency key", async () => {
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      createHonoAdapter(application).request(input, init),
    );
    const client = fixtureClient({ fetch: fetch as typeof globalThis.fetch });
    const controller = new AbortController();

    await client.call(
      "accounts.update",
      {
        params: { accountId: "account/one" },
        query: { tags: ["alpha"], notify: "false" },
        headers: { "x-client-id": "angular" },
        body: { name: "Ada" },
      },
      {
        signal: controller.signal,
        headers: { Authorization: "Bearer test" },
        idempotencyKey: "idem-keepalive",
        keepalive: true,
      },
    );

    const [, init] = fetch.mock.calls[0];
    expect(init?.keepalive).toBe(true);
    expect(init?.signal).toBe(controller.signal);
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("idem-keepalive");
  });

  it("leaves network failures and cancellation exceptional", async () => {
    const network = new TypeError("offline");
    const client = fixtureClient({
      fetch: async () => {
        throw network;
      },
    });

    await expect(client.call("files.clear", {})).rejects.toBe(network);
  });

  it("validates the runtime contract before accepting calls", () => {
    expect(() =>
      createHttpOperationClient({ schemaVersion: 2 } as never, {
        baseUrl: "https://api.example.test",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<OperationClientError>>({
        code: "SHIP_CLIENT_CONTRACT_INVALID",
      }),
    );

    const projected = projectClientContract(application);
    expect(() =>
      createHttpOperationClient<ApplicationContractOf<typeof application>>(
        { ...projected, operations: [...projected.operations, projected.operations[0]] },
        { baseUrl: "https://api.example.test" },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<OperationClientError>>({
        code: "SHIP_CLIENT_CONTRACT_INVALID",
        operationId: undefined,
      }),
    );

    for (const broken of [
      { ...projected, channels: [] },
      {
        ...projected,
        operations: projected.operations.map((operation) => ({ ...operation, publishes: "x" })),
      },
    ]) {
      expect(() =>
        createHttpOperationClient<ApplicationContractOf<typeof application>>(broken as never, {
          baseUrl: "https://api.example.test",
        }),
      ).toThrowError(
        expect.objectContaining<Partial<OperationClientError>>({
          code: "SHIP_CLIENT_CONTRACT_INVALID",
        }),
      );
    }
    // Manifests emitted before channels existed still validate.
    const { channels: _channels, ...legacy } = projected;
    expect(() =>
      createHttpOperationClient<ApplicationContractOf<typeof application>>(
        {
          ...legacy,
          operations: legacy.operations.map(({ publishes: _publishes, ...operation }) => operation),
        },
        { baseUrl: "https://api.example.test" },
      ),
    ).not.toThrow();

    const clear = projected.operations.find(({ id }) => id === "files.clear");
    expect(clear?.transport?.metadata).toBeDefined();
    expect(() =>
      createHttpOperationClient<ApplicationContractOf<typeof application>>(
        {
          ...projected,
          operations: projected.operations.map((operation) =>
            operation.id === "files.clear"
              ? {
                  ...operation,
                  transport: {
                    ...operation.transport,
                    metadata: {
                      ...operation.transport?.metadata,
                      requestBody: {
                        mode: "raw",
                        maxBytes: 1_024,
                        contentTypes: ["application/octet-stream"],
                      },
                    },
                  },
                }
              : operation,
          ),
        } as never,
        { baseUrl: "https://api.example.test" },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<OperationClientError>>({
        code: "SHIP_CLIENT_CONTRACT_INVALID",
        operationId: "files.clear",
      }),
    );
  });
});
