import {
  type AnyOperation,
  anyPermission,
  authenticatedAccess,
  cacheBackendDependency,
  createExecutor,
  defineActorResolver,
  defineApp,
  defineModule,
  defineOperation,
  type OperationAccess,
  operationActor,
  operationError,
  operationFailure,
  operationIdentity,
  optionalIdentityAccess,
  permission,
  publicAccess,
  respond,
  systemAccess,
  valueProvider,
} from "@sixthsummit/ship-core";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHonoAdapter, HonoAdapterError, serializeFailure } from "./adapter.js";
import { defineHonoCredentialAdapter, type HonoAuthenticationOptions } from "./auth.js";
import { http } from "./transport.js";

const cacheFixtureToken = cacheBackendDependency("fixtures.cache");

describe("createHonoAdapter", () => {
  it("runs an operation policy after access and before input validation", async () => {
    const limited = operationError({
      code: "FIXTURE_RATE_LIMITED",
      status: 429,
      message: "Too many requests",
      headers: ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining"] as const,
    });
    const handler = vi.fn(({ input }: { input: { query: { phone: string } } }) => ({
      phone: input.query.phone,
    }));
    const operation = defineOperation({
      id: "fixtures.lookup",
      transport: http.get("/lookup"),
      input: { query: z.object({ phone: z.string().min(1) }).strict() },
      output: { 200: z.object({ phone: z.string() }) },
      successStatus: 200,
      errors: [limited],
      access: permission("fixtures:read"),
      transaction: "none",
      dependencies: {},
      handler,
    });
    const application = fixtureApp(operation);
    const counts = new Map<string, number>();
    const policy = vi.fn(({ actor }: { actor?: { id: string } }) => {
      const id = actor?.id ?? "missing";
      const used = (counts.get(id) ?? 0) + 1;
      counts.set(id, used);
      if (used > 60) {
        return {
          allowed: false as const,
          failure: operationFailure(limited, {
            headers: { "Retry-After": "60", "RateLimit-Limit": "60", "RateLimit-Remaining": "0" },
          }),
        };
      }
      return {
        allowed: true as const,
        headers: { "RateLimit-Limit": "60", "RateLimit-Remaining": String(60 - used) },
      };
    });
    const auth: HonoAuthenticationOptions<string> = {
      credentials: defineHonoCredentialAdapter({
        id: "policy.credentials",
        extract: (request) => request.headers.get("authorization") ?? undefined,
      }),
      actors: defineActorResolver<string>({
        id: "policy.actors",
        resolve: ({ credential }) =>
          credential
            ? {
                ok: true,
                actor: operationActor({
                  id: credential,
                  permissions: credential === "denied" ? [] : ["fixtures:read"],
                }),
              }
            : { ok: false, reason: "invalid-credential" },
      }),
    };
    const options = { auth, preValidationPolicies: { "fixtures.lookup": policy } };
    const app = createHonoAdapter(application, options);
    const request = (path: string, account = "owner") =>
      app.request(path, { headers: { authorization: account } });
    expect((await request("/lookup?phone=1", "denied")).status).toBe(403);
    expect(policy).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++) {
      const response = await request("/lookup?phone=");
      expect(response.status).toBe(400);
      expect(response.headers.get("RateLimit-Remaining")).toBe(String(59 - i));
    }
    const blocked = await request("/lookup?phone=123");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(blocked.headers.get("RateLimit-Remaining")).toBe("0");
    expect(await blocked.json()).toMatchObject({
      success: false,
      error: { code: "FIXTURE_RATE_LIMITED" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect((await request("/lookup?phone=123", "other")).status).toBe(200);
    expect(
      (
        await createHonoAdapter(application, {
          auth,
          preValidationPolicies: { "fixtures.lookup": () => ({ allowed: true }) },
        }).request("/lookup?phone=123", { headers: { authorization: "owner" } })
      ).status,
    ).toBe(200);
    expect(
      (
        await createExecutor(application).run(
          "fixtures.lookup",
          { query: { phone: "direct" } },
          { actor: operationActor({ id: "owner", permissions: ["fixtures:read"] }) },
        )
      ).ok,
    ).toBe(true);
  });

  it("rejects unknown policies and safely handles undeclared policy failures", async () => {
    const operation = defineOperation({
      id: "fixtures.policy",
      transport: http.get("/policy"),
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const application = fixtureApp(operation);
    expect(() =>
      createHonoAdapter(application, {
        preValidationPolicies: { "fixtures.typo": () => ({ allowed: true }) },
      }),
    ).toThrow(HonoAdapterError);
    const undeclared = createHonoAdapter(application, {
      preValidationPolicies: {
        "fixtures.policy": () => ({
          allowed: false,
          failure: operationFailure(
            operationError({ code: "POLICY_UNDECLARED", status: 429, message: "No" }),
          ),
        }),
      },
    });
    const response = await undeclared.request("/policy");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    });
    const thrown = createHonoAdapter(application, {
      preValidationPolicies: {
        "fixtures.policy": () => {
          throw new Error("backend secret");
        },
      },
    });
    const unavailable = await thrown.request("/policy");
    expect(unavailable.status).toBe(500);
    expect(JSON.stringify(await unavailable.json())).not.toContain("backend secret");
  });

  it("passes the operation ID to centralized failure projection", async () => {
    const operation = defineOperation({
      id: "fixtures.validation",
      transport: http.get("/validation"),
      input: { query: z.object({ name: z.string().min(1) }) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const projectFailureBody = vi.fn((failure, context) => ({
      success: false,
      code: failure.error.code,
      operationId: context.operationId,
    }));
    const response = await createHonoAdapter(fixtureApp(operation), { projectFailureBody }).request(
      "/validation?name=",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      code: "VALIDATION_ERROR",
      operationId: "fixtures.validation",
    });
  });

  it("treats a kind-less actor from a ship-core 1.0 resolver as human, keeping 403s as 403s", async () => {
    // ship-auth-firebase 1.0 rebuilds the actor with a nested ship-core 1.0
    // copy, so the adapter receives a plain snapshot without `kind`.
    const legacyAuthentication: HonoAuthenticationOptions<string> = {
      credentials: fakeAuthentication().credentials,
      actors: defineActorResolver<string>({
        id: "auth.legacy",
        resolve: ({ credential }) => {
          if (!credential) return { ok: true };
          const permissions = credential
            .replace(/^Bearer /u, "")
            .split(",")
            .map((name) => `fixtures:${name}`);
          return {
            ok: true,
            actor: Object.freeze({ id: "actor-1", permissions: new Set(permissions) }),
          };
        },
      }),
    };
    const kindOperation = defineOperation({
      id: "fixtures.kind",
      transport: http.get("/kind"),
      input: {},
      output: { 200: z.object({ kind: z.string() }) },
      successStatus: 200,
      errors: [],
      access: permission("fixtures:read"),
      transaction: "none",
      dependencies: {},
      handler: ({ context }) => ({ kind: context.actor.kind }),
    });
    const systemOnly = securedOperation(systemAccess());
    const application = defineApp({
      id: "fixture-api",
      modules: [
        defineModule({
          id: "fixtures",
          operations: [kindOperation, systemOnly],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const onUnexpectedError = vi.fn();
    const adapter = createHonoAdapter(application, {
      auth: legacyAuthentication,
      onUnexpectedError,
    });

    const allowed = await adapter.request("/kind", { headers: { authorization: "Bearer read" } });
    const insufficient = await adapter.request("/kind", {
      headers: { authorization: "Bearer write" },
    });
    const notSystem = await adapter.request("/secured", {
      headers: { authorization: "Bearer read" },
    });

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ kind: "human" });
    expect(insufficient.status).toBe(403);
    expect(await insufficient.json()).toMatchObject({
      error: {
        code: "AUTHORIZATION_ERROR",
        details: { requiredPermissions: ["fixtures:read"] },
      },
    });
    expect(notSystem.status).toBe(403);
    expect(await notSystem.json()).toMatchObject({
      error: { code: "AUTHORIZATION_ERROR", details: { requiredActorKind: "system" } },
    });
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("still fails closed when a resolver returns an actor that cannot be normalised", async () => {
    const onUnexpectedError = vi.fn();
    const adapter = createHonoAdapter(fixtureApp(securedOperation(authenticatedAccess())), {
      auth: {
        credentials: fakeAuthentication().credentials,
        actors: defineActorResolver<string>({
          id: "auth.broken",
          // A kind-less actor may not claim a provider.
          resolve: () => ({ ok: true, actor: { id: "hook-1", provider: "stripe" } }) as never,
        }),
      },
      onUnexpectedError,
    });

    const response = await adapter.request("/secured", {
      headers: { authorization: "Bearer read" },
    });

    expect(response.status).toBe(500);
    expect(onUnexpectedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("returned an invalid result") }),
      expect.anything(),
    );
  });

  it.each([
    ["Bearer invalid", 401, "AUTHENTICATION_ERROR"],
    ["Bearer denied", 403, "AUTHORIZATION_ERROR"],
    [undefined, 401, "AUTHENTICATION_ERROR"],
  ])("passes operation identity through early auth failure %s", async (authorization, status, code) => {
    const operation = securedOperation(permission("fixtures:read"));
    const response = await createHonoAdapter(fixtureApp(operation), {
      auth: fakeAuthentication(),
      projectFailureBody: (failure, context) => ({
        code: failure.error.code,
        operationId: context.operationId,
      }),
    }).request("/secured", {
      ...(authorization ? { headers: { authorization } } : {}),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, operationId: "fixtures.secured" });
  });

  it("keeps repeated keys as arrays and bracket names literal when declared", async () => {
    const query = z.object({
      phone: z.union([z.string(), z.array(z.string())]),
      "phone[]": z.string(),
    });
    const operation = defineOperation({
      id: "fixtures.literal-query",
      transport: http.get("/literal-query", { queryParsing: "literal-keys" }),
      input: { query },
      output: { 200: query },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => input.query,
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request(
      "/literal-query?phone=a&phone=b&phone%5B%5D=c",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ phone: ["a", "b"], "phone[]": "c" });
  });

  it("differentially maps params, query arrays, headers, body, and transformed output", async () => {
    const operation = defineOperation({
      id: "fixtures.create",
      transport: http.post("/fixtures/:fixtureId"),
      input: {
        params: z.object({ fixtureId: z.coerce.number().int().positive() }),
        query: z.object({ tags: z.array(z.string()) }),
        headers: z.object({ "x-client-id": z.string().min(1) }),
        body: z.object({ name: z.string().trim().min(1) }),
      },
      output: {
        201: z.object({
          id: z.number(),
          tags: z.array(z.string()),
          clientId: z.string(),
          name: z.string(),
        }),
      },
      successStatus: 201,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({
        id: input.params.fixtureId,
        tags: input.query.tags,
        clientId: input.headers["x-client-id"],
        name: input.body.name,
      }),
    });
    const application = fixtureApp(operation);
    const rawInput = {
      params: { fixtureId: "7" },
      query: { tags: ["one", "two"] },
      headers: { "x-client-id": "client-1" },
      body: { name: "  Example  " },
    };
    const direct = await createExecutor(application).run("fixtures.create", rawInput, {
      requestId: "request-1",
    });

    const response = await createHonoAdapter(application).request("/fixtures/7?tags=one&tags=two", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-id": "client-1",
        "x-request-id": "request-1",
      },
      body: JSON.stringify({ name: "  Example  " }),
    });

    expect(direct).toMatchObject({ ok: true, status: 201 });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(await response.json()).toEqual(direct.ok ? direct.data : undefined);
  });

  it("preserves singleton, empty, and empty-string arrays with bracket query encoding", async () => {
    const operation = defineOperation({
      id: "fixtures.query-arrays",
      transport: http.get("/query-arrays"),
      input: { query: z.object({ tags: z.array(z.string()) }) },
      output: { 200: z.object({ tags: z.array(z.string()) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ tags: input.query.tags }),
    });
    const app = createHonoAdapter(fixtureApp(operation));

    for (const [query, expected] of [
      ["tags%5B%5D=one", ["one"]],
      ["tags%5B%5D", []],
      ["tags%5B%5D=", [""]],
    ] as const) {
      const response = await app.request(`/query-arrays?${query}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tags: expected });
    }
  });

  it("rejects ambiguous bracket and scalar query representations", async () => {
    const operation = defineOperation({
      id: "fixtures.query-arrays",
      transport: http.get("/query-arrays"),
      input: { query: z.object({ tags: z.array(z.string()) }) },
      output: { 200: z.object({ tags: z.array(z.string()) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ tags: input.query.tags }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request(
      "/query-arrays?tags=one&tags%5B%5D=two",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        details: { issues: [{ path: ["query", "tags"], code: "invalid_query_encoding" }] },
      },
    });
  });

  it("uses first scalar query values for an opted-in callback without treating bracket keys as scalar values", async () => {
    const operation = defineOperation({
      id: "fixtures.callback-query",
      transport: http.get("/callback-query", { queryParsing: "first-value" }),
      input: { query: z.object({ code: z.string().optional(), state: z.string().optional() }) },
      output: { 200: z.object({ code: z.string().nullable(), state: z.string().nullable() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({
        code: input.query.code ?? null,
        state: input.query.state ?? null,
      }),
    });
    const app = createHonoAdapter(fixtureApp(operation));
    const mixed = await app.request(
      "/callback-query?code=first&code=second&code%5B%5D=other&state=s1&state%5B%5D=s2",
    );
    expect(mixed.status).toBe(200);
    expect(await mixed.json()).toEqual({ code: "first", state: "s1" });
    const bracketOnly = await app.request("/callback-query?code%5B%5D=other");
    expect(bracketOnly.status).toBe(200);
    expect(await bracketOnly.json()).toEqual({ code: null, state: null });
  });

  it("serializes executor validation failures without changing their details", async () => {
    const operation = readOperation();
    const application = fixtureApp(operation);
    const direct = await createExecutor(application).run(
      "fixtures.read",
      { params: { fixtureId: "invalid" } },
      { requestId: "request-2" },
    );

    const response = await createHonoAdapter(application).request("/fixtures/invalid", {
      headers: { "x-request-id": "request-2" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: direct.ok ? undefined : direct.error,
    });
  });

  it("serializes declared operation failures as the stable error envelope", async () => {
    const missing = operationError({
      code: "FIXTURE_NOT_FOUND",
      status: 404,
      message: "Fixture not found",
      details: z.object({ fixtureId: z.number() }),
    });
    const operation = defineOperation({
      ...readOperation(),
      errors: [missing],
      handler: ({ input }) => {
        throw operationFailure(missing, { details: { fixtureId: input.params.fixtureId } });
      },
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures/8", {
      headers: { "x-request-id": "request-3" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "FIXTURE_NOT_FOUND",
        message: "Fixture not found",
        details: { fixtureId: 8 },
      },
    });
  });

  it("keeps a declared 429 Retry-After header across direct and HTTP execution", async () => {
    const limited = operationError({
      code: "BUG_REPORT_RATE_LIMITED",
      status: 429,
      message: "Too many bug reports",
      headers: ["Retry-After"] as const,
    });
    const operation = defineOperation({
      id: "fixtures.report-bug",
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
    const application = fixtureApp(operation);
    const direct = await createExecutor(application).run(
      "fixtures.report-bug",
      {},
      { requestId: "rate-1" },
    );
    const response = await createHonoAdapter(application).request("/bug-reports", {
      method: "POST",
      headers: { "x-request-id": "rate-1" },
    });

    expect(direct).toMatchObject({
      ok: false,
      status: 429,
      headers: { "retry-after": "120" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(response.headers.get("x-request-id")).toBe("rate-1");
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "BUG_REPORT_RATE_LIMITED", message: "Too many bug reports" },
    });
    if (direct.ok) throw new Error("expected a failure");
    expect(() =>
      serializeFailure(
        { ...direct, headers: { "Content-Type": "text/html" } },
        undefined,
        operation,
      ),
    ).toThrow("must match the error declaration");
    expect(() => serializeFailure({ ...direct, status: 503 }, undefined, operation)).toThrow(
      "matching declared operation error",
    );
  });

  it.each([
    204, 205,
  ] as const)("returns no entity body for a declared %s success", async (status) => {
    const operation = defineOperation({
      id: "fixtures.clear",
      transport: http.delete("/fixtures"),
      input: {},
      output: { [status]: z.undefined() },
      successStatus: status,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => undefined,
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures", {
      method: "DELETE",
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await response.text()).toBe("");
  });

  it("projects explicit text responses and safe operation headers", async () => {
    const operation = defineOperation({
      id: "fixtures.export",
      transport: http.get("/fixtures.csv", {
        response: "text",
        contentType: "text/csv; charset=UTF-8",
      }),
      input: {},
      output: { 200: z.string() },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () =>
        respond(200, "id,name\n1,Example", {
          headers: {
            "Content-Disposition": 'attachment; filename="fixtures.csv"',
            ETag: '"fixture-export"',
          },
        }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures.csv", {
      headers: { "x-request-id": "text-response-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=UTF-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="fixtures.csv"');
    expect(response.headers.get("etag")).toBe('"fixture-export"');
    expect(response.headers.get("x-request-id")).toBe("text-response-1");
    expect(await response.text()).toBe("id,name\n1,Example");
  });

  it("keeps the declared text representation ahead of respond() headers and rejects content-type overrides", async () => {
    const operation = defineOperation({
      id: "fixtures.document",
      transport: http.get("/fixtures.xml", { response: "text", contentType: "text/xml" }),
      input: { query: z.object({ override: z.string().optional() }) },
      output: { 200: z.string() },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) =>
        respond(200, "<doc/>", {
          headers:
            input.query.override === "yes"
              ? { "content-type": "text/plain", "x-doc": "1" }
              : { "x-doc": "1" },
        }),
    });
    const app = createHonoAdapter(fixtureApp(operation));

    const declared = await app.request("/fixtures.xml");
    expect(declared.status).toBe(200);
    expect(declared.headers.get("content-type")).toBe("text/xml");
    expect(declared.headers.get("x-doc")).toBe("1");
    await expect(declared.text()).resolves.toBe("<doc/>");

    // content-type stays adapter-owned: a handler override is a defect, not a representation change.
    const overridden = await app.request("/fixtures.xml?override=yes");
    expect(overridden.status).toBe(500);
    expect(overridden.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    await expect(overridden.json()).resolves.toMatchObject({
      error: { code: "INTERNAL_SERVER_ERROR" },
    });
  });

  it("returns byte-exact binary downloads", async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const operation = defineOperation({
      id: "fixtures.download",
      transport: http.get("/fixtures.pdf", {
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
      handler: () =>
        respond(200, bytes, {
          headers: { "content-disposition": 'attachment; filename="fixtures.pdf"' },
        }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures.pdf");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="fixtures.pdf"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("requires a declared content type selection for multi-format binary downloads", async () => {
    const bytes = new Uint8Array([0, 127, 255]);
    const operation = defineOperation({
      id: "fixtures.export",
      transport: http.get("/export", {
        response: "binary",
        contentTypes: [
          "text/csv; charset=utf-8",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
      }),
      input: { query: z.object({ format: z.enum(["csv", "xlsx", "missing", "invalid"]) }) },
      output: { 200: z.instanceof(Uint8Array) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) =>
        respond(200, bytes, {
          headers:
            input.query.format === "missing"
              ? {}
              : {
                  "Content-Type":
                    input.query.format === "csv"
                      ? "text/csv; charset=utf-8"
                      : input.query.format === "xlsx"
                        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        : "application/pdf",
                },
        }),
    });
    const app = createHonoAdapter(fixtureApp(operation));
    for (const [format, contentType] of [
      ["csv", "text/csv; charset=utf-8"],
      ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]) {
      const response = await app.request(`/export?format=${format}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    for (const format of ["missing", "invalid"]) {
      const response = await app.request(`/export?format=${format}`);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INTERNAL_SERVER_ERROR" },
      });
    }
  });

  it.each([
    ["text", http.get("/fail", { response: "text" }), () => ({ not: "text" })],
    ["binary", http.get("/fail", { response: "binary" }), () => "not binary"],
  ] as const)("safely rejects invalid %s representation values", async (_name, transport, handler) => {
    const operation = defineOperation({
      id: "fixtures.fail",
      transport,
      input: {},
      output: { 200: z.any() },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler,
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fail");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    });
  });

  it("prevents operations from overriding framework-owned headers", async () => {
    const operation = defineOperation({
      ...readOperation(),
      handler: ({ input }) =>
        respond(
          200,
          { fixtureId: input.params.fixtureId },
          { headers: { "X-Request-Id": "fake" } },
        ),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures/1", {
      headers: { "x-request-id": "real-request-id" },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("real-request-id");
    expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_SERVER_ERROR" } });
  });

  it("keeps the executor access boundary authoritative for HTTP calls", async () => {
    const operation = defineOperation({
      ...readOperation(),
      access: authenticatedAccess(),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures/1");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "AUTHENTICATION_ERROR" },
    });
  });

  it("rejects protected requests before reading or validating their body", async () => {
    const handler = vi.fn(() => ({ ok: true as const }));
    const operation = defineOperation({
      id: "fixtures.create",
      transport: http.post("/fixtures"),
      input: { body: z.object({ name: z.string() }) },
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [],
      access: authenticatedAccess(),
      transaction: "none",
      dependencies: {},
      handler,
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures", {
      method: "POST",
      body: "{malformed-json",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTHENTICATION_ERROR" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an anonymous multipart request before checking its framing", async () => {
    const handler = vi.fn(() => ({ ok: true as const }));
    const operation = defineOperation({
      id: "fixtures.upload",
      transport: http.post("/upload", {
        requestBody: http.body.multipart({ maxBytes: 128, maxFileBytes: 64 }),
      }),
      input: { body: z.instanceof(FormData) },
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [],
      access: authenticatedAccess(),
      transaction: "none",
      dependencies: {},
      handler,
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "not multipart",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTHENTICATION_ERROR" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses an operation JSON limit instead of the larger adapter default", async () => {
    const operation = defineOperation({
      id: "fixtures.create",
      transport: http.post("/fixtures", { requestBody: http.body.json({ maxBytes: 8 }) }),
      input: { body: z.object({ name: z.string() }) },
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const response = await createHonoAdapter(fixtureApp(operation), {
      maxJsonBodyBytes: 1_024,
    }).request("/fixtures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "too large" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("delivers byte-exact bounded raw bodies and enforces their media type", async () => {
    const operation = defineOperation({
      id: "fixtures.raw",
      transport: http.post("/raw", {
        requestBody: http.body.raw({ maxBytes: 5, contentTypes: ["application/json"] }),
      }),
      input: { body: z.instanceof(Uint8Array) },
      output: { 200: z.object({ bytes: z.array(z.number()) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ bytes: [...input.body] }),
    });
    const app = createHonoAdapter(fixtureApp(operation));
    const accepted = await app.request("/raw", {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: new Uint8Array([0, 1, 255]),
    });
    const rejected = await app.request("/raw", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ bytes: [0, 1, 255] });
    expect(rejected.status).toBe(415);
    expect(await rejected.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
  });

  it("stops reading a streamed body as soon as its operation limit is exceeded", async () => {
    const operation = defineOperation({
      id: "fixtures.raw",
      transport: http.post("/raw", {
        requestBody: http.body.raw({ maxBytes: 5 }),
      }),
      input: { body: z.instanceof(Uint8Array) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const request = new Request("https://example.test/raw", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await createHonoAdapter(fixtureApp(operation)).fetch(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the 5-byte limit" },
    });
  });

  it("parses multipart form data only inside explicit file and field limits", async () => {
    const operation = defineOperation({
      id: "fixtures.upload",
      transport: http.post("/upload", {
        requestBody: http.body.multipart({
          maxBytes: 1024,
          maxFiles: 1,
          maxFileBytes: 8,
          maxFields: 1,
          maxFieldBytes: 16,
        }),
      }),
      input: { body: z.instanceof(FormData) },
      output: {
        200: z.object({
          label: z.string(),
          name: z.string(),
          type: z.string(),
          bytes: z.array(z.number()),
        }),
      },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: async ({ input }) => {
        const file = input.body.get("file");
        if (!(file instanceof Blob)) throw new Error("missing file");
        return {
          label: String(input.body.get("label")),
          name: String(Reflect.get(file, "name")),
          type: file.type,
          bytes: [...new Uint8Array(await file.arrayBuffer())],
        };
      },
    });
    const body = new FormData();
    body.set("label", "avatar");
    body.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "avatar.png");
    const response = await createHonoAdapter(fixtureApp(operation)).request("/upload", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      label: "avatar",
      name: "avatar.png",
      type: "image/png",
      bytes: [1, 2, 3],
    });
  });

  it.each([
    ["file", new Blob([new Uint8Array(9)]), "large.bin"],
    ["label", "a field value longer than sixteen bytes", undefined],
  ] as const)("rejects multipart %s overflow", async (name, value, filename) => {
    const operation = defineOperation({
      id: "fixtures.upload",
      transport: http.post("/upload", {
        requestBody: http.body.multipart({
          maxBytes: 1024,
          maxFiles: 1,
          maxFileBytes: 8,
          maxFields: 1,
          maxFieldBytes: 16,
        }),
      }),
      input: { body: z.instanceof(FormData) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const body = new FormData();
    if (filename) body.set(name, value, filename);
    else body.set(name, value);
    const response = await createHonoAdapter(fixtureApp(operation)).request("/upload", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it.each(["files", "fields"] as const)("rejects multipart %s count overflow", async (kind) => {
    const operation = defineOperation({
      id: "fixtures.upload",
      transport: http.post("/upload", {
        requestBody: http.body.multipart({
          maxBytes: 1_024,
          maxFiles: 1,
          maxFileBytes: 8,
          maxFields: 1,
          maxFieldBytes: 16,
        }),
      }),
      input: { body: z.instanceof(FormData) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const body = new FormData();
    if (kind === "files") {
      body.set("first", new Blob([new Uint8Array([1])]), "first.bin");
      body.set("second", new Blob([new Uint8Array([2])]), "second.bin");
    } else {
      body.set("first", "one");
      body.set("second", "two");
    }
    const response = await createHonoAdapter(fixtureApp(operation)).request("/upload", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("rejects multipart total-size overflow before parsing parts", async () => {
    const operation = defineOperation({
      id: "fixtures.upload",
      transport: http.post("/upload", {
        requestBody: http.body.multipart({ maxBytes: 64, maxFileBytes: 32 }),
      }),
      input: { body: z.instanceof(FormData) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=bounded" },
      body: [
        "--bounded",
        'Content-Disposition: form-data; name="file"; filename="bounded.bin"',
        "Content-Type: application/octet-stream",
        "",
        "x".repeat(32),
        "--bounded--",
      ].join("\r\n"),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("rejects malformed multipart framing as a body validation error", async () => {
    const operation = defineOperation({
      id: "fixtures.upload",
      transport: http.post("/upload", {
        requestBody: http.body.multipart({ maxBytes: 128, maxFileBytes: 64 }),
      }),
      input: { body: z.instanceof(FormData) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "not multipart",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ code: "invalid_multipart" }] } },
    });
  });

  it.each([
    [authenticatedAccess(), "read", true],
    [permission("fixtures:read", "fixtures:details"), "read", false],
    [permission("fixtures:read", "fixtures:details"), "read,details", true],
    [anyPermission("fixtures:read", "fixtures:details"), "read", true],
    [anyPermission("fixtures:read", "fixtures:details"), "write", false],
  ] as const)("keeps direct and HTTP access results aligned for %#", async (access, token, expected) => {
    const operation = securedOperation(access);
    const application = fixtureApp(operation);
    const permissions = token.split(",").map((name) => `fixtures:${name}`);
    const actor = operationActor({ id: "actor-1", permissions });
    const direct = await createExecutor(application).run(
      "fixtures.secured",
      {},
      { requestId: "auth-request", actor },
    );
    const response = await createHonoAdapter(application, { auth: fakeAuthentication() }).request(
      "/secured",
      { headers: { authorization: `Bearer ${token}`, "x-request-id": "auth-request" } },
    );

    expect(direct.ok).toBe(expected);
    expect(response.status).toBe(direct.status);
    expect(await response.json()).toEqual(
      direct.ok ? direct.data : { success: false, error: direct.error },
    );
  });

  it("resolves credential-backed actors as human and rejects them from system operations", async () => {
    const kindOperation = defineOperation({
      id: "fixtures.kind",
      transport: http.get("/kind"),
      input: {},
      output: { 200: z.object({ kind: z.string() }) },
      successStatus: 200,
      errors: [],
      access: authenticatedAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ context }) => ({ kind: context.actor.kind }),
    });
    const systemOnly = securedOperation(systemAccess());
    const application = defineApp({
      id: "fixture-api",
      modules: [
        defineModule({
          id: "fixtures",
          operations: [kindOperation, systemOnly],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const adapter = createHonoAdapter(application, { auth: fakeAuthentication() });

    const kind = await adapter.request("/kind", { headers: { authorization: "Bearer read" } });
    const denied = await adapter.request("/secured", { headers: { authorization: "Bearer read" } });

    expect(await kind.json()).toEqual({ kind: "human" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: "AUTHORIZATION_ERROR", details: { requiredActorKind: "system" } },
    });
  });

  it.each([
    ["Bearer invalid", 401, "AUTHENTICATION_ERROR"],
    ["Bearer forbidden", 403, "AUTHORIZATION_ERROR"],
    ["Bearer unavailable", 503, "AUTHENTICATION_UNAVAILABLE"],
  ])("rejects %s even for a public operation", async (authorization, status, code) => {
    const operation = securedOperation(publicAccess());
    const response = await createHonoAdapter(fixtureApp(operation), {
      auth: fakeAuthentication(),
    }).request("/secured", { headers: { authorization } });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, error: { code } });
  });

  it("passes operation audit input to the actor resolver", async () => {
    const base = fakeAuthentication();
    const resolve = vi.fn(base.actors.resolve);
    const auth: HonoAuthenticationOptions<string> = {
      credentials: base.credentials,
      actors: defineActorResolver({ id: "auth.audit", resolve }),
    };
    const operation = securedOperation(permission("fixtures:read"));

    await createHonoAdapter(fixtureApp(operation), { auth }).request("/secured", {
      headers: { authorization: "Bearer read", "x-request-id": "audit-request" },
    });

    expect(resolve).toHaveBeenCalledWith({
      credential: "Bearer read",
      operation: { id: "fixtures.secured", access: operation.access },
      requestId: "audit-request",
      signal: expect.any(AbortSignal),
    });
  });

  it("passes a verified identity without inventing an application actor", async () => {
    const operation = defineOperation({
      id: "fixtures.optional-profile",
      transport: http.get("/optional-profile"),
      input: {},
      output: {
        200: z.object({ subject: z.string(), actorId: z.string().nullable() }),
      },
      successStatus: 200,
      errors: [],
      access: optionalIdentityAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ context }) => ({
        subject: context.identity?.subject ?? "anonymous",
        actorId: context.actor?.id ?? null,
      }),
    });
    const auth: HonoAuthenticationOptions<string> = {
      credentials: defineHonoCredentialAdapter({
        id: "http.identity",
        extract: () => "verified",
      }),
      actors: defineActorResolver({
        id: "auth.identity",
        resolve: () => ({
          ok: true,
          identity: operationIdentity({ provider: "firebase", subject: "uid-1" }),
        }),
      }),
    };

    const response = await createHonoAdapter(fixtureApp(operation), { auth }).request(
      "/optional-profile",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subject: "uid-1", actorId: null });
  });

  it.each(["throw", "malformed"])("safely handles a %s actor resolver", async (mode) => {
    const base = fakeAuthentication();
    const auth: HonoAuthenticationOptions<string> = {
      credentials: base.credentials,
      actors: defineActorResolver({
        id: "auth.broken",
        resolve: () => {
          if (mode === "throw") throw new Error("private provider failure");
          return { unexpected: true } as never;
        },
      }),
    };
    const response = await createHonoAdapter(fixtureApp(securedOperation(publicAccess())), {
      auth,
    }).request("/secured");

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private provider failure");
  });

  it("turns malformed JSON into one safe body validation issue", async () => {
    const operation = defineOperation({
      id: "fixtures.create",
      transport: http.post("/fixtures"),
      input: { body: z.object({ name: z.string() }) },
      output: { 201: z.object({ ok: z.literal(true) }) },
      successStatus: 201,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json", "x-request-id": "bad-json-1" },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("bad-json-1");
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: {
          issues: [
            {
              path: ["body"],
              code: "invalid_json",
              message: "Request body must contain valid UTF-8 JSON",
            },
          ],
        },
      },
    });
  });

  it("can explicitly treat malformed JSON as absent while retaining the strict default", async () => {
    const operation = defineOperation({
      id: "fixtures.legacy-json",
      transport: http.post("/legacy-json", {
        requestBody: http.body.json({ maxBytes: 8, onInvalidJson: "ignore" }),
      }),
      input: { body: z.unknown().optional() },
      output: { 200: z.object({ absent: z.boolean() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ absent: input.body === undefined }),
    });
    const app = createHonoAdapter(fixtureApp(operation));
    const malformed = await app.request("/legacy-json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({ absent: true });

    const valid = await app.request("/legacy-json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ absent: false });

    const nonJson = await app.request("/legacy-json", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{bad",
    });
    expect(nonJson.status).toBe(415);

    const oversized = await app.request("/legacy-json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{malformed-long-body",
    });
    expect(oversized.status).toBe(413);
  });

  it("rejects empty JSON after auth while still ignoring declared non-JSON bodies", async () => {
    const handler = vi.fn(({ input }: { input: { body?: unknown } }) => ({
      absent: input.body === undefined,
    }));
    const operation = defineOperation({
      id: "fixtures.empty-json",
      transport: http.put("/empty-json", {
        requestBody: http.body.json({
          onEmptyJsonBody: "reject",
          onNonJsonContentType: "ignore",
        }),
      }),
      input: { body: z.unknown().optional() },
      output: { 200: z.object({ absent: z.boolean() }) },
      successStatus: 200,
      errors: [],
      access: permission("fixtures:read"),
      transaction: "none",
      dependencies: {},
      handler,
    });
    const app = createHonoAdapter(fixtureApp(operation), { auth: fakeAuthentication() });
    const empty = {
      method: "PUT",
      headers: { authorization: "Bearer read", "content-type": "application/json" },
    };
    const unauthenticated = await app.request("/empty-json", {
      ...empty,
      headers: { ...empty.headers, authorization: "Bearer invalid" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();

    const rejected = await app.request("/empty-json", empty);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ code: "invalid_json" }] } },
    });
    expect(handler).not.toHaveBeenCalled();

    const ignored = await app.request("/empty-json", {
      method: "PUT",
      headers: { authorization: "Bearer read", "content-type": "text/plain" },
      body: "ignored",
    });
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ absent: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("accepts structured JSON media types", async () => {
    const operation = createBodyOperation();
    const response = await createHonoAdapter(fixtureApp(operation)).request("/fixtures", {
      method: "POST",
      body: JSON.stringify({ name: "Example" }),
      headers: { "content-type": "application/vnd.sixthsummit.fixture+json" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: "Example" });
  });

  it("rejects a non-empty body without a JSON media type", async () => {
    const response = await createHonoAdapter(fixtureApp(createBodyOperation())).request(
      "/fixtures",
      {
        method: "POST",
        body: JSON.stringify({ name: "Example" }),
        headers: { "content-type": "text/plain", "x-request-id": "media-type-1" },
      },
    );

    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(response.headers.get("x-request-id")).toBe("media-type-1");
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Request body must use a JSON content type",
      },
    });
  });

  it("optionally treats a non-JSON body as absent while parsing JSON normally", async () => {
    const operation = defineOperation({
      id: "fixtures.optional-json",
      transport: http.put("/fixtures", {
        requestBody: http.body.json({ onNonJsonContentType: "ignore" }),
      }),
      input: { body: z.unknown().optional() },
      output: { 200: z.object({ received: z.unknown() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ received: input.body === undefined ? "absent" : input.body }),
    });
    const app = createHonoAdapter(fixtureApp(operation));
    for (const contentType of ["text/plain", "application/octet-stream", "application/x-custom"]) {
      const response = await app.request("/fixtures", {
        method: "PUT",
        headers: { "content-type": contentType },
        body: '{"received":"should be ignored"}',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: "absent" });
    }
    const structured = await app.request("/fixtures", {
      method: "PUT",
      headers: { "content-type": "application/vnd.example+json" },
      body: '{"received":"parsed"}',
    });
    expect(structured.status).toBe(200);
    expect(await structured.json()).toEqual({ received: { received: "parsed" } });
    const malformedJson = await app.request("/fixtures", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(malformedJson.status).toBe(400);
  });

  it("rejects request bodies beyond the configured byte limit", async () => {
    const response = await createHonoAdapter(fixtureApp(createBodyOperation()), {
      maxJsonBodyBytes: 8,
    }).request("/fixtures", {
      method: "POST",
      body: JSON.stringify({ name: "too long" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the 8-byte limit" },
    });
  });

  it("rejects malformed UTF-8 as an invalid JSON body", async () => {
    const request = new Request("http://localhost/fixtures", {
      method: "POST",
      body: new Uint8Array([0xff]),
      headers: { "content-type": "application/json" },
    });
    const response = await createHonoAdapter(fixtureApp(createBodyOperation())).fetch(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ code: "invalid_json" }] } },
    });
  });

  it("lets empty bodies reach the declared body schema", async () => {
    const response = await createHonoAdapter(fixtureApp(createBodyOperation())).request(
      "/fixtures",
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ path: ["body"] }] } },
    });
  });

  it.each([
    [
      "handler",
      () => {
        throw new Error("database password is secret");
      },
    ],
    ["serialization", () => ({ unsafe: 1n })],
  ] as const)("observes but does not expose unexpected %s failures", async (_name, handler) => {
    const operation = defineOperation({
      id: "fixtures.fail",
      transport: http.get("/fail"),
      input: {},
      output: { 200: z.any() },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler,
    });
    const onUnexpectedError = vi.fn();
    const response = await createHonoAdapter(fixtureApp(operation), {
      onUnexpectedError,
    }).request("/fail", { headers: { "x-request-id": "unexpected-1" } });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    });
    expect(JSON.stringify(body)).not.toContain("database password");
    expect(onUnexpectedError).toHaveBeenCalledWith(expect.anything(), {
      operationId: "fixtures.fail",
      requestId: "unexpected-1",
      method: "GET",
      path: "/fail",
    });
    expect(Object.isFrozen(onUnexpectedError.mock.calls[0]?.[1])).toBe(true);
  });

  it("answers a client abort with a bodiless 499 and does not report it as unexpected", async () => {
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = defineOperation({
      id: "fixtures.slow",
      transport: http.get("/slow"),
      input: {},
      output: { 200: z.object({ ok: z.boolean() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: async ({ context }) => {
        release();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ok: true };
      },
    });
    const onUnexpectedError = vi.fn();
    const controller = new AbortController();
    const pending = createHonoAdapter(fixtureApp(operation), { onUnexpectedError }).request(
      "/slow",
      { headers: { "x-request-id": "aborted-1" }, signal: controller.signal },
    );
    await started;
    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-request-id")).toBe("aborted-1");
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("keeps the safe response when the unexpected-error observer fails", async () => {
    const operation = defineOperation({
      ...readOperation(),
      handler: () => {
        throw new Error("private handler failure");
      },
    });
    const response = await createHonoAdapter(fixtureApp(operation), {
      onUnexpectedError: () => {
        throw new Error("private observer failure");
      },
    }).request("/fixtures/1");

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });

  it("projects every failure path while retaining status, request id, and safe messages", async () => {
    const projectFailureBody = vi.fn((failure: { error: { code: string; message: string } }) => ({
      success: false,
      error: failure.error.message,
      code: failure.error.code,
    }));
    const declared = operationError({ code: "FIXTURE_CONFLICT", status: 409, message: "Conflict" });
    const conflict = defineOperation({
      id: "fixtures.conflict",
      transport: http.get("/conflict"),
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [declared],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => {
        throw operationFailure(declared);
      },
    });
    const unexpected = defineOperation({
      ...readOperation(),
      handler: () => {
        throw new Error("private database password");
      },
    });
    const cases = [
      {
        app: fixtureApp(securedOperation(publicAccess())),
        path: "/secured",
        init: { headers: { authorization: "Bearer invalid", "x-request-id": "projection-1" } },
        status: 401,
        code: "AUTHENTICATION_ERROR",
      },
      {
        app: fixtureApp(securedOperation(permission("fixtures:read"))),
        path: "/secured",
        init: { headers: { authorization: "Bearer write", "x-request-id": "projection-1" } },
        status: 403,
        code: "AUTHORIZATION_ERROR",
      },
      {
        app: fixtureApp(createBodyOperation()),
        path: "/fixtures",
        init: {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "projection-1" },
          body: "{bad",
        },
        status: 400,
        code: "VALIDATION_ERROR",
      },
      {
        app: fixtureApp(conflict),
        path: "/conflict",
        init: { headers: { "x-request-id": "projection-1" } },
        status: 409,
        code: "FIXTURE_CONFLICT",
      },
      {
        app: fixtureApp(unexpected),
        path: "/fixtures/1",
        init: { headers: { "x-request-id": "projection-1" } },
        status: 500,
        code: "INTERNAL_SERVER_ERROR",
      },
      {
        app: fixtureApp(readOperation()),
        path: "/missing",
        init: { headers: { "x-request-id": "projection-1" } },
        status: 404,
        code: "NOT_FOUND",
      },
    ] as const;

    for (const fixture of cases) {
      const response = await createHonoAdapter(fixture.app, {
        auth: fakeAuthentication(),
        projectFailureBody,
      }).request(fixture.path, fixture.init);
      expect(response.status).toBe(fixture.status);
      expect(response.headers.get("x-request-id")).toBe("projection-1");
      expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
      expect(await response.json()).toEqual({
        success: false,
        error: expect.any(String),
        code: fixture.code,
      });
    }
    expect(JSON.stringify(projectFailureBody.mock.calls)).not.toContain(
      "private database password",
    );
    expect(projectFailureBody).toHaveBeenCalledTimes(cases.length);
  });

  it("falls back to the default safe envelope when a failure projection throws", async () => {
    const response = await createHonoAdapter(fixtureApp(readOperation()), {
      projectFailureBody: () => {
        throw new Error("broken consumer projection");
      },
    }).request("/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  it("allows a consumer to retain its JSON failure media type without changing the body or status", async () => {
    const projected = await createHonoAdapter(fixtureApp(readOperation()), {
      failureContentType: "application/json",
      projectFailureBody: ({ error }) => ({
        success: false,
        error: error.message,
        code: error.code,
      }),
    }).request("/missing");
    expect(projected.status).toBe(404);
    expect(projected.headers.get("content-type")).toBe("application/json");
    expect(await projected.json()).toEqual({
      success: false,
      error: "Route not found",
      code: "NOT_FOUND",
    });

    const fallback = await createHonoAdapter(fixtureApp(readOperation()), {
      failureContentType: "application/json",
      projectFailureBody: () => {
        throw new Error("broken projection");
      },
    }).request("/missing");
    expect(fallback.status).toBe(404);
    expect(fallback.headers.get("content-type")).toBe("application/json");
    expect(await fallback.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  it("can emit a byte-equal compatibility error body without changing the default envelope", async () => {
    const conflict = operationError({ code: "FIXTURE_CONFLICT", status: 409, message: "Conflict" });
    const operation = defineOperation({
      id: "fixtures.conflict",
      transport: http.get("/conflict"),
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [conflict],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => {
        throw operationFailure(conflict);
      },
    });
    const compatibility = new Hono();
    compatibility.get("/conflict", (context) =>
      context.json({ success: false, error: "Conflict", code: "FIXTURE_CONFLICT" }, 409),
    );
    const projected = await createHonoAdapter(fixtureApp(operation), {
      projectFailureBody: ({ error }) => ({
        success: false,
        error: error.message,
        code: error.code,
      }),
    }).request("/conflict");
    const defaultResponse = await createHonoAdapter(fixtureApp(operation)).request("/conflict");

    expect(projected.status).toBe(409);
    expect(await projected.text()).toBe(await (await compatibility.request("/conflict")).text());
    expect(await defaultResponse.json()).toEqual({
      success: false,
      error: { code: "FIXTURE_CONFLICT", message: "Conflict" },
    });
  });

  it("ignores non-HTTP operations and returns a uniform 404", async () => {
    const operation = defineOperation({
      ...readOperation(),
      transport: undefined,
    });
    const response = await createHonoAdapter(fixtureApp(operation), {
      generateRequestId: () => "generated-1",
    }).request("/fixtures/1", {
      headers: { "x-request-id": "unsafe request id" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("generated-1");
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  it.each([
    [
      "invalid transport metadata",
      { kind: "http", binding: "GET /fixtures", metadata: { method: "TRACE", path: "/fixtures" } },
      {},
      "SHIP_HONO_TRANSPORT_INVALID",
    ],
    [
      "unsupported input location",
      http.get("/fixtures"),
      { cookies: z.object({ session: z.string() }) },
      "SHIP_HONO_INPUT_LOCATION_UNSUPPORTED",
    ],
    [
      "path parameter without params input",
      http.get("/fixtures/:fixtureId"),
      {},
      "SHIP_HONO_PATH_PARAMS_MISMATCH",
    ],
    [
      "params input without path parameter",
      http.get("/fixtures"),
      { params: z.object({ fixtureId: z.string() }) },
      "SHIP_HONO_PATH_PARAMS_MISMATCH",
    ],
    [
      "GET body declaration",
      http.get("/fixtures"),
      { body: z.object({ value: z.string() }) },
      "SHIP_HONO_REQUEST_BODY_MISMATCH",
    ],
    [
      "body policy without body input",
      http.post("/fixtures", { requestBody: http.body.raw({ maxBytes: 10 }) }),
      {},
      "SHIP_HONO_REQUEST_BODY_MISMATCH",
    ],
    [
      "empty JSON policy without body input",
      http.post("/fixtures", { requestBody: http.body.json({ onEmptyJsonBody: "reject" }) }),
      {},
      "SHIP_HONO_REQUEST_BODY_MISMATCH",
    ],
  ] as const)("rejects %s at adapter construction", (_name, transport, input, code) => {
    const operation = defineOperation({
      id: "fixtures.read",
      transport,
      input,
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });

    expect(() => createHonoAdapter(fixtureApp(operation))).toThrow(
      expect.objectContaining({ code, operationId: "fixtures.read" }),
    );
    expect(() => createHonoAdapter(fixtureApp(operation))).toThrow(HonoAdapterError);
  });

  it("rejects malformed auth composition at adapter construction", () => {
    const create = createHonoAdapter as (
      application: ReturnType<typeof fixtureApp>,
      options: unknown,
    ) => unknown;

    expect(() => create(fixtureApp(readOperation()), { auth: null })).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_AUTH_INVALID" }),
    );
    expect(() => create(fixtureApp(readOperation()), { maxJsonBodyBytes: 0 })).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_OPTIONS_INVALID" }),
    );
    expect(() => create(fixtureApp(readOperation()), { onUnexpectedError: "log it" })).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_OPTIONS_INVALID" }),
    );
    expect(() => create(fixtureApp(readOperation()), { projectFailureBody: "legacy" })).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_OPTIONS_INVALID" }),
    );
    expect(() => create(fixtureApp(readOperation()), { failureContentType: "text/html" })).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_OPTIONS_INVALID" }),
    );
  });
});

function createBodyOperation() {
  return defineOperation({
    id: "fixtures.create",
    transport: http.post("/fixtures"),
    input: { body: z.object({ name: z.string().min(1) }) },
    output: { 201: z.object({ name: z.string() }) },
    successStatus: 201,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: ({ input }) => input.body,
  });
}

function readOperation() {
  return defineOperation({
    id: "fixtures.read",
    transport: http.get("/fixtures/:fixtureId"),
    input: { params: z.object({ fixtureId: z.coerce.number().int().positive() }) },
    output: { 200: z.object({ fixtureId: z.number() }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: ({ input }) => ({ fixtureId: input.params.fixtureId }),
  });
}

describe("declared read cache over HTTP", () => {
  const cachedOperation = (handler: () => { total: number }) =>
    defineOperation({
      id: "fixtures.summary",
      transport: http.get("/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { cache: cacheFixtureToken },
      cache: { ttlMs: 45_000, scope: "public", tags: ["summary"] },
      handler,
    });

  it("reports the miss, then the hit, with the declared Cache-Control", async () => {
    const handler = vi.fn(() => ({ total: 3 }));
    const backend = createInMemoryCacheBackend();
    const app = createHonoAdapter(cacheFixtureApp(cachedOperation(handler), backend));

    const miss = await app.request("/summary");
    const hit = await app.request("/summary");

    expect(miss.status).toBe(200);
    expect(miss.headers.get("x-ship-cache")).toBe("miss");
    expect(miss.headers.get("cache-control")).toBe("public, max-age=45");
    expect(hit.headers.get("x-ship-cache")).toBe("hit");
    expect(await hit.json()).toEqual({ total: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("projects a private Cache-Control for an actor-scoped read", async () => {
    const operation = defineOperation({
      id: "fixtures.summary",
      transport: http.get("/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: authenticatedAccess(),
      transaction: "none",
      dependencies: { cache: cacheFixtureToken },
      cache: { ttlMs: 10_000, scope: "actor" },
      handler: () => ({ total: 1 }),
    });
    const app = createHonoAdapter(cacheFixtureApp(operation, createInMemoryCacheBackend()), {
      auth: fakeAuthentication(),
    });
    const response = await app.request("/summary", { headers: { authorization: "Bearer read" } });
    expect(response.headers.get("cache-control")).toBe("private, max-age=10");
    expect(response.headers.get("x-ship-cache")).toBe("miss");
  });

  it("keeps a shared cache key private when the read requires a permission", async () => {
    // scope public describes the key: every caller allowed in shares one entry.
    // It must not become `Cache-Control: public`, which would let a shared
    // cache between the client and the app store a permission-gated body.
    const operation = defineOperation({
      id: "fixtures.summary",
      transport: http.get("/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: permission("fixtures:read"),
      transaction: "none",
      dependencies: { cache: cacheFixtureToken },
      cache: { ttlMs: 30_000, scope: "public", tags: ["summary"] },
      handler: () => ({ total: 1 }),
    });
    const compiled = cacheFixtureApp(operation, createInMemoryCacheBackend());
    expect(compiled.diagnostics).toEqual([
      expect.objectContaining({ code: "SHIP_CACHE_PUBLIC_SCOPE_PROTECTED", severity: "warning" }),
    ]);
    const app = createHonoAdapter(compiled, { auth: fakeAuthentication() });
    const miss = await app.request("/summary", { headers: { authorization: "Bearer read" } });
    const hit = await app.request("/summary", { headers: { authorization: "Bearer read" } });
    expect(miss.status).toBe(200);
    expect(miss.headers.get("cache-control")).toBe("private, max-age=30");
    expect(miss.headers.get("x-ship-cache")).toBe("miss");
    expect(hit.headers.get("cache-control")).toBe("private, max-age=30");
    expect(hit.headers.get("x-ship-cache")).toBe("hit");
  });

  it("omits cache headers for an operation that declares no cache", async () => {
    const response = await createHonoAdapter(fixtureApp(securedOperation(publicAccess()))).request(
      "/secured",
    );
    expect(response.headers.get("x-ship-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("refuses an operation that tries to forge the cache header", async () => {
    const operation = defineOperation({
      id: "fixtures.summary",
      transport: http.get("/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { cache: cacheFixtureToken },
      cache: { ttlMs: 10_000, scope: "public" },
      handler: () => respond(200, { total: 1 }, { headers: { "x-ship-cache": "hit" } }),
    });
    const response = await createHonoAdapter(
      cacheFixtureApp(operation, createInMemoryCacheBackend()),
    ).request("/summary");
    expect(response.status).toBe(500);
  });
});

function cacheFixtureApp<const TOperation extends AnyOperation>(
  operation: TOperation,
  backend: ReturnType<typeof createInMemoryCacheBackend>,
) {
  const module = defineModule({
    id: "fixtures",
    operations: [operation],
    providers: [valueProvider(cacheFixtureToken, backend)],
    imports: [],
    exports: [],
  });
  return defineApp({ id: "fixture-api", modules: [module] });
}

function fixtureApp<const TOperation extends AnyOperation>(operation: TOperation) {
  const module = defineModule({
    id: "fixtures",
    operations: [operation],
    providers: [],
    imports: [],
    exports: [],
  });
  return defineApp({ id: "fixture-api", modules: [module] });
}

function securedOperation<TAccess extends OperationAccess>(access: TAccess) {
  return defineOperation({
    id: "fixtures.secured",
    transport: http.get("/secured"),
    input: {},
    output: { 200: z.object({ actorId: z.string() }) },
    successStatus: 200,
    errors: [],
    access,
    transaction: "none",
    dependencies: {},
    handler: ({ context }) => ({ actorId: context.actor?.id ?? "anonymous" }),
  });
}

function fakeAuthentication(): HonoAuthenticationOptions<string> {
  return {
    credentials: defineHonoCredentialAdapter({
      id: "http.bearer",
      extract: (request) => request.headers.get("authorization") ?? undefined,
    }),
    actors: defineActorResolver<string>({
      id: "auth.fixture",
      resolve: ({ credential }) => {
        if (!credential) return { ok: true };
        if (credential === "Bearer invalid") {
          return { ok: false, reason: "invalid-credential" };
        }
        if (credential === "Bearer forbidden") return { ok: false, reason: "forbidden" };
        if (credential === "Bearer unavailable") return { ok: false, reason: "unavailable" };
        const permissions = credential
          .replace(/^Bearer /u, "")
          .split(",")
          .map((name) => `fixtures:${name}`);
        return { ok: true, actor: operationActor({ id: "actor-1", permissions }) };
      },
    }),
  };
}

describe("declared HTTP redirects", () => {
  const location = "https://app.example.test/oauth?connected=true";
  const invalidState = operationError({
    code: "OAUTH_STATE_INVALID",
    status: 400,
    message: "OAuth state is invalid",
  });

  function callbackOperation(
    handler: (arguments_: {
      readonly input: { readonly query: { readonly code: string; readonly state: string } };
    }) => unknown,
    options: {
      readonly status?: 301 | 302 | 303 | 307 | 308;
      readonly access?: OperationAccess;
      readonly method?: "get" | "post";
    } = {},
  ) {
    const status = options.status ?? 302;
    const transport =
      options.method === "post"
        ? http.post("/oauth/callback", { response: "redirect" })
        : http.get("/oauth/callback", { response: "redirect", queryParsing: "first-value" });
    return defineOperation({
      id: "fixtures.oauth-callback",
      transport,
      input: { query: z.object({ code: z.string().min(1), state: z.string().min(1) }) },
      output: { [status]: z.undefined() } as Record<302, z.ZodUndefined>,
      successStatus: status as 302,
      errors: [invalidState],
      access: options.access ?? publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: handler as never,
    });
  }

  const query = "?code=code-1&state=state-1";

  it.each([
    301, 302, 303, 307, 308,
  ] as const)("serializes an empty %s with Location and the request id and no content type", async (status) => {
    const operation = callbackOperation(
      () => respond(status, undefined, { headers: { Location: location } }),
      { status },
    );
    const response = await createHonoAdapter(fixtureApp(operation)).request(
      `/oauth/callback${query}`,
      { headers: { "x-request-id": `redirect-${status}` } },
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("x-request-id")).toBe(`redirect-${status}`);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("x-ship-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("redirects after a POST with a declared 303", async () => {
    const operation = callbackOperation(
      () => respond(303, undefined, { headers: { Location: "/oauth/done" } }),
      { status: 303, method: "post" },
    );
    const response = await createHonoAdapter(fixtureApp(operation)).request(
      `/oauth/callback${query}`,
      { method: "POST" },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/oauth/done");
    expect(await response.text()).toBe("");
  });

  it("keeps safe operation headers on a redirect and rejects reserved ones", async () => {
    const withHeaders = callbackOperation(() =>
      respond(302, undefined, {
        headers: { Location: location, "Cache-Control": "no-store", "X-OAuth-Provider": "google" },
      }),
    );
    const response = await createHonoAdapter(fixtureApp(withHeaders)).request(
      `/oauth/callback${query}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-oauth-provider")).toBe("google");

    const reserved = callbackOperation(() =>
      respond(302, undefined, {
        headers: { Location: location, "Content-Type": "text/html" },
      }),
    );
    const rejected = await createHonoAdapter(fixtureApp(reserved)).request(
      `/oauth/callback${query}`,
    );
    expect(rejected.status).toBe(500);
    expect(rejected.headers.get("location")).toBeNull();
  });

  it("reads a mixed scalar and bracket callback query by its first scalar value", async () => {
    const operation = callbackOperation(({ input: { query: parsed } }) =>
      respond(302, undefined, {
        headers: {
          Location: `https://app.example.test/oauth?code=${parsed.code}&state=${parsed.state}`,
        },
      }),
    );
    const response = await createHonoAdapter(fixtureApp(operation)).request(
      "/oauth/callback?code=first&code=second&code%5B%5D=third&state%5Bextra%5D=x&state=s1&scope=email",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/oauth?code=first&state=s1",
    );
  });

  it("lets the handler answer a failure redirect while every other failure stays JSON", async () => {
    const operation = callbackOperation(({ input: { query: parsed } }) => {
      if (parsed.state === "revoked") throw operationFailure(invalidState);
      if (parsed.state !== "state-1") {
        return respond(302, undefined, {
          headers: { Location: "https://app.example.test/oauth?error=invalid_state" },
        });
      }
      return respond(302, undefined, { headers: { Location: location } });
    });
    const app = createHonoAdapter(fixtureApp(operation));

    const failureRedirect = await app.request("/oauth/callback?code=code-1&state=tampered");
    expect(failureRedirect.status).toBe(302);
    expect(failureRedirect.headers.get("location")).toBe(
      "https://app.example.test/oauth?error=invalid_state",
    );
    expect(await failureRedirect.text()).toBe("");

    const declared = await app.request("/oauth/callback?code=code-1&state=revoked", {
      headers: { "x-request-id": "declared-1" },
    });
    expect(declared.status).toBe(400);
    expect(declared.headers.get("location")).toBeNull();
    expect(declared.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(declared.headers.get("x-request-id")).toBe("declared-1");
    expect(await declared.json()).toMatchObject({
      success: false,
      error: { code: "OAUTH_STATE_INVALID", message: "OAuth state is invalid" },
    });

    const validation = await app.request("/oauth/callback?state=state-1");
    expect(validation.status).toBe(400);
    expect(validation.headers.get("location")).toBeNull();
    expect(await validation.json()).toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        details: { issues: [{ path: ["query", "code"] }] },
      },
    });

    const missing = await app.request("/oauth/callback?code=code-1&state=state-1", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("location")).toBeNull();
  });

  it("answers an unauthenticated protected redirect with the JSON 401 envelope", async () => {
    const operation = callbackOperation(
      () => respond(302, undefined, { headers: { Location: location } }),
      { access: authenticatedAccess() },
    );
    const app = createHonoAdapter(fixtureApp(operation), { auth: fakeAuthentication() });

    const anonymous = await app.request(`/oauth/callback${query}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("location")).toBeNull();
    expect(await anonymous.json()).toMatchObject({
      success: false,
      error: { code: "AUTHENTICATION_ERROR" },
    });

    const authenticated = await app.request(`/oauth/callback${query}`, {
      headers: { authorization: "Bearer read" },
    });
    expect(authenticated.status).toBe(302);
    expect(authenticated.headers.get("location")).toBe(location);
  });

  it.each([
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash protocol-relative URL", "/\\evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["embedded credentials", "https://user:pass@app.example.test/"],
    ["a control character", "https://app.example.test/\u0000"],
  ])("answers a safe 500 without Location for %s", async (_name, unsafe) => {
    const observer = vi.fn();
    const operation = callbackOperation(() =>
      respond(302, undefined, { headers: { Location: unsafe } }),
    );
    const response = await createHonoAdapter(fixtureApp(operation), {
      onUnexpectedError: observer,
    }).request(`/oauth/callback${query}`, { headers: { "x-request-id": "unsafe-1" } });

    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("unsafe-1");
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "INTERNAL_SERVER_ERROR" },
    });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("answers a safe 500 when the handler returns a body or no Location", async () => {
    for (const handler of [
      () => respond(302, { ok: true } as never, { headers: { Location: location } }),
      () => respond(302, undefined),
      () => undefined,
    ]) {
      const response = await createHonoAdapter(fixtureApp(callbackOperation(handler))).request(
        `/oauth/callback${query}`,
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_SERVER_ERROR" } });
    }
  });
});
