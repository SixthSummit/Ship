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
import { projectOpenApi } from "./openapi.js";
import { projectClientContract } from "./project.js";

const location = "https://app.example.test/oauth?connected=true";
const callback = defineOperation({
  id: "oauth.callback",
  transport: http.get("/oauth/callback", { response: "redirect" }),
  input: {},
  output: { 302: z.undefined() },
  successStatus: 302,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => respond(302, undefined, { headers: { Location: location } }),
});
const app = defineApp({
  id: "redirect-fixture",
  modules: [
    defineModule({ id: "oauth", operations: [callback], providers: [], imports: [], exports: [] }),
  ],
});

describe("declared HTTP redirects", () => {
  it("projects an opted-in first-value callback query policy", () => {
    const queryCallback = defineOperation({
      ...callback,
      id: "oauth.query-callback",
      transport: http.get("/oauth/query-callback", {
        response: "redirect",
        queryParsing: "first-value",
      }),
      input: { query: z.object({ code: z.string().optional(), state: z.string().optional() }) },
    });
    const queryApp = defineApp({
      id: "query-redirect-fixture",
      modules: [
        defineModule({
          id: "oauth",
          operations: [queryCallback],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    expect(projectClientContract(queryApp).operations[0]?.transport.metadata).toMatchObject({
      response: "redirect",
      queryParsing: "first-value",
    });
    expect(
      projectOpenApi(queryApp, { title: "OAuth", version: "1" }).paths["/oauth/query-callback"]
        ?.get,
    ).toMatchObject({
      "x-ship-query-parsing": "first-value",
    });
    expect(() =>
      createHttpOperationClient(projectClientContract(queryApp), {
        baseUrl: "https://api.example.test",
      }),
    ).not.toThrow();
  });
  it("rejects 3xx outputs without redirect mode and non-redirect statuses with it", () => {
    expect(() =>
      defineOperation({
        ...callback,
        transport: http.get("/oauth/callback"),
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_OPERATION_OUTPUT_INVALID" }));
    expect(() =>
      defineOperation({
        ...callback,
        output: { 200: z.undefined() },
        successStatus: 200,
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_OPERATION_OUTPUT_INVALID" }));
  });

  it("returns an empty 302 with a validated Location through direct and Hono execution", async () => {
    const direct = await createExecutor(app).run("oauth.callback", {}, { requestId: "request-1" });
    expect(direct).toMatchObject({ ok: true, status: 302, data: undefined });
    const response = await createHonoAdapter(app).request("/oauth/callback");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("projects an empty 302 and required Location into the contract and OpenAPI", () => {
    const contract = projectClientContract(app);
    expect(contract.operations[0]).toMatchObject({
      success: [{ status: 302, jsonSchema: {} }],
      transport: { metadata: { response: "redirect" } },
    });
    const document = projectOpenApi(app, { title: "OAuth", version: "1" });
    const operation = document.paths["/oauth/callback"]?.get;
    expect(operation?.responses["302"]).toMatchObject({
      headers: {
        Location: { required: true, schema: { type: "string", format: "uri-reference" } },
      },
    });
    expect(operation?.responses["302"]).not.toHaveProperty("content");
  });

  it("makes manual fetch expose Location without following in a capable runtime", async () => {
    const hono = createHonoAdapter(app);
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      hono.request(input, init),
    );
    const client = createHttpOperationClient<ApplicationContractOf<typeof app>>(
      projectClientContract(app),
      { baseUrl: "https://api.example.test", fetch },
    );
    const result = await client.call("oauth.callback", {});
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(result).toMatchObject({ ok: true, status: 302, data: undefined });
    expect(result.metadata.location).toBe(location);
  });

  it("reports browser opaque redirects explicitly instead of inventing a 302", async () => {
    const opaque = { type: "opaqueredirect", status: 0 } as Response;
    const client = createHttpOperationClient<ApplicationContractOf<typeof app>>(
      projectClientContract(app),
      { baseUrl: "https://api.example.test", fetch: vi.fn(async () => opaque) },
    );
    await expect(client.call("oauth.callback", {})).rejects.toMatchObject({
      name: "OperationClientError",
      code: "SHIP_CLIENT_REDIRECT_OPAQUE",
    } satisfies Partial<OperationClientError>);
  });

  it.each([
    "javascript:alert(1)",
    "//evil.example",
    "https://user:pass@app.example.test/",
  ])("refuses unsafe Location %s before producing a 302", async (unsafeLocation) => {
    const invalid = defineOperation({
      ...callback,
      handler: () => respond(302, undefined, { headers: { Location: unsafeLocation } }),
    });
    const invalidApp = defineApp({
      id: "invalid-redirect-fixture",
      modules: [
        defineModule({
          id: "oauth",
          operations: [invalid],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    await expect(createExecutor(invalidApp).run("oauth.callback", {})).rejects.toMatchObject({
      code: "SHIP_OPERATION_OUTPUT_INVALID",
    });
    const response = await createHonoAdapter(invalidApp).request("/oauth/callback");
    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("declared HTTP redirects: failure handling", () => {
  function clientFor(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    return createHttpOperationClient<ApplicationContractOf<typeof app>>(
      projectClientContract(app),
      { baseUrl: "https://api.example.test", fetch },
    );
  }

  it.each([
    ["a protocol-relative Location", { status: 302, headers: { location: "//evil.example" } }],
    ["a missing Location", { status: 302, headers: {} }],
    [
      "a redirect that carries a body",
      {
        status: 302,
        headers: { location, "content-type": "text/html" },
        body: "<a href>moved</a>",
      },
    ],
  ])("rejects %s as a protocol-invalid response", async (_name, shape) => {
    const client = clientFor(
      async () =>
        new Response(shape.body ?? null, {
          status: shape.status,
          headers: { "x-request-id": "request-invalid", ...shape.headers },
        }),
    );

    await expect(client.call("oauth.callback", {})).rejects.toMatchObject({
      name: "OperationClientError",
      code: "SHIP_CLIENT_RESPONSE_INVALID",
    } satisfies Partial<OperationClientError>);
  });

  it("returns framework and declared failures on a redirect operation as results", async () => {
    const invalidState = operationError({
      code: "OAUTH_STATE_INVALID",
      status: 400,
      message: "OAuth state is invalid",
    });
    const guarded = defineOperation({
      ...callback,
      id: "oauth.guarded-callback",
      transport: http.get("/oauth/guarded", { response: "redirect", queryParsing: "first-value" }),
      input: { query: z.object({ code: z.string().min(1), state: z.string().min(1) }) },
      errors: [invalidState],
      handler: ({ input }) => {
        if (input.query.state === "revoked") throw operationFailure(invalidState);
        return respond(302, undefined, {
          headers: {
            Location:
              input.query.state === "state-1"
                ? location
                : "https://app.example.test/oauth?error=invalid_state",
          },
        });
      },
    });
    const guardedApp = defineApp({
      id: "guarded-redirect-fixture",
      modules: [
        defineModule({
          id: "oauth",
          operations: [guarded],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const hono = createHonoAdapter(guardedApp);
    const client = createHttpOperationClient<ApplicationContractOf<typeof guardedApp>>(
      projectClientContract(guardedApp),
      {
        baseUrl: "https://api.example.test",
        fetch: (input, init) => hono.request(input, init),
      },
    );

    await expect(
      client.call("oauth.guarded-callback", { query: { code: "c", state: "tampered" } }),
    ).resolves.toMatchObject({
      ok: true,
      status: 302,
      metadata: { location: "https://app.example.test/oauth?error=invalid_state" },
    });
    await expect(
      client.call("oauth.guarded-callback", { query: { code: "c", state: "revoked" } }),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "OAUTH_STATE_INVALID" },
    });
    const validation = await client.call("oauth.guarded-callback", {
      query: { code: "", state: "state-1" },
    });
    expect(validation).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(validation.metadata).not.toHaveProperty("location");
  });

  it("projects a POST 303 redirect truthfully", () => {
    const submit = defineOperation({
      ...callback,
      id: "forms.submit",
      transport: http.post("/forms/submit", { response: "redirect" }),
      output: { 303: z.undefined() },
      successStatus: 303,
      handler: () => respond(303, undefined, { headers: { Location: "/forms/done" } }),
    });
    const formsApp = defineApp({
      id: "form-redirect-fixture",
      modules: [
        defineModule({
          id: "forms",
          operations: [submit],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    expect(projectClientContract(formsApp).operations[0]).toMatchObject({
      success: [{ status: 303, jsonSchema: {} }],
      transport: { metadata: { method: "POST", response: "redirect" } },
    });
    const document = projectOpenApi(formsApp, { title: "Forms", version: "1" });
    expect(document.paths["/forms/submit"]?.post?.responses["303"]).toMatchObject({
      description: "Redirect",
      headers: { Location: { required: true } },
    });
    expect(document.paths["/forms/submit"]?.post?.responses["303"]).not.toHaveProperty("content");
  });
});
