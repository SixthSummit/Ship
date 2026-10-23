import {
  type AnyOperation,
  defineApp,
  defineModule,
  defineOperation,
  defineWebhook,
  idempotencyStoreDependency,
  operationError,
  operationFailure,
  publicAccess,
  respond,
  valueProvider,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { createInMemoryIdempotencyStore, fakeWebhookProvider } from "@sixthsummit/ship-testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHonoAdapter, HonoAdapterError } from "./adapter.js";
import type { HonoCorsOptions } from "./cors.js";
import { http } from "./transport.js";

const APP_ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://evil.example.test";

const rateLimited = operationError({
  code: "FIXTURE_RATE_LIMITED",
  status: 429,
  message: "Too many requests",
  headers: ["Retry-After"] as const,
});

function readOperation(
  handler: (input: { params: { fixtureId: number } }) => unknown = ({ params }) => ({
    fixtureId: params.fixtureId,
  }),
) {
  return defineOperation({
    id: "fixtures.read",
    transport: http.get("/fixtures/:fixtureId"),
    input: { params: z.object({ fixtureId: z.coerce.number().int().positive() }) },
    output: { 200: z.object({ fixtureId: z.number() }) },
    successStatus: 200,
    errors: [rateLimited],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: ({ input }) => handler(input) as { fixtureId: number },
  });
}

function streamOperation() {
  return defineOperation({
    id: "fixtures.stream",
    transport: http.post("/streams/:streamId", {
      response: {
        mode: "stream",
        framing: "sse",
        frame: z.object({ step: z.number().int() }),
        heartbeatMs: 1000,
        maxDurationMs: 5000,
        maxFrames: 10,
      },
    }),
    input: { params: z.object({ streamId: z.string() }), body: z.object({ frames: z.number() }) },
    output: { 200: z.object({ steps: z.number().int() }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: async ({ input, stream }) => {
      for (let step = 1; step <= input.body.frames; step += 1) await stream.emit({ step });
      return { steps: input.body.frames };
    },
  });
}

function fixtureApp(...operations: readonly AnyOperation[]) {
  return defineApp({
    id: "cors-fixture",
    modules: [
      defineModule({
        id: "fixtures",
        operations: [...operations],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
}

function preflight(path: string, origin = APP_ORIGIN, method = "GET", requestHeaders?: string) {
  return {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      ...(requestHeaders ? { "access-control-request-headers": requestHeaders } : {}),
    },
  };
}

describe("createHonoAdapter cors", () => {
  const allowlist: HonoCorsOptions = { origin: [APP_ORIGIN], credentials: true };

  it("answers an operation preflight without reaching the 404 handler", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()), { cors: allowlist });

    const response = await app.request(
      "/fixtures/1",
      preflight("/fixtures/1", APP_ORIGIN, "GET", "x-request-id, authorization"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(response.headers.get("access-control-allow-headers")).toBe("x-request-id,authorization");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("marks a simple request and exposes the framework and declared headers", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()), { cors: allowlist });

    const response = await app.request("/fixtures/7", {
      headers: { origin: APP_ORIGIN, "x-request-id": "cors-simple" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixtureId: 7 });
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Request-Id,X-Ship-Cache,Retry-After",
    );
    expect(response.headers.get("x-request-id")).toBe("cors-simple");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("carries the policy on declared failures and on unmatched routes", async () => {
    const app = createHonoAdapter(
      fixtureApp(
        readOperation(() => {
          throw operationFailure(rateLimited, { headers: { "Retry-After": "30" } });
        }),
      ),
      { cors: allowlist },
    );

    const failure = await app.request("/fixtures/1", { headers: { origin: APP_ORIGIN } });
    expect(failure.status).toBe(429);
    expect(failure.headers.get("retry-after")).toBe("30");
    expect(failure.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);

    const missing = await app.request("/nowhere", { headers: { origin: APP_ORIGIN } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  it("omits the allow-origin header for an origin outside the allowlist", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()), { cors: allowlist });

    const response = await app.request("/fixtures/1", { headers: { origin: OTHER_ORIGIN } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("accepts a wildcard origin without credentials", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()), { cors: { origin: "*" } });

    const response = await app.request("/fixtures/1", { headers: { origin: OTHER_ORIGIN } });

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  it("resolves the origin through a per-request function", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()), {
      cors: {
        origin: (origin) => (origin.endsWith(".example.test") ? origin : null),
        credentials: true,
      },
    });

    const allowed = await app.request("/fixtures/1", { headers: { origin: APP_ORIGIN } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    const denied = await app.request("/fixtures/1", { headers: { origin: "https://else.where" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a wildcard origin combined with credentials at construction", () => {
    const application = fixtureApp(readOperation());
    for (const origin of ["*", ["*"], ["*", APP_ORIGIN]] as const) {
      let caught: unknown;
      try {
        createHonoAdapter(application, { cors: { origin, credentials: true } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HonoAdapterError);
      expect(caught).toMatchObject({ code: "SHIP_HONO_CORS_INVALID" });
      expect((caught as Error).message).toMatch(/credentials: true/u);
    }
  });

  it("rejects malformed cors options at construction", () => {
    const application = fixtureApp(readOperation());
    const invalid: readonly unknown[] = [
      { origin: "" },
      { origin: [] },
      { origin: [APP_ORIGIN, 7] },
      { origin: APP_ORIGIN, maxAge: -1 },
      { origin: APP_ORIGIN, maxAge: 1.5 },
      { origin: APP_ORIGIN, allowHeaders: "X-Custom" },
      { origin: APP_ORIGIN, exposeHeaders: [""] },
      { origin: APP_ORIGIN, credentials: "yes" },
      null,
    ];
    for (const cors of invalid) {
      expect(() => createHonoAdapter(application, { cors: cors as never })).toThrow(
        expect.objectContaining({ code: "SHIP_HONO_CORS_INVALID" }),
      );
    }
  });

  it("keeps the framework request headers inside an explicit allowHeaders list", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()), {
      cors: {
        origin: APP_ORIGIN,
        allowHeaders: ["Authorization", "content-type"],
        exposeHeaders: ["X-Total-Count", "x-request-id"],
        allowMethods: ["GET", "POST"],
        maxAge: 600,
      },
    });

    const response = await app.request("/fixtures/1", preflight("/fixtures/1", APP_ORIGIN, "POST"));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type,X-Request-Id,Authorization",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Request-Id,X-Ship-Cache,Retry-After,X-Total-Count",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST");
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  it("answers a streaming preflight and marks the event stream", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation()), { cors: allowlist });

    const options = await app.request(
      "/streams/alpha",
      preflight("/streams/alpha", APP_ORIGIN, "POST", "content-type"),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(options.headers.get("access-control-allow-headers")).toBe("content-type");

    const stream = await app.request("/streams/alpha", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ frames: 2 }),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(stream.headers.get("access-control-expose-headers")).toBe("X-Request-Id,X-Ship-Cache");
    expect(await stream.text()).toContain('"step":2');
  });

  it("answers a webhook preflight and marks the verified response", async () => {
    const storeToken = idempotencyStoreDependency("platform.idempotency");
    const fake = fakeWebhookProvider();
    const hook = defineWebhook({
      id: "ingress.hook",
      path: "/webhooks/fake",
      provider: webhookVerifierToken({ verifier: fake.verifier, secret: webhookSecret("whsec") }),
      body: { maxBytes: 256, mediaTypes: ["application/json"] },
      idempotency: {
        windowMs: 60_000,
        store: storeToken,
        inFlight: { kind: "retry", status: 409 },
      },
      output: { 200: z.object({ received: z.string() }) },
      successStatus: 200,
      errors: [],
      transaction: "none",
      dependencies: {},
      handler: ({ event }) => ({ received: event.verified.eventId ?? "digest" }),
    });
    const application = defineApp({
      id: "cors-webhooks",
      modules: [
        defineModule({
          id: "ingress",
          operations: [hook.operation],
          providers: [valueProvider(storeToken, createInMemoryIdempotencyStore())],
          imports: [],
          exports: [],
        }),
      ],
    });
    const app = createHonoAdapter(application, {
      cors: allowlist,
      webhooks: { publicBaseUrl: "https://hooks.example.test" },
    });

    const options = await app.request(
      "/webhooks/fake",
      preflight("/webhooks/fake", APP_ORIGIN, "POST"),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);

    const body = JSON.stringify({ id: "evt_1" });
    const headers = await fake.sign({ rawBody: body, secret: "whsec", eventId: "evt_1" });
    const delivered = await app.request("/webhooks/fake", {
      method: "POST",
      headers: { ...headers, origin: APP_ORIGIN, "content-type": "application/json" },
      body,
    });
    expect(delivered.status).toBe(200);
    expect(delivered.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  it("refuses to combine cors with a declared OPTIONS operation", () => {
    const optionsOperation = defineOperation({
      id: "fixtures.options",
      transport: http.options("/fixtures"),
      input: {},
      output: { 204: z.undefined() },
      successStatus: 204,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => undefined,
    });

    expect(() => createHonoAdapter(fixtureApp(optionsOperation), { cors: allowlist })).toThrow(
      expect.objectContaining({
        code: "SHIP_HONO_CORS_INVALID",
        message: expect.stringContaining('"fixtures.options"'),
      }),
    );
    expect(() => createHonoAdapter(fixtureApp(optionsOperation))).not.toThrow();
  });

  it("keeps Access-Control headers framework-owned on operation responses", async () => {
    const app = createHonoAdapter(
      fixtureApp(
        readOperation(({ params }) =>
          respond(
            200,
            { fixtureId: params.fixtureId },
            { headers: { "Access-Control-Allow-Origin": "*" } },
          ),
        ),
      ),
      { cors: allowlist },
    );

    const response = await app.request("/fixtures/1", { headers: { origin: OTHER_ORIGIN } });

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("emits no CORS headers when the option is omitted", async () => {
    const app = createHonoAdapter(fixtureApp(readOperation()));

    const response = await app.request("/fixtures/1", { headers: { origin: APP_ORIGIN } });
    expect(response.status).toBe(200);
    expect([...response.headers.keys()].some((name) => name.startsWith("access-control-"))).toBe(
      false,
    );

    const options = await app.request("/fixtures/1", preflight("/fixtures/1"));
    expect(options.status).toBe(404);
  });
});
