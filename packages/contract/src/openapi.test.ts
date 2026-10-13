import {
  cacheBackendDependency,
  defineApp,
  defineModule,
  defineOperation,
  idempotencyStoreDependency,
  operationError,
  permission,
  providerAccess,
  publicAccess,
  systemAccess,
  valueProvider,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { projectOpenApi } from "./openapi.js";
import { contractSchema } from "./schema.js";

describe("projectOpenApi", () => {
  it("documents the required Retry-After header on a declared 429", () => {
    const limited = operationError({
      code: "BUG_REPORT_RATE_LIMITED",
      status: 429,
      message: "Try again later",
      headers: ["Retry-After"] as const,
    });
    const operation = defineOperation({
      id: "accounts.report-bug",
      transport: http.post("/bug-reports"),
      input: {},
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [limited],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const document = projectOpenApi(appWith(operation), { title: "Fixture", version: "1" });
    const path = document.paths["/bug-reports"] as Record<string, unknown>;
    expect(path.post).toMatchObject({
      responses: {
        429: {
          headers: {
            "Retry-After": { required: true, schema: { type: "string" } },
            "X-Request-Id": { required: true },
          },
        },
      },
    });
  });
  it("derives parameters, body, statuses, errors, and access from one operation", () => {
    const missing = operationError({
      code: "ACCOUNT_NOT_FOUND",
      status: 404,
      message: "Account not found",
      details: z.object({ accountId: z.string() }),
    });
    const operation = defineOperation({
      id: "accounts.update",
      transport: http.patch("/accounts/:accountId"),
      input: {
        params: z.object({ accountId: z.string().uuid() }),
        query: z.object({ tags: z.array(z.string()).optional(), notify: z.boolean().optional() }),
        headers: z.object({ "if-match": z.string() }),
        body: z.object({ name: z.string().min(1) }),
      },
      output: { 200: z.object({ accountId: z.string(), name: z.string() }) },
      successStatus: 200,
      errors: [missing],
      access: permission("accounts:update"),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ accountId: input.params.accountId, name: input.body.name }),
    });
    const app = appWith(operation);

    const document = projectOpenApi(app, {
      title: "Accounts API",
      version: "1.2.3",
      serverUrls: ["https://api.example.test"],
    });
    const projected = document.paths["/accounts/{accountId}"] as Record<string, unknown>;
    const patch = projected.patch as Record<string, unknown>;

    expect(document.openapi).toBe("3.1.0");
    expect(document["x-ship-app-id"]).toBe("openapi-fixture");
    expect(document["x-ship-contract-fingerprint"]).toMatch(/^sha256:/u);
    expect(patch.operationId).toBe("accounts.update");
    expect(patch["x-ship-access"]).toEqual({
      kind: "permissions",
      mode: "all",
      permissions: ["accounts:update"],
    });
    expect(patch.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "accountId", in: "path", required: true }),
        expect.objectContaining({ name: "tags", in: "query", style: "form", explode: true }),
        expect.objectContaining({ name: "if-match", in: "header", required: true }),
      ]),
    );
    expect(patch.requestBody).toMatchObject({
      required: true,
      content: { "application/json": { schema: { type: "object" } } },
    });
    expect(Object.keys(patch.responses as object)).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "413",
      "415",
      "500",
    ]);
    expect(patch.responses).toMatchObject({
      200: { content: { "application/json; charset=UTF-8": {} } },
      400: {
        content: {
          "application/json": {
            schema: { properties: { error: { properties: { details: {} } } } },
          },
        },
      },
      403: {
        content: {
          "application/json": {
            schema: { properties: { error: { properties: { details: {} } } } },
          },
        },
      },
    });
    expect(JSON.stringify(patch.responses)).toContain("requiredPermissions");
    expect(JSON.stringify(patch.responses)).toContain("issues");
    expect(JSON.stringify(document)).not.toContain("handler");
  });

  it("uses the exact declared success media type", () => {
    const operation = defineOperation({
      id: "accounts.export",
      transport: http.get("/accounts/export", {
        response: "binary",
        contentType: "application/pdf",
      }),
      input: {},
      output: { 200: z.instanceof(Uint8Array) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => new Uint8Array(),
    });
    const document = projectOpenApi(appWith(operation), { title: "Fixture", version: "1" });
    const path = document.paths["/accounts/export"] as Record<string, unknown>;

    expect(path.get).toMatchObject({
      responses: {
        200: {
          content: {
            "application/pdf": { schema: { type: "string", format: "binary" } },
          },
        },
      },
    });
  });

  it("projects every declared binary success media type", () => {
    const operation = defineOperation({
      id: "accounts.export-multiple",
      transport: http.get("/accounts/export-multiple", {
        response: "binary",
        contentTypes: [
          "text/csv; charset=utf-8",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
      }),
      input: {},
      output: { 200: z.instanceof(Uint8Array) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => new Uint8Array(),
    });
    const document = projectOpenApi(appWith(operation), { title: "Fixture", version: "1" });
    const path = document.paths["/accounts/export-multiple"] as Record<string, unknown>;
    expect(path.get).toMatchObject({
      responses: {
        200: {
          content: {
            "text/csv; charset=utf-8": { schema: { type: "string", format: "binary" } },
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
      },
    });
  });

  it.each([
    [
      "raw",
      http.body.raw({ maxBytes: 4_096, contentTypes: ["application/pdf", "image/png"] }),
      ["application/pdf", "image/png"],
    ],
    [
      "multipart",
      http.body.multipart({ maxBytes: 8_192, maxFileBytes: 4_096 }),
      ["multipart/form-data"],
    ],
  ] as const)("projects %s request body media types and limits", (_mode, requestPolicy, mediaTypes) => {
    const operation = defineOperation({
      id: "accounts.upload",
      transport: http.post("/accounts/upload", { requestBody: requestPolicy }),
      input: {
        body: contractSchema(
          requestPolicy.mode === "raw" ? z.instanceof(Uint8Array) : z.instanceof(FormData),
          {
            jsonSchema:
              requestPolicy.mode === "raw"
                ? { type: "string", format: "binary" }
                : {
                    type: "object",
                    properties: { file: { type: "string", format: "binary" } },
                  },
          },
        ),
      },
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const document = projectOpenApi(appWith(operation), { title: "Fixture", version: "1" });
    const path = document.paths["/accounts/upload"] as Record<string, unknown>;
    const post = path.post as Record<string, unknown>;
    const requestBody = post.requestBody as Record<string, unknown>;

    expect(Object.keys(requestBody.content as object)).toEqual(mediaTypes);
    expect(requestBody["x-ship-request-body-policy"]).toEqual(requestPolicy);
  });

  it.each([
    ["system", systemAccess(), { kind: "system" }],
    [
      "provider",
      providerAccess("stripe.webhooks"),
      { kind: "provider", provider: "stripe.webhooks" },
    ],
  ])("projects %s actor-kind access with its authorization failure", (kind, access, projected) => {
    const operation = defineOperation({
      id: "accounts.dispatch",
      transport: http.post("/accounts/dispatch"),
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access,
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const document = projectOpenApi(appWith(operation), { title: "Fixture", version: "1" });
    const post = (document.paths["/accounts/dispatch"] as Record<string, Record<string, unknown>>)
      .post!;

    expect(post["x-ship-access"]).toEqual(projected);
    expect(Object.keys(post.responses as object)).toEqual(["200", "401", "403", "500"]);
    expect(JSON.stringify(post.responses)).toContain(`Operation requires a ${kind} actor`);
    expect(JSON.stringify(post.responses)).toContain("requiredActorKind");
  });

  it("adds the IDEMPOTENT_IN_FLIGHT response for idempotent operations", () => {
    const operation = defineOperation({
      id: "accounts.create",
      transport: http.post("/accounts"),
      input: { body: z.object({ key: z.string() }) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      idempotency: {
        key: (input) => input.body.key,
        windowMs: 1_000,
        store: idempotencyStoreDependency("platform.idempotency"),
      },
      handler: () => ({ ok: true as const }),
    });
    const module = defineModule({
      id: "accounts",
      operations: [operation],
      providers: [
        valueProvider(idempotencyStoreDependency("platform.idempotency"), {
          kind: "ship.idempotency-store",
        } as never),
      ],
      imports: [],
      exports: [],
    });
    const document = projectOpenApi(defineApp({ id: "openapi-fixture", modules: [module] }), {
      title: "Fixture",
      version: "1",
    });
    const post = (document.paths["/accounts"] as Record<string, Record<string, unknown>>).post!;

    expect(Object.keys(post.responses as object)).toEqual([
      "200",
      "400",
      "409",
      "413",
      "415",
      "500",
    ]);
    expect(JSON.stringify(post.responses)).toContain("IDEMPOTENT_IN_FLIGHT");
  });

  it("is deterministic and records operations without an HTTP projection", () => {
    const direct = defineOperation({
      id: "accounts.recalculate",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const app = appWith(direct);
    const first = projectOpenApi(app, { title: "Fixture", version: "1" });
    const second = projectOpenApi(app, { title: "Fixture", version: "1" });

    expect(second).toEqual(first);
    expect(first.paths).toEqual({});
    expect(first["x-ship-unbound-operations"]).toEqual(["accounts.recalculate"]);
  });

  it.each([
    [
      "mismatched path parameters",
      defineOperation({
        id: "accounts.read",
        transport: http.get("/accounts/:accountId"),
        input: { params: z.object({ wrongId: z.string() }) },
        output: { 200: z.string() },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: {},
        handler: () => "ok",
      }),
      "SHIP_CONTRACT_PATH_PARAMETER_MISMATCH",
    ],
    [
      "missing path parameters",
      defineOperation({
        id: "accounts.read",
        transport: http.get("/accounts/:accountId"),
        input: {},
        output: { 200: z.string() },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: {},
        handler: () => "ok",
      }),
      "SHIP_CONTRACT_PATH_PARAMETER_MISMATCH",
    ],
    [
      "GET body",
      defineOperation({
        id: "accounts.read",
        transport: http.get("/accounts"),
        input: { body: z.object({ id: z.string() }) },
        output: { 200: z.string() },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: {},
        handler: () => "ok",
      }),
      "SHIP_CONTRACT_GET_BODY_UNSUPPORTED",
    ],
    [
      "uppercase header",
      defineOperation({
        id: "accounts.read",
        transport: http.get("/accounts"),
        input: { headers: z.object({ Authorization: z.string() }) },
        output: { 200: z.string() },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: {},
        handler: () => "ok",
      }),
      "SHIP_CONTRACT_PARAMETER_SCHEMA_INVALID",
    ],
  ] as const)("rejects %s with a stable diagnostic", (_name, operation, code) => {
    expect(() =>
      projectOpenApi(appWith(operation), { title: "Fixture", version: "1" }),
    ).toThrowError(expect.objectContaining({ code, operationId: "accounts.read" }));
  });
});

function appWith(operation: ReturnType<typeof defineOperation>) {
  return defineApp({
    id: "openapi-fixture",
    modules: [
      defineModule({
        id: "accounts",
        operations: [operation],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
}

describe("projectOpenApi cache policy", () => {
  it("documents the declared Cache-Control and the x-ship-cache observation", () => {
    const cacheToken = cacheBackendDependency("platform.cache");
    const read = defineOperation({
      id: "accounts.summary",
      transport: http.get("/accounts/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 20_000, scope: "public", tags: ["accounts"] },
      handler: () => ({ total: 1 }),
    });
    const app = defineApp({
      id: "contract-fixture",
      modules: [
        defineModule({
          id: "accounts",
          operations: [read],
          providers: [valueProvider(cacheToken, createInMemoryCacheBackend())],
          imports: [],
          exports: [],
        }),
      ],
    });

    const document = projectOpenApi(app, { title: "Accounts", version: "1.0.0" });
    const operation = (document.paths as Record<string, Record<string, Record<string, unknown>>>)[
      "/accounts/summary"
    ]?.get;
    const responses = operation?.responses as Record<string, { headers: Record<string, unknown> }>;
    expect(responses["200"]?.headers["Cache-Control"]).toMatchObject({
      required: true,
      schema: { type: "string", const: "public, max-age=20" },
    });
    expect(responses["200"]?.headers["X-Ship-Cache"]).toMatchObject({
      schema: { type: "string", enum: ["hit", "miss"] },
    });
    expect(operation?.["x-ship-cache"]).toMatchObject({ scope: "public", ttlMs: 20_000 });
  });

  it("documents a private Cache-Control for a shared cache key behind protected access", () => {
    const cacheToken = cacheBackendDependency("platform.cache");
    const read = defineOperation({
      id: "accounts.summary",
      transport: http.get("/accounts/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: permission("accounts:read"),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 20_000, scope: "public", tags: ["accounts"] },
      handler: () => ({ total: 1 }),
    });
    const app = defineApp({
      id: "contract-fixture",
      modules: [
        defineModule({
          id: "accounts",
          operations: [read],
          providers: [valueProvider(cacheToken, createInMemoryCacheBackend())],
          imports: [],
          exports: [],
        }),
      ],
    });

    const document = projectOpenApi(app, { title: "Accounts", version: "1.0.0" });
    const operation = (document.paths as Record<string, Record<string, Record<string, unknown>>>)[
      "/accounts/summary"
    ]?.get;
    const responses = operation?.responses as Record<string, { headers: Record<string, unknown> }>;
    expect(responses["200"]?.headers["Cache-Control"]).toMatchObject({
      schema: { type: "string", const: "private, max-age=20" },
    });
    expect(operation?.["x-ship-cache"]).toMatchObject({
      scope: "public",
      cacheControl: "private, max-age=20",
    });
  });
});
