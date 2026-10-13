import {
  defineApp,
  defineModule,
  defineOperation,
  defineOutbox,
  defineOutboxDispatcher,
  defineWebhook,
  defineWebhookReplay,
  defineWebhookVerifier,
  effectDependency,
  idempotencyStoreDependency,
  publicAccess,
  unitOfWorkDependency,
  valueProvider,
  webhookEventStoreDependency,
  webhookIntent,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { projectOpenApi } from "./openapi.js";
import { isWebhookTransport, projectClientContract } from "./project.js";

const storeToken = idempotencyStoreDependency("platform.idempotency");
const store = {
  kind: "ship.idempotency-store" as const,
  claim: async () => "claimed" as const,
  complete: async () => undefined,
  release: async () => undefined,
  readResult: async () => undefined,
};
const verifier = defineWebhookVerifier({
  id: "fixture",
  guarantees: { signature: true, freshness: true, replay: false },
  verify: () => ({ ok: true }),
});
const ping = defineOperation({
  id: "ingress.ping",
  transport: http.get("/ping"),
  input: {},
  output: { 200: z.object({ ok: z.boolean() }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => ({ ok: true }),
});
const webhook = defineWebhook({
  id: "ingress.hook",
  path: "/webhooks/fixture",
  provider: webhookVerifierToken({ verifier, secret: webhookSecret("s") }),
  body: { maxBytes: 65_536, mediaTypes: ["application/json", "text/plain"] },
  idempotency: {
    windowMs: 86_400_000,
    store: storeToken,
    inFlight: { kind: "retry", status: 409 },
  },
  output: { 200: z.object({ received: z.boolean() }) },
  successStatus: 200,
  transaction: "none",
  dependencies: {},
  handler: () => ({ received: true }),
});

const voice = defineWebhook({
  id: "ingress.voice",
  path: "/webhooks/voice",
  provider: webhookVerifierToken({ verifier, secret: webhookSecret("s") }),
  body: { maxBytes: 4_096, mediaTypes: ["application/x-www-form-urlencoded"] },
  idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "wait", maxMs: 500 } },
  response: { mode: "text", contentType: "text/xml" },
  transaction: "none",
  dependencies: {},
  handler: () => "<Response/>",
});
const status = defineWebhook({
  id: "ingress.status",
  path: "/webhooks/status",
  provider: webhookVerifierToken({ verifier, secret: webhookSecret("s") }),
  body: { maxBytes: 4_096, mediaTypes: ["application/x-www-form-urlencoded"] },
  idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "wait", maxMs: 500 } },
  response: { mode: "empty" },
  transaction: "none",
  dependencies: {},
  handler: () => undefined,
});
const download = defineWebhook({
  id: "ingress.download",
  path: "/webhooks/download",
  provider: webhookVerifierToken({ verifier, secret: webhookSecret("s") }),
  body: { maxBytes: 4_096, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "retry", status: 409 } },
  response: { mode: "binary", contentType: "application/pdf" },
  transaction: "none",
  dependencies: {},
  handler: () => new Uint8Array(0),
});

type FixtureOperation =
  | typeof ping
  | typeof webhook.operation
  | typeof voice.operation
  | typeof status.operation
  | typeof download.operation;

function application(operations: readonly FixtureOperation[]) {
  return defineApp({
    id: "billing-api",
    modules: [
      defineModule({
        id: "ingress",
        operations,
        providers: [valueProvider(storeToken, store)],
        imports: [],
        exports: [],
      }),
    ],
  });
}

describe("webhook response mode projection", () => {
  it("documents text, binary and empty acknowledgements under their declared representation", () => {
    const document = projectOpenApi(
      application([ping, voice.operation, status.operation, download.operation]),
      { title: "Voice", version: "1.0.0" },
    );
    const paths = document.paths as Record<
      string,
      Record<string, { responses: Record<string, Record<string, unknown>> }>
    >;
    expect(paths["/webhooks/voice"]?.post).toMatchObject({
      "x-ship-webhook": { response: { mode: "text", contentType: "text/xml" } },
    });
    expect(paths["/webhooks/voice"]?.post?.responses["200"]).toEqual({
      description: "Delivery accepted",
      content: { "text/xml": { schema: { type: "string" } } },
      headers: expect.any(Object),
    });
    expect(paths["/webhooks/download"]?.post?.responses["200"]).toMatchObject({
      content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
    });
    expect(paths["/webhooks/status"]?.post?.responses["200"]).toEqual({
      description: "Delivery accepted; no response body",
      headers: expect.any(Object),
    });
    expect(paths["/webhooks/status"]?.post?.responses["200"]).not.toHaveProperty("content");
    expect(paths["/webhooks/status"]?.post).toMatchObject({
      "x-ship-webhook": { response: { mode: "empty" } },
    });
    // Failures keep the JSON envelope regardless of the success representation.
    expect(JSON.stringify(paths["/webhooks/voice"]?.post?.responses["401"])).toContain(
      "application/json",
    );
  });

  it("keeps non-JSON webhooks out of the browser manifest", () => {
    const manifest = projectClientContract(
      application([ping, voice.operation, status.operation, download.operation]),
    );
    expect(manifest.operations.map((operation) => operation.id)).toEqual(["ingress.ping"]);
    expect(manifest.fingerprint).toBe(projectClientContract(application([ping])).fingerprint);
  });

  it("projects a mounted replay operation as an ordinary permission-gated HTTP operation", () => {
    const notifier = effectDependency<{ send(id: string): Promise<void> }>("ingress.notifier", {
      delivery: "immediate",
    });
    const outbox = defineOutbox({
      id: "ingress.outbox",
      intents: {
        process: webhookIntent({
          effect: notifier,
          perform: ({ effect, event }) => effect.send(event.eventId),
        }),
      },
    });
    const events = webhookEventStoreDependency("platform.webhook-events");
    const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
    const durable = defineWebhook({
      id: "ingress.durable",
      path: "/webhooks/durable",
      provider: webhookVerifierToken({ verifier, secret: webhookSecret("s") }),
      body: { maxBytes: 4_096, mediaTypes: ["application/json"] },
      idempotency: {
        windowMs: 60_000,
        store: storeToken,
        inFlight: { kind: "retry", status: 409 },
      },
      retention: { eventsMs: 1, claimsMs: 1 },
      receive: { mode: "enqueue", outbox, intent: "process", store: events, unitOfWork },
    });
    const replay = defineWebhookReplay({
      id: "ingress.replay",
      webhooks: [durable],
      unitOfWork,
      store: events,
      transport: { path: "/webhooks/:eventId/replay" },
    });
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 1,
      lease: { ms: 1 },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      deadLetter: true,
    });
    const app = defineApp({
      id: "billing-api",
      modules: [
        defineModule({
          id: "ingress",
          operations: [durable.operation, replay, ...dispatcher.operations],
          providers: [
            valueProvider(storeToken, store),
            valueProvider(events, {
              kind: "ship.webhook-event-store" as const,
              record: async () => undefined,
              link: async () => undefined,
              read: async () => undefined,
              cleanup: async () => ({ eventsDeleted: 0, claimsDeleted: 0 }),
            }),
            valueProvider(unitOfWork, {
              kind: "ship.unit-of-work" as const,
              id: "database.primary",
              run: async (_mode, work) => work({ marker: "tx" as const }),
            }),
            valueProvider(outbox.writer, {
              kind: "ship.outbox-backend" as const,
              outboxId: "ingress.outbox",
              record: async () => [],
              claimDue: async () => [],
              claimUnknownDue: async () => [],
              complete: async () => undefined,
              fail: async () => undefined,
              listDeadLettered: async () => [],
              retry: async () => undefined,
              discard: async () => undefined,
              cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
              health: async () => ({ pending: 0, claimed: 0, deadLettered: 0 }),
            }),
            valueProvider(notifier, { send: async () => undefined }),
          ],
          imports: [],
          exports: [],
        }),
      ],
    });
    const manifest = projectClientContract(app);
    const mounted = manifest.operations.find((operation) => operation.id === "ingress.replay");
    expect(mounted).toMatchObject({
      transport: { binding: "POST /webhooks/:eventId/replay" },
      access: { kind: "permissions", permissions: ["ship.webhooks:replay"] },
    });
    expect(manifest.operations.map((operation) => operation.id)).not.toContain("ingress.durable");
    const document = projectOpenApi(app, { title: "Voice", version: "1.0.0" });
    const path = (document.paths as Record<string, Record<string, Record<string, unknown>>>)[
      "/webhooks/{eventId}/replay"
    ]?.post;
    expect(path).toMatchObject({ operationId: "ingress.replay" });
    expect(path?.parameters).toEqual([
      expect.objectContaining({ name: "eventId", in: "path", required: true }),
    ]);
    expect(JSON.stringify(path?.responses)).toContain("WEBHOOK_EVENT_NOT_FOUND");
  });
});

describe("webhook contract projection", () => {
  it("excludes webhooks from the browser manifest without changing its fingerprint", () => {
    const withWebhook = projectClientContract(application([ping, webhook.operation]));
    const without = projectClientContract(application([ping]));
    expect(withWebhook.operations.map((operation) => operation.id)).toEqual(["ingress.ping"]);
    expect(withWebhook.fingerprint).toBe(without.fingerprint);
    expect(isWebhookTransport(webhook.operation.transport)).toBe(true);
    expect(isWebhookTransport(ping.transport)).toBe(false);
    expect(isWebhookTransport(undefined)).toBe(false);
    const included = projectClientContract(application([ping, webhook.operation]), {
      includeWebhooks: true,
    });
    expect(included.operations.map((operation) => operation.id)).toEqual([
      "ingress.hook",
      "ingress.ping",
    ]);
  });

  it("documents the provider-facing endpoint in OpenAPI with x-ship-webhook and raw media types", () => {
    const document = projectOpenApi(application([ping, webhook.operation]), {
      title: "Billing",
      version: "1.0.0",
    });
    const manifest = projectClientContract(application([ping]));
    expect(document["x-ship-contract-fingerprint"]).toBe(manifest.fingerprint);
    const path = (document.paths as Record<string, Record<string, Record<string, unknown>>>)[
      "/webhooks/fixture"
    ]?.post;
    expect(path).toMatchObject({
      operationId: "ingress.hook",
      "x-ship-access": { kind: "provider", provider: "fixture" },
      "x-ship-webhook": {
        id: "ingress.hook",
        provider: "fixture",
        verifier: "fixture",
        guarantees: { signature: true, freshness: true, replay: false },
        mode: "inline",
        idempotency: { windowMs: 86_400_000, inFlight: { kind: "retry", status: 409 } },
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { type: "string", format: "binary" } },
          "text/plain": { schema: { type: "string", format: "binary" } },
        },
        "x-ship-request-body-policy": {
          mode: "raw",
          maxBytes: 65_536,
          contentTypes: ["application/json", "text/plain"],
        },
      },
    });
    expect(path?.parameters).toBeUndefined();
    const responses = path?.responses as Record<string, { content?: Record<string, unknown> }>;
    expect(Object.keys(responses).sort()).toEqual([
      "200",
      "401",
      "409",
      "413",
      "415",
      "500",
      "503",
    ]);
    expect(JSON.stringify(responses["401"])).toContain("WEBHOOK_VERIFICATION_FAILED");
    expect(JSON.stringify(responses["409"])).toContain("WEBHOOK_IN_FLIGHT");
    expect(JSON.stringify(responses["503"])).toContain("WEBHOOK_UNAVAILABLE");
    expect(JSON.stringify(responses["500"])).toContain("WEBHOOK_HANDLER_FAILED");
    expect(document["x-ship-unbound-operations"]).toBeUndefined();
  });
});
