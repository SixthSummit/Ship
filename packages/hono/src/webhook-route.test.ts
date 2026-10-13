import {
  defineApp,
  defineModule,
  defineOutbox,
  defineOutboxDispatcher,
  defineWebhook,
  effectDependency,
  type IdempotencyStore,
  idempotencyStoreDependency,
  operationError,
  operationFailure,
  respond,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
  webhookEventStoreDependency,
  webhookIntent,
  webhookSecret,
  webhookSecretSource,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import {
  createInMemoryIdempotencyStore,
  createInMemoryOutbox,
  createInMemoryWebhookEventStore,
  fakeWebhookProvider,
} from "@sixthsummit/ship-testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHonoAdapter, HonoAdapterError } from "./adapter.js";
import { defineHonoCredentialAdapter } from "./auth.js";
import { canonicalWebhookUrl } from "./webhook-route.js";

const SECRET = "whsec_test";
const storeToken = idempotencyStoreDependency("platform.idempotency");
const eventsToken = webhookEventStoreDependency("platform.webhook-events");
const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
const notifier = effectDependency<{ send(id: string): Promise<void> }>("ingress.notifier", {
  delivery: "immediate",
});
const fake = fakeWebhookProvider();
const provider = webhookVerifierToken({ verifier: fake.verifier, secret: webhookSecret(SECRET) });
const rejectedEvent = operationError({ code: "EVENT_REJECTED", status: 422, message: "Rejected" });

function inlineWebhook(
  overrides: Partial<{
    inFlight: { kind: "wait"; maxMs: number } | { kind: "retry"; status: number };
    provider: typeof provider;
    handler: (arguments_: {
      event: { rawBody: Uint8Array; verified: { eventId?: string } };
    }) => unknown;
  }> = {},
) {
  return defineWebhook({
    id: "ingress.hook",
    path: "/webhooks/fake",
    provider: overrides.provider ?? provider,
    body: { maxBytes: 256, mediaTypes: ["application/json"] },
    idempotency: {
      windowMs: 60_000,
      store: storeToken,
      inFlight: overrides.inFlight ?? { kind: "retry", status: 409 },
    },
    output: { 200: z.object({ received: z.string(), bytes: z.number() }) },
    successStatus: 200,
    errors: [rejectedEvent],
    transaction: "none",
    dependencies: {},
    handler:
      (overrides.handler as never) ??
      (({ event }) => {
        if (event.verified.eventId === "evt_reject") throw operationFailure(rejectedEvent);
        if (event.verified.eventId === "evt_crash") throw new Error("boom with secret details");
        return { received: event.verified.eventId ?? "digest", bytes: event.rawBody.byteLength };
      }),
  });
}

function fixtureApp(
  webhook: ReturnType<typeof inlineWebhook>,
  store: IdempotencyStore = createInMemoryIdempotencyStore(),
) {
  return defineApp({
    id: "webhooks",
    modules: [
      defineModule({
        id: "ingress",
        operations: [webhook.operation],
        providers: [valueProvider(storeToken, store)],
        imports: [],
        exports: [],
      }),
    ],
  });
}

async function signed(
  body: string,
  options: Partial<{ eventId: string; secret: string; timestamp: Date; contentType: string }> = {},
) {
  const headers = await fake.sign({
    rawBody: body,
    secret: options.secret ?? SECRET,
    eventId: options.eventId ?? "evt_1",
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
  });
  return {
    method: "POST",
    headers: { ...headers, "content-type": options.contentType ?? "application/json" },
    body,
  };
}

describe("webhook response modes", () => {
  const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks</Say></Response>';
  const voice = defineWebhook({
    id: "ingress.voice",
    path: "/webhooks/voice",
    provider,
    body: { maxBytes: 256, mediaTypes: ["application/json"] },
    idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "retry", status: 409 } },
    response: { mode: "text", contentType: "text/xml" },
    errors: [rejectedEvent],
    transaction: "none",
    dependencies: {},
    handler: ({ event }) => {
      if (event.verified.eventId === "evt_reject") throw operationFailure(rejectedEvent);
      if (event.verified.eventId === "evt_crash") throw new Error("boom");
      if (event.verified.eventId === "evt_headers") {
        return respond(200, twiml, { headers: { "x-voice-step": "gather" } });
      }
      return twiml;
    },
  });
  const status = defineWebhook({
    id: "ingress.status",
    path: "/webhooks/status",
    provider,
    body: { maxBytes: 256, mediaTypes: ["application/json"] },
    idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "retry", status: 409 } },
    response: { mode: "empty" },
    transaction: "none",
    dependencies: {},
    handler: ({ event }) => {
      if (event.verified.eventId === "evt_body") return { leaked: true } as never;
      return undefined;
    },
  });
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const image = defineWebhook({
    id: "ingress.image",
    path: "/webhooks/image",
    provider,
    body: { maxBytes: 256, mediaTypes: ["application/json"] },
    idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "retry", status: 409 } },
    response: { mode: "binary", contentType: "image/png" },
    transaction: "none",
    dependencies: {},
    handler: () => bytes,
  });
  const app = createHonoAdapter(
    defineApp({
      id: "webhooks",
      modules: [
        defineModule({
          id: "ingress",
          operations: [voice.operation, status.operation, image.operation],
          providers: [valueProvider(storeToken, createInMemoryIdempotencyStore())],
          imports: [],
          exports: [],
        }),
      ],
    }),
    { webhooks: { publicBaseUrl: "https://api.example.test" } },
  );

  it("answers a text webhook with exactly the declared content type and the document body", async () => {
    const response = await app.request("/webhooks/voice", await signed('{"CallSid":"CA1"}'));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await expect(response.text()).resolves.toBe(twiml);

    // A duplicate delivery replays the same representation.
    const replayed = await app.request("/webhooks/voice", await signed('{"CallSid":"CA1"}'));
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("content-type")).toBe("text/xml");
    await expect(replayed.text()).resolves.toBe(twiml);
  });

  it("keeps the declared content type when the handler adds headers through respond()", async () => {
    const response = await app.request(
      "/webhooks/voice",
      await signed('{"CallSid":"CA2"}', { eventId: "evt_headers" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml");
    expect(response.headers.get("x-voice-step")).toBe("gather");
    await expect(response.text()).resolves.toBe(twiml);
  });

  it("answers an empty webhook with the success status, no body and no content type", async () => {
    const response = await app.request("/webhooks/status", await signed('{"CallStatus":"done"}'));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await expect(response.text()).resolves.toBe("");
    const replayed = await app.request("/webhooks/status", await signed('{"CallStatus":"done"}'));
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("content-type")).toBeNull();
    await expect(replayed.text()).resolves.toBe("");
  });

  it.each([
    "jsonb",
    "legacy",
  ])("replays a %s persisted empty receipt with the same bodiless wire response", async (storedFormat) => {
    const memory = createInMemoryIdempotencyStore();
    const persistedStore: IdempotencyStore = {
      ...memory,
      complete: async (key, result, context) => {
        const serialized = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
        if (storedFormat === "legacy") {
          delete serialized.data;
          delete serialized.dataUndefined;
        }
        await memory.complete(key, serialized, context);
      },
    };
    const persistedApp = createHonoAdapter(
      defineApp({
        id: "persisted-empty-webhook",
        modules: [
          defineModule({
            id: "ingress",
            operations: [status.operation],
            providers: [valueProvider(storeToken, persistedStore)],
            imports: [],
            exports: [],
          }),
        ],
      }),
      { webhooks: { publicBaseUrl: "https://api.example.test" } },
    );
    const request = await signed('{"CallStatus":"done"}');
    const first = await persistedApp.request("/webhooks/status", request);
    const replay = await persistedApp.request("/webhooks/status", request);
    for (const response of [first, replay]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBeNull();
      await expect(response.text()).resolves.toBe("");
    }
  });

  it("sends binary bytes under the declared content type", async () => {
    const response = await app.request("/webhooks/image", await signed('{"id":"img"}'));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("still serializes every failure as the JSON envelope for non-JSON modes", async () => {
    const forged = await app.request("/webhooks/voice", {
      ...(await signed('{"CallSid":"CA3"}')),
      body: '{"CallSid":"CA4"}',
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    await expect(forged.json()).resolves.toMatchObject({
      success: false,
      error: { code: "WEBHOOK_VERIFICATION_FAILED" },
    });

    const declared = await app.request(
      "/webhooks/voice",
      await signed('{"CallSid":"CA5"}', { eventId: "evt_reject" }),
    );
    expect(declared.status).toBe(422);
    expect(declared.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    await expect(declared.json()).resolves.toMatchObject({ error: { code: "EVENT_REJECTED" } });

    const crashed = await app.request(
      "/webhooks/voice",
      await signed('{"CallSid":"CA6"}', { eventId: "evt_crash" }),
    );
    expect(crashed.status).toBe(500);
    expect(crashed.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    await expect(crashed.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_HANDLER_FAILED" },
    });

    // An empty webhook whose handler leaks a body is a defect, never a body on the wire.
    const leaked = await app.request(
      "/webhooks/status",
      await signed('{"CallStatus":"leak"}', { eventId: "evt_body" }),
    );
    expect(leaked.status).toBe(500);
    expect(leaked.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    await expect(leaked.text()).resolves.not.toContain("leaked");
  });
});

describe("webhook routes", () => {
  it("uses the configured JSON failure media type for webhook verification failures", async () => {
    const app = createHonoAdapter(fixtureApp(inlineWebhook()), {
      webhooks: { publicBaseUrl: "https://api.example.test" },
      failureContentType: "application/json",
    });
    const request = await signed('{"id":"evt_1"}');
    const response = await app.request("/webhooks/fake", {
      ...request,
      body: '{"id":"tampered"}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("verifies exact bytes before any actor exists, then runs the handler once per event", async () => {
    const extract = vi.fn(() => undefined);
    const observer = { received: vi.fn(), dispatched: vi.fn() };
    const app = createHonoAdapter(fixtureApp(inlineWebhook()), {
      auth: {
        credentials: defineHonoCredentialAdapter({ id: "http.never", extract }),
        actors: { id: "auth.never", resolve: () => ({ ok: true }) },
      },
      webhooks: { publicBaseUrl: "https://api.example.test", observer },
    });
    const body = '{"id":"evt_1","amount":10}';
    const first = await app.request("/webhooks/fake", await signed(body));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-request-id")).toBeTruthy();
    await expect(first.json()).resolves.toEqual({ received: "evt_1", bytes: body.length });
    expect(extract).not.toHaveBeenCalled();
    expect(observer.received).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webhookId: "ingress.hook",
        provider: "fake-provider",
        outcome: "accepted",
        status: 200,
      }),
    );

    const duplicate = await app.request("/webhooks/fake", await signed(body));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ received: "evt_1", bytes: body.length });
    expect(observer.received).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "duplicate", status: 200 }),
    );
  });

  it("returns a stable 401 without body content or stack on verification failure", async () => {
    const observer = { received: vi.fn() };
    const onUnexpectedError = vi.fn();
    const app = createHonoAdapter(fixtureApp(inlineWebhook()), {
      webhooks: { publicBaseUrl: "https://api.example.test", observer },
      onUnexpectedError,
    });
    const body = '{"id":"evt_1","card":"4242424242424242"}';
    const request = await signed(body);
    const tampered = await app.request("/webhooks/fake", {
      ...request,
      body: '{"id":"evt_1","card":"5555"}',
    });
    expect(tampered.status).toBe(401);
    const text = await tampered.text();
    expect(JSON.parse(text)).toEqual({
      success: false,
      error: { code: "WEBHOOK_VERIFICATION_FAILED", message: "Webhook verification failed" },
    });
    expect(text).not.toContain("4242");
    expect(text).not.toContain("5555");
    expect(text).not.toMatch(/stack|at /u);
    expect(observer.received).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rejected", status: 401, reason: "signature-mismatch" }),
    );

    const stale = await app.request(
      "/webhooks/fake",
      await signed(body, { timestamp: new Date(Date.now() - 10 * 60_000) }),
    );
    expect(stale.status).toBe(401);
    expect(observer.received).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "rejected", reason: "timestamp-stale" }),
    );
    const unsigned = await app.request("/webhooks/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unsigned.status).toBe(401);
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("bounds the body before verification and rejects undeclared media types", async () => {
    const app = createHonoAdapter(fixtureApp(inlineWebhook()), {
      webhooks: { publicBaseUrl: "https://api.example.test" },
    });
    const huge = await app.request("/webhooks/fake", await signed("x".repeat(300)));
    expect(huge.status).toBe(413);
    await expect(huge.json()).resolves.toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
    const wrongType = await app.request(
      "/webhooks/fake",
      await signed("{}", { contentType: "text/plain" }),
    );
    expect(wrongType.status).toBe(415);
  });

  it("derives the canonical URL from the declared base URL, never the request host", async () => {
    const seen: string[] = [];
    const verifier = {
      ...fake.verifier,
      verify: (request: Parameters<typeof fake.verifier.verify>[0]) => {
        seen.push(request.canonicalUrl);
        return fake.verifier.verify(request);
      },
    };
    const app = createHonoAdapter(
      fixtureApp(
        inlineWebhook({
          provider: webhookVerifierToken({ verifier, secret: webhookSecret("old", SECRET) }),
        }),
      ),
      { webhooks: { publicBaseUrl: "https://public.example.test/api/" } },
    );
    const response = await app.request("http://internal:8080/webhooks/fake", {
      ...(await signed("{}")),
      headers: {
        ...(await signed("{}")).headers,
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });
    expect(response.status).toBe(200);
    // Both rotated secrets were tried in order; the second one verified.
    expect(seen).toEqual([
      "https://public.example.test/api/webhooks/fake",
      "https://public.example.test/api/webhooks/fake",
    ]);
    expect(canonicalWebhookUrl("https://x.test", "/w")).toBe("https://x.test/w");
  });

  it("answers 503 with Retry-After when secrets are unavailable", async () => {
    const failing = webhookSecretSource({
      id: "vault",
      current: async () => {
        throw new Error("vault down");
      },
    });
    const empty = webhookSecretSource({ id: "vault", current: () => [] });
    const onUnexpectedError = vi.fn();
    for (const [secret, reported] of [
      [failing, 1],
      [empty, 1],
    ] as const) {
      const app = createHonoAdapter(
        fixtureApp(
          inlineWebhook({ provider: webhookVerifierToken({ verifier: fake.verifier, secret }) }),
        ),
        { webhooks: { publicBaseUrl: "https://api.example.test" }, onUnexpectedError },
      );
      const response = await app.request("/webhooks/fake", await signed("{}"));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "WEBHOOK_SECRET_UNAVAILABLE" },
      });
      expect(onUnexpectedError).toHaveBeenCalledTimes(reported);
    }
  });

  it("follows the declared in-flight policy: retry status or bounded wait", async () => {
    const store = createInMemoryIdempotencyStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = inlineWebhook({
      inFlight: { kind: "retry", status: 425 },
      handler: async ({ event }) => {
        await gate;
        return { received: event.verified.eventId ?? "", bytes: 0 };
      },
    });
    const retryApp = createHonoAdapter(fixtureApp(slow, store), {
      webhooks: { publicBaseUrl: "https://api.example.test" },
    });
    const request = await signed("{}");
    const pending = retryApp.request("/webhooks/fake", request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const concurrent = await retryApp.request("/webhooks/fake", request);
    expect(concurrent.status).toBe(425);
    expect(concurrent.headers.get("retry-after")).toBe("1");
    await expect(concurrent.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_IN_FLIGHT" },
    });
    release();
    expect((await pending).status).toBe(200);

    const waitStore = createInMemoryIdempotencyStore();
    let releaseWait: () => void = () => undefined;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const waiting = inlineWebhook({
      inFlight: { kind: "wait", maxMs: 2_000 },
      handler: async ({ event }) => {
        await waitGate;
        return { received: event.verified.eventId ?? "", bytes: 1 };
      },
    });
    const waitApp = createHonoAdapter(fixtureApp(waiting, waitStore), {
      webhooks: { publicBaseUrl: "https://api.example.test", waitPollMs: 5 },
    });
    const firstWait = waitApp.request("/webhooks/fake", request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondWait = waitApp.request("/webhooks/fake", request);
    setTimeout(() => releaseWait(), 40);
    const [a, b] = await Promise.all([firstWait, secondWait]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await expect(b.json()).resolves.toEqual({ received: "evt_1", bytes: 1 });

    const timeoutApp = createHonoAdapter(
      fixtureApp(inlineWebhook({ inFlight: { kind: "wait", maxMs: 30 } }), {
        ...createInMemoryIdempotencyStore(),
        claim: async () => "in-flight",
      }),
      { webhooks: { publicBaseUrl: "https://api.example.test", waitPollMs: 5 } },
    );
    const timedOut = await timeoutApp.request("/webhooks/fake", request);
    expect(timedOut.status).toBe(503);
    await expect(timedOut.json()).resolves.toMatchObject({ error: { code: "WEBHOOK_IN_FLIGHT" } });
  });

  it("answers 503 instead of accepting into memory when the idempotency store is down", async () => {
    const handler = vi.fn(() => ({ received: "x", bytes: 0 }));
    const down: IdempotencyStore = {
      kind: "ship.idempotency-store",
      claim: async () => {
        throw new Error("connection refused");
      },
      complete: async () => undefined,
      release: async () => undefined,
      readResult: async () => undefined,
    };
    const observer = { received: vi.fn() };
    const onUnexpectedError = vi.fn();
    const app = createHonoAdapter(fixtureApp(inlineWebhook({ handler }), down), {
      webhooks: { publicBaseUrl: "https://api.example.test", observer },
      onUnexpectedError,
    });
    const response = await app.request("/webhooks/fake", await signed("{}"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: "WEBHOOK_UNAVAILABLE", message: "Webhook receipt is temporarily unavailable" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(observer.received).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "unavailable",
        status: 503,
        reason: "SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE",
      }),
    );
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
  });

  it("maps handler failures to 500 without leaking details and declared errors to their status", async () => {
    const onUnexpectedError = vi.fn();
    const app = createHonoAdapter(fixtureApp(inlineWebhook()), {
      webhooks: { publicBaseUrl: "https://api.example.test" },
      onUnexpectedError,
    });
    const crashed = await app.request(
      "/webhooks/fake",
      await signed("{}", { eventId: "evt_crash" }),
    );
    expect(crashed.status).toBe(500);
    const text = await crashed.text();
    expect(JSON.parse(text)).toEqual({
      success: false,
      error: { code: "WEBHOOK_HANDLER_FAILED", message: "Webhook processing failed" },
    });
    expect(text).not.toContain("secret details");
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);

    const rejected = await app.request(
      "/webhooks/fake",
      await signed("{}", { eventId: "evt_reject" }),
    );
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "EVENT_REJECTED" } });
    // A released claim lets the provider retry the rejected delivery.
    const retried = await app.request(
      "/webhooks/fake",
      await signed("{}", { eventId: "evt_reject" }),
    );
    expect(retried.status).toBe(422);
  });

  it("requires a public base URL and validates webhook options when webhooks are declared", () => {
    expect(() => createHonoAdapter(fixtureApp(inlineWebhook()))).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_WEBHOOK_BASE_URL_REQUIRED" }),
    );
    for (const publicBaseUrl of ["api.example.test", "https://api.example.test/?x=1", "ftp://x"]) {
      expect(() =>
        createHonoAdapter(fixtureApp(inlineWebhook()), { webhooks: { publicBaseUrl } }),
      ).toThrow(HonoAdapterError);
    }
    expect(() =>
      createHonoAdapter(fixtureApp(inlineWebhook()), {
        webhooks: { publicBaseUrl: "https://api.example.test", waitPollMs: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_HONO_OPTIONS_INVALID" }));
    expect(() =>
      createHonoAdapter(fixtureApp(inlineWebhook()), {
        webhooks: { publicBaseUrl: "https://api.example.test", clock: 5 as never },
      }),
    ).toThrow(HonoAdapterError);
    // Applications without webhooks never need the option.
    expect(() =>
      createHonoAdapter(
        defineApp({
          id: "plain",
          modules: [
            defineModule({ id: "m", operations: [], providers: [], imports: [], exports: [] }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("acknowledges an enqueue-mode delivery only after the event and intent are recorded", async () => {
    const outbox = defineOutbox({
      id: "ingress.outbox",
      intents: { process: webhookIntent({ effect: notifier, perform: async () => undefined }) },
    });
    const webhook = defineWebhook({
      id: "ingress.hook",
      path: "/webhooks/fake",
      provider,
      body: { maxBytes: 256, mediaTypes: ["application/json"] },
      idempotency: {
        windowMs: 60_000,
        store: storeToken,
        inFlight: { kind: "retry", status: 409 },
      },
      retention: { eventsMs: 1, claimsMs: 1 },
      receive: { mode: "enqueue", outbox, intent: "process", store: eventsToken, unitOfWork },
    });
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 1,
      lease: { ms: 1 },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      deadLetter: true,
    });
    const backend = createInMemoryOutbox(outbox);
    const events = createInMemoryWebhookEventStore({ outbox: backend });
    const tx: UnitOfWork<{ readonly marker: "tx" }> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      run: async (_mode, work) => work({ marker: "tx" }),
    };
    const app = createHonoAdapter(
      defineApp({
        id: "webhooks",
        modules: [
          defineModule({
            id: "ingress",
            operations: [webhook.operation, ...dispatcher.operations],
            providers: [
              valueProvider(storeToken, createInMemoryIdempotencyStore()),
              valueProvider(eventsToken, events),
              valueProvider(unitOfWork, tx),
              valueProvider(outbox.writer, backend),
              valueProvider(notifier, { send: async () => undefined }),
            ],
            imports: [],
            exports: [],
          }),
        ],
      }),
      { webhooks: { publicBaseUrl: "https://api.example.test" } },
    );
    const body = '{"id":"evt_1"}';
    const response = await app.request("/webhooks/fake", await signed(body));
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { accepted: boolean; eventId: string };
    expect(accepted.accepted).toBe(true);
    expect(events.events()).toMatchObject([
      { id: accepted.eventId, providerEventId: "evt_1", outboxRecordId: "ingress.outbox:1" },
    ]);
    expect(events.events()[0]?.headers).not.toHaveProperty("x-fake-provider-signature");
    expect(new TextDecoder().decode(events.events()[0]?.body)).toBe(body);
    expect(backend.records()).toMatchObject([
      { intentId: "process", payload: { eventId: accepted.eventId } },
    ]);
  });
});
