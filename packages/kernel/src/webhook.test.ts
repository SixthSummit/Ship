import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { humanActor, providerActor, systemActor } from "./actor.js";
import { ApplicationCompilationError, defineApp } from "./application.js";
import {
  dependency,
  effectDependency,
  type UnitOfWork,
  unitOfWorkDependency,
} from "./dependency.js";
import { createExecutor, OperationExecutionError } from "./executor.js";
import type { IdempotencyStore, StoredIdempotentResult } from "./idempotency.js";
import { idempotencyStoreDependency } from "./idempotency.js";
import { defineModule } from "./module.js";
import { respond } from "./operation.js";
import { operationError, operationFailure } from "./operation-error.js";
import type { OutboxBackend, OutboxIntentInput, OutboxRecord } from "./outbox.js";
import { defineOutbox, defineOutboxDispatcher, outboxIntent } from "./outbox.js";
import { valueProvider } from "./provider.js";
import {
  type AnyWebhook,
  defineWebhook,
  defineWebhookCleanup,
  defineWebhookReplay,
  defineWebhookVerifier,
  describeWebhookOperation,
  InvalidWebhookDefinitionError,
  isWebhook,
  isWebhookEventStore,
  isWebhookTransport,
  isWebhookVerification,
  isWebhookVerifier,
  isWebhookVerifierToken,
  redactHeaders,
  type StoredWebhookEvent,
  WEBHOOK_REPLAY_PERMISSION,
  type WebhookEventStore,
  webhookEventStoreDependency,
  webhookIntent,
  webhookSecret,
  webhookSecretSource,
  webhookVerifierToken,
} from "./webhook.js";

const storeToken = idempotencyStoreDependency("platform.idempotency");
const eventsToken = webhookEventStoreDependency("platform.webhook-events");
const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
const notifier = effectDependency<{ send(eventId: string): Promise<void> }>("ingress.notifier", {
  delivery: "immediate",
});
const DIGEST = "a".repeat(64);

const verifier = defineWebhookVerifier({
  id: "fixture",
  guarantees: { signature: true, freshness: false, replay: false },
  sensitiveHeaders: ["X-Fixture-Signature"],
  verify: ({ headers }) =>
    headers["x-fixture-signature"] === "ok"
      ? { ok: true }
      : { ok: false, reason: "signature-mismatch" },
});
const provider = webhookVerifierToken({ verifier, secret: webhookSecret("s1") });

function fakeIdempotencyStore(): IdempotencyStore & {
  readonly entries: Map<string, { status: string; result?: unknown }>;
} {
  const entries = new Map<string, { status: string; result?: unknown }>();
  return {
    kind: "ship.idempotency-store",
    entries,
    claim: async (key) => {
      const existing = entries.get(key);
      if (existing?.status === "completed") return "duplicate";
      if (existing?.status === "in-flight") return "in-flight";
      entries.set(key, { status: "in-flight" });
      return "claimed";
    },
    complete: async (key, result) => {
      entries.set(key, { status: "completed", result });
    },
    release: async (key) => {
      entries.delete(key);
    },
    readResult: async (key) => entries.get(key)?.result as StoredIdempotentResult | undefined,
  };
}

function fakeOutbox(outboxId: string): OutboxBackend & { readonly rows: OutboxRecord[] } {
  const rows: OutboxRecord[] = [];
  let sequence = 0;
  return {
    kind: "ship.outbox-backend",
    outboxId,
    rows,
    record: async (_scope, intents: readonly OutboxIntentInput[]) =>
      intents.map((intent) => {
        if (intent.dedupeKey && rows.some((row) => row.dedupeKey === intent.dedupeKey)) {
          return { deduplicated: true as const };
        }
        sequence += 1;
        const id = `${outboxId}:${sequence}`;
        rows.push({
          id,
          outboxId,
          intentId: intent.intentId,
          payload: intent.payload,
          ...(intent.dedupeKey ? { dedupeKey: intent.dedupeKey } : {}),
          status: "pending",
          attempts: 0,
          availableAt: intent.availableAt,
          createdAt: new Date(),
        });
        return { recordId: id, deduplicated: false as const };
      }),
    claimDue: async () => {
      const due = rows.filter((row) => row.status === "pending");
      return due.map((row) => {
        const claimed = { ...row, status: "claimed" as const };
        rows[rows.indexOf(row)] = claimed;
        return claimed;
      });
    },
    claimUnknownDue: async () => [],
    complete: async (recordId, now) => {
      const index = rows.findIndex((row) => row.id === recordId);
      rows[index] = { ...rows[index]!, status: "completed", completedAt: now };
    },
    fail: async () => undefined,
    listDeadLettered: async () => [],
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
    health: async () => ({ pending: 0, claimed: 0, deadLettered: 0 }),
  };
}

function fakeEventStore(): WebhookEventStore & {
  readonly events: Map<string, StoredWebhookEvent>;
  readonly calls: string[];
} {
  const events = new Map<string, StoredWebhookEvent>();
  const calls: string[] = [];
  return {
    kind: "ship.webhook-event-store",
    events,
    calls,
    record: async (scope, event) => {
      calls.push(`record:${(scope as { marker: string }).marker}`);
      events.set(event.id, { ...event });
    },
    link: async (scope, eventId, outboxRecordId) => {
      calls.push(`link:${(scope as { marker: string }).marker}`);
      events.set(eventId, { ...events.get(eventId)!, outboxRecordId });
    },
    read: async (eventId) => events.get(eventId),
    cleanup: async (request) => {
      calls.push(`cleanup:${request.webhookId}:${request.claimKeyPrefix}`);
      let eventsDeleted = 0;
      for (const [id, event] of events) {
        if (event.receivedAt < request.eventsBefore) {
          events.delete(id);
          eventsDeleted += 1;
        }
      }
      return { eventsDeleted, claimsDeleted: 2 };
    },
  };
}

function fakeUnitOfWork(): UnitOfWork<{ readonly marker: "tx" }> {
  return {
    kind: "ship.unit-of-work",
    id: "database.primary",
    run: async (_mode, work) => work({ marker: "tx" }),
  };
}

const baseDefinition = {
  path: "/webhooks/fixture",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/JSON"] },
  idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "retry", status: 409 } },
} as const;

function receipt(overrides: Partial<{ eventId: string; body: string }> = {}) {
  return {
    headers: { "content-type": "application/json", "x-fixture-signature": "ok" },
    body: new TextEncoder().encode(overrides.body ?? '{"id":"evt_1"}'),
    verified: {
      ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
      bodyDigest: DIGEST,
    },
  };
}

describe("webhook verifier contracts", () => {
  it("freezes verifiers, lower-cases sensitive headers and validates tokens", () => {
    expect(verifier.sensitiveHeaders).toEqual(["x-fixture-signature"]);
    expect(Object.isFrozen(verifier.guarantees)).toBe(true);
    expect(isWebhookVerifier(verifier)).toBe(true);
    expect(isWebhookVerifier({ id: "x", verify: () => ({ ok: true }) })).toBe(false);
    expect(isWebhookVerifierToken(provider)).toBe(true);
    expect(provider.provider).toBe("fixture");
    expect(
      webhookVerifierToken({ provider: "payments.primary", verifier, secret: webhookSecret("a") })
        .provider,
    ).toBe("payments.primary");
    expect(isWebhookVerification({ ok: true, eventId: "e", timestamp: new Date() })).toBe(true);
    expect(isWebhookVerification({ ok: false, reason: "signature-mismatch" })).toBe(true);
    expect(isWebhookVerification({ ok: false, reason: "because" })).toBe(false);
    expect(isWebhookVerification({ ok: true, eventId: "" })).toBe(false);
  });

  it("rejects verifiers without explicit guarantees or invalid ids", () => {
    expect(() =>
      defineWebhookVerifier({
        id: "partial",
        guarantees: { signature: true } as never,
        verify: () => ({ ok: true }),
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_VERIFIER_GUARANTEES_UNDECLARED" }));
    expect(() =>
      defineWebhookVerifier({
        id: "Bad Id",
        guarantees: { signature: true, freshness: true, replay: false },
        verify: () => ({ ok: true }),
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_VERIFIER_INVALID" }));
    expect(() => defineWebhookVerifier(null as never)).toThrow(InvalidWebhookDefinitionError);
    expect(() =>
      defineWebhookVerifier({
        id: "no-verify",
        guarantees: { signature: true, freshness: true, replay: false },
      } as never),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_VERIFIER_INVALID" }));
  });

  it("validates secret sources and provider ids", async () => {
    expect(() => webhookSecret()).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_SECRET_INVALID" }),
    );
    expect(() => webhookSecret("")).toThrow(InvalidWebhookDefinitionError);
    expect(webhookSecret("new", "old").current()).toEqual(["new", "old"]);
    const rotating = webhookSecretSource({ id: "vault.stripe", current: async () => ["v"] });
    await expect(rotating.current()).resolves.toEqual(["v"]);
    expect(() => webhookSecretSource({ id: "Bad", current: () => [] })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_SECRET_INVALID" }),
    );
    expect(() => webhookVerifierToken({ verifier, secret: { kind: "nope" } as never })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_SECRET_INVALID" }),
    );
    expect(() =>
      webhookVerifierToken({ provider: "Nope", verifier, secret: webhookSecret("a") }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_PROVIDER_INVALID" }));
    expect(() => webhookVerifierToken(undefined as never)).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_PROVIDER_INVALID" }),
    );
  });
});

describe("defineWebhook diagnostics", () => {
  const inline = (overrides: Record<string, unknown>) =>
    defineWebhook({
      id: "ingress.fixture-webhook",
      ...baseDefinition,
      output: { 200: z.object({ ok: z.boolean() }) },
      successStatus: 200,
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true }),
      ...overrides,
    } as never);

  it.each([
    ["definition", null, "SHIP_WEBHOOK_DEFINITION_INVALID"],
    ["id", { id: "single" }, "SHIP_WEBHOOK_ID_INVALID"],
    ["path", { path: "/webhooks/:id" }, "SHIP_WEBHOOK_PATH_INVALID"],
    ["path trailing", { path: "/webhooks/" }, "SHIP_WEBHOOK_PATH_INVALID"],
    ["provider", { provider: { kind: "other" } }, "SHIP_WEBHOOK_PROVIDER_INVALID"],
    [
      "body",
      { body: { maxBytes: 0, mediaTypes: ["application/json"] } },
      "SHIP_WEBHOOK_BODY_POLICY_INVALID",
    ],
    ["media types", { body: { maxBytes: 1, mediaTypes: [] } }, "SHIP_WEBHOOK_BODY_POLICY_INVALID"],
    [
      "duplicate media types",
      { body: { maxBytes: 1, mediaTypes: ["a/b", "A/B"] } },
      "SHIP_WEBHOOK_BODY_POLICY_INVALID",
    ],
    ["idempotency", { idempotency: undefined }, "SHIP_WEBHOOK_IDEMPOTENCY_INVALID"],
    [
      "store",
      { idempotency: { windowMs: 1, inFlight: { kind: "retry", status: 409 } } },
      "SHIP_WEBHOOK_IDEMPOTENCY_STORE_REQUIRED",
    ],
    [
      "window",
      { idempotency: { windowMs: 0, store: storeToken, inFlight: { kind: "retry", status: 409 } } },
      "SHIP_WEBHOOK_IDEMPOTENCY_INVALID",
    ],
    [
      "key",
      {
        idempotency: {
          windowMs: 1,
          store: storeToken,
          key: 5,
          inFlight: { kind: "retry", status: 409 },
        },
      },
      "SHIP_WEBHOOK_IDEMPOTENCY_INVALID",
    ],
    [
      "in-flight",
      { idempotency: { windowMs: 1, store: storeToken, inFlight: { kind: "retry", status: 200 } } },
      "SHIP_WEBHOOK_IN_FLIGHT_POLICY_INVALID",
    ],
    [
      "wait",
      { idempotency: { windowMs: 1, store: storeToken, inFlight: { kind: "wait", maxMs: 0 } } },
      "SHIP_WEBHOOK_IN_FLIGHT_POLICY_INVALID",
    ],
    ["retention", { retention: { eventsMs: 1 } }, "SHIP_WEBHOOK_RETENTION_INVALID"],
    ["handler", { handler: undefined }, "SHIP_WEBHOOK_HANDLER_INVALID"],
    [
      "effects in transaction",
      { transaction: "write", dependencies: { notifier, tx: unitOfWork }, effects: [notifier] },
      "SHIP_WEBHOOK_EFFECT_TRANSACTION_FORBIDDEN",
    ],
    ["response mode", { response: { mode: "xml" } }, "SHIP_WEBHOOK_RESPONSE_INVALID"],
    // Streaming is an HTTP-operation representation (ADR-0016); a webhook
    // acknowledgement is always a settled document or nothing.
    ["stream response mode", { response: { mode: "stream" } }, "SHIP_WEBHOOK_RESPONSE_INVALID"],
    // ADR-0019 read caching never applies to a webhook acknowledgement: each
    // delivery is a distinct event settled by verification and idempotency.
    ["read cache", { cache: { ttlMs: 60_000, scope: "public" } }, "SHIP_WEBHOOK_CACHE_FORBIDDEN"],
    ["response shape", { response: "text" }, "SHIP_WEBHOOK_RESPONSE_INVALID"],
    [
      "text response without a content type",
      { response: { mode: "text" }, output: undefined },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
    [
      "binary response without a content type",
      { response: { mode: "binary" }, output: undefined },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
    [
      "text response with a malformed content type",
      { response: { mode: "text", contentType: "xml" }, output: undefined },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
    [
      "json response with a content type",
      { response: { mode: "json", contentType: "text/xml" } },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
    [
      "text response with a consumer output schema",
      { response: { mode: "text", contentType: "text/xml" } },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
    [
      "text response with a bodiless status",
      {
        response: { mode: "text", contentType: "text/xml" },
        output: undefined,
        successStatus: 204,
      },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
    [
      "empty response with a non-2xx status",
      { response: { mode: "empty" }, output: undefined, successStatus: 404 },
      "SHIP_WEBHOOK_RESPONSE_INVALID",
    ],
  ])("rejects an invalid %s", (_label, overrides, code) => {
    expect(() =>
      overrides === null ? defineWebhook(null as never) : inline(overrides as never),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("rejects enqueue declarations with unknown intents, missing retention or invalid tokens", () => {
    const outbox = defineOutbox({
      id: "ingress.outbox",
      intents: { process: webhookIntent({ effect: notifier, perform: async () => undefined }) },
    });
    const enqueue = (receive: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      defineWebhook({
        id: "ingress.fixture-webhook",
        ...baseDefinition,
        retention: { eventsMs: 1000, claimsMs: 1000 },
        receive: {
          mode: "enqueue",
          outbox,
          intent: "process",
          store: eventsToken,
          unitOfWork,
          ...receive,
        },
        ...extra,
      } as never);
    expect(() => enqueue({ intent: "missing" })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_OUTBOX_INTENT_UNKNOWN" }),
    );
    // Durable receipt is a write; a read cache on it is rejected like on inline webhooks.
    expect(() => enqueue({}, { cache: { ttlMs: 60_000, scope: "public" } })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_CACHE_FORBIDDEN", field: "cache" }),
    );
    expect(() => enqueue({ mode: "later" })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_RECEIVE_INVALID" }),
    );
    expect(() => enqueue({ outbox: {} })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_RECEIVE_INVALID" }),
    );
    expect(() => enqueue({ store: storeToken })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_RECEIVE_INVALID", field: "receive.store" }),
    );
    expect(() => enqueue({ unitOfWork: eventsToken })).toThrow(
      expect.objectContaining({
        code: "SHIP_WEBHOOK_RECEIVE_INVALID",
        field: "receive.unitOfWork",
      }),
    );
    expect(() => enqueue({ handler: () => undefined })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_RECEIVE_INVALID", field: "handler" }),
    );
    expect(() => enqueue({}, { retention: undefined })).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_RETENTION_REQUIRED" }),
    );
  });
});

describe("inline webhooks", () => {
  const rejected = operationError({ code: "EVENT_REJECTED", status: 422, message: "Rejected" });
  const handler = vi.fn(async ({ event }: { event: { verified: { eventId?: string } } }) => {
    if (event.verified.eventId === "evt_bad") throw operationFailure(rejected);
    return { ok: true, eventId: event.verified.eventId ?? "digest" };
  });
  const webhook = defineWebhook({
    id: "ingress.fixture-webhook",
    ...baseDefinition,
    output: { 200: z.object({ ok: z.boolean(), eventId: z.string() }) },
    successStatus: 200,
    errors: [rejected],
    transaction: "none",
    dependencies: {},
    handler,
  });
  const store = fakeIdempotencyStore();
  const app = defineApp({
    id: "webhooks-test",
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
  const executor = createExecutor(app);
  const actor = providerActor({ id: "fixture:evt_1", provider: "fixture" });

  it("compiles to a raw-body POST operation with provider access and webhook metadata", () => {
    expect(isWebhook(webhook)).toBe(true);
    expect(webhook.mode).toBe("inline");
    expect(webhook.body.mediaTypes).toEqual(["application/json"]);
    expect(webhook.operation.access).toEqual({ kind: "provider", provider: "fixture" });
    expect(webhook.operation.transport).toMatchObject({
      kind: "http",
      binding: "POST /webhooks/fixture",
      metadata: {
        method: "POST",
        path: "/webhooks/fixture",
        response: "json",
        requestBody: { mode: "raw", maxBytes: 1024, contentTypes: ["application/json"] },
        webhook: {
          id: "ingress.fixture-webhook",
          provider: "fixture",
          verifier: "fixture",
          guarantees: { signature: true, freshness: false, replay: false },
          mode: "inline",
          idempotency: { windowMs: 60_000, inFlight: { kind: "retry", status: 409 } },
        },
      },
    });
    expect(describeWebhookOperation(webhook.operation)).toEqual({ role: "receive", webhook });
    expect(Object.keys(webhook.operation.input).sort()).toEqual(["body", "headers", "verified"]);
    const node = app.graph.operations.find((operation) => operation.id === webhook.id);
    expect(node?.transport?.metadata?.webhook).toMatchObject({ provider: "fixture" });
    expect(node?.access).toEqual({ kind: "provider", provider: "fixture" });
    expect(node?.idempotency).toEqual({ windowMs: 60_000, storeId: "platform.idempotency" });
  });

  it("runs the handler with the receipt, keys idempotency by event id, and replays duplicates", async () => {
    const input = receipt({ eventId: "evt_1" });
    const first = await executor.run(webhook.id, input, { actor, requestId: "r1" });
    expect(first).toMatchObject({ ok: true, status: 200, data: { ok: true, eventId: "evt_1" } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      event: { headers: input.headers, rawBody: input.body, verified: { eventId: "evt_1" } },
      context: { actor },
    });
    expect([...store.entries.keys()]).toEqual(["ingress.fixture-webhook:evt_1"]);

    const replay = await executor.run(webhook.id, input, { actor, requestId: "r2" });
    expect(replay).toMatchObject({ ok: true, status: 200, replayed: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("falls back to the body digest when no event id is verified", async () => {
    await executor.run(webhook.id, receipt(), { actor, requestId: "r3" });
    expect(store.entries.has(`ingress.fixture-webhook:${DIGEST}`)).toBe(true);
  });

  it("rejects non-provider actors and other providers before the handler", async () => {
    const human = await executor.run(webhook.id, receipt({ eventId: "evt_2" }), {
      actor: humanActor({ id: "person" }),
    });
    expect(human).toMatchObject({ ok: false, status: 403 });
    const other = await executor.run(webhook.id, receipt({ eventId: "evt_2" }), {
      actor: providerActor({ id: "x", provider: "other" }),
    });
    expect(other).toMatchObject({
      ok: false,
      status: 403,
      error: { details: { requiredActorKind: "provider" } },
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases the claim when the handler raises a declared failure", async () => {
    const result = await executor.run(webhook.id, receipt({ eventId: "evt_bad" }), { actor });
    expect(result).toMatchObject({ ok: false, status: 422, error: { code: "EVENT_REJECTED" } });
    expect(store.entries.has("ingress.fixture-webhook:evt_bad")).toBe(false);
  });

  it("supports a custom key and wait policy", () => {
    const custom = defineWebhook({
      id: "ingress.custom-webhook",
      ...baseDefinition,
      idempotency: {
        key: ({ headers }) => headers["x-delivery"] ?? "none",
        windowMs: 10,
        store: storeToken,
        inFlight: { kind: "wait", maxMs: 500 },
      },
      output: { 204: z.undefined() },
      successStatus: 204,
      transaction: "none",
      dependencies: {},
      handler: () => undefined,
    });
    expect(custom.idempotency.inFlight).toEqual({ kind: "wait", maxMs: 500 });
    expect(
      custom.operation.idempotency?.key({
        headers: { "x-delivery": "d1" },
        body: new Uint8Array(),
        verified: { bodyDigest: DIGEST },
      }),
    ).toBe("d1");
  });
});

describe("enqueue webhooks", () => {
  const dispatched = vi.fn(async (_eventId: string) => undefined);
  const observer = { dispatched: vi.fn(), received: vi.fn() };
  const clock = { now: new Date("2026-09-18T10:00:00.000Z") };
  const outbox = defineOutbox({
    id: "ingress.outbox",
    retention: { completedMs: 1, deadLetteredMs: 1 },
    intents: {
      process: webhookIntent({
        effect: notifier,
        observer,
        clock: () => clock.now,
        perform: ({ effect, event }) => effect.send(event.eventId),
      }),
    },
  });
  const webhook = defineWebhook({
    id: "ingress.fixture-webhook",
    ...baseDefinition,
    retention: { eventsMs: 1_000, claimsMs: 2_000 },
    receive: { mode: "enqueue", outbox, intent: "process", store: eventsToken, unitOfWork },
  });
  const replay = defineWebhookReplay({
    id: "ingress.webhook-replay",
    webhooks: [webhook],
    unitOfWork,
    store: eventsToken,
  });
  const cleanup = defineWebhookCleanup({
    id: "ingress.webhook-cleanup",
    webhooks: [webhook],
    store: eventsToken,
    clock: () => clock.now,
  });
  const dispatcher = defineOutboxDispatcher(outbox, {
    batchSize: 10,
    lease: { ms: 1000 },
    retry: { attempts: 1, backoff: { initialMs: 1 } },
    deadLetter: true,
  });
  const idempotency = fakeIdempotencyStore();
  const events = fakeEventStore();
  const backend = fakeOutbox("ingress.outbox");
  const app = defineApp({
    id: "webhooks-test",
    modules: [
      defineModule({
        id: "ingress",
        operations: [webhook.operation, replay, cleanup, ...dispatcher.operations],
        providers: [
          valueProvider(storeToken, idempotency),
          valueProvider(eventsToken, events),
          valueProvider(unitOfWork, fakeUnitOfWork()),
          valueProvider(outbox.writer, backend),
          valueProvider(notifier, { send: dispatched }),
        ],
        imports: [],
        exports: [],
      }),
    ],
  });
  const executor = createExecutor(app);
  const actor = providerActor({ id: "fixture:evt_1", provider: "fixture" });

  it("declares a write transaction, outbox writer and event store with 202 acknowledgement", () => {
    expect(webhook.mode).toBe("enqueue");
    expect(webhook.operation.transaction).toBe("write");
    expect(webhook.operation.successStatus).toBe(202);
    expect(webhook.operation.transport.metadata.webhook).toMatchObject({
      mode: "enqueue",
      retention: { eventsMs: 1_000, claimsMs: 2_000 },
      outbox: { id: "ingress.outbox", intent: "process" },
    });
    expect(describeWebhookOperation(replay)).toEqual({
      role: "replay",
      webhookIds: ["ingress.fixture-webhook"],
    });
    expect(describeWebhookOperation(cleanup)).toEqual({
      role: "cleanup",
      webhookIds: ["ingress.fixture-webhook"],
    });
    expect(replay.access).toEqual({
      kind: "permissions",
      mode: "all",
      permissions: [WEBHOOK_REPLAY_PERMISSION],
    });
    expect(app.graph.operations.find((node) => node.id === webhook.id)?.outbox).toEqual([
      { id: "ingress.outbox", role: "writer" },
    ]);
  });

  it("persists the redacted raw event and one intent in the transaction scope, then acknowledges", async () => {
    const input = receipt({ eventId: "evt_1" });
    const result = await executor.run(webhook.id, input, { actor, requestId: "req-1" });
    expect(result).toMatchObject({ ok: true, status: 202, data: { accepted: true } });
    const eventId = (result as { data: { eventId: string } }).data.eventId;
    const stored = events.events.get(eventId);
    expect(stored).toMatchObject({
      webhookId: "ingress.fixture-webhook",
      provider: "fixture",
      providerEventId: "evt_1",
      requestId: "req-1",
      contentType: "application/json",
      headers: { "content-type": "application/json" },
      outboxRecordId: "ingress.outbox:1",
    });
    expect(stored?.headers).not.toHaveProperty("x-fixture-signature");
    expect(stored?.body).toBe(input.body);
    expect(events.calls).toEqual(["record:tx", "link:tx"]);
    expect(backend.rows).toMatchObject([
      {
        intentId: "process",
        dedupeKey: eventId,
        payload: { eventId, webhookId: "ingress.fixture-webhook", provider: "fixture" },
      },
    ]);
    expect(dispatched).not.toHaveBeenCalled();

    const duplicate = await executor.run(webhook.id, input, { actor, requestId: "req-2" });
    expect(duplicate).toMatchObject({ ok: true, status: 202, replayed: true, data: { eventId } });
    expect(events.events.size).toBe(1);
  });

  it("dispatches the intent with the event reference and reports receive-to-dispatch lag", async () => {
    const stored = [...events.events.values()][0]!;
    clock.now = new Date(stored.receivedAt.getTime() + 1_500);
    const result = await executor.run(
      "ingress.outbox.dispatch",
      {},
      { actor: systemActor({ id: "runner" }) },
    );
    expect(result).toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(dispatched).toHaveBeenCalledWith(stored.id);
    expect(observer.dispatched).toHaveBeenCalledWith({
      webhookId: "ingress.fixture-webhook",
      provider: "fixture",
      lagMs: 1_500,
    });
  });

  it("re-enqueues a stored event through the permission-gated replay operation", async () => {
    const stored = [...events.events.values()][0]!;
    const denied = await executor.run(
      "ingress.webhook-replay",
      { body: { eventId: stored.id } },
      { actor: humanActor({ id: "ops" }) },
    );
    expect(denied).toMatchObject({ ok: false, status: 403 });
    const missing = await executor.run(
      "ingress.webhook-replay",
      { body: { eventId: "nope" } },
      { actor: humanActor({ id: "ops", permissions: [WEBHOOK_REPLAY_PERMISSION] }) },
    );
    expect(missing).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "WEBHOOK_EVENT_NOT_FOUND" },
    });
    const replayed = await executor.run(
      "ingress.webhook-replay",
      { body: { eventId: stored.id } },
      { actor: humanActor({ id: "ops", permissions: [WEBHOOK_REPLAY_PERMISSION] }) },
    );
    expect(replayed).toMatchObject({
      ok: true,
      data: { eventId: stored.id, webhookId: "ingress.fixture-webhook", queued: true },
    });
    expect(backend.rows).toHaveLength(2);
    expect(events.events.get(stored.id)?.outboxRecordId).toBe("ingress.outbox:2");
  });

  it("cleans up events and claims past retention through the system-only operation", async () => {
    const denied = await executor.run("ingress.webhook-cleanup", {}, { actor });
    expect(denied).toMatchObject({ ok: false, status: 403 });
    clock.now = new Date(clock.now.getTime() + 10_000);
    const result = await executor.run(
      "ingress.webhook-cleanup",
      {},
      { actor: systemActor({ id: "runner" }) },
    );
    expect(result).toMatchObject({ ok: true, data: { eventsDeleted: 1, claimsDeleted: 2 } });
    expect(events.calls.at(-1)).toBe("cleanup:ingress.fixture-webhook:ingress.fixture-webhook:");
  });

  it("fails clearly when the event store token resolves to something else", async () => {
    const broken = createExecutor(
      defineApp({
        id: "broken",
        modules: [
          defineModule({
            id: "ingress",
            operations: [webhook.operation, ...dispatcher.operations],
            providers: [
              valueProvider(storeToken, fakeIdempotencyStore()),
              valueProvider(eventsToken, {} as never),
              valueProvider(unitOfWork, fakeUnitOfWork()),
              valueProvider(outbox.writer, fakeOutbox("ingress.outbox")),
              valueProvider(notifier, { send: dispatched }),
            ],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );
    await expect(broken.run(webhook.id, receipt({ eventId: "evt_9" }), { actor })).rejects.toThrow(
      OperationExecutionError,
    );
  });

  it("rejects replay and cleanup declarations that are not built from enqueue webhooks", () => {
    const inline = defineWebhook({
      id: "ingress.inline-webhook",
      ...baseDefinition,
      output: { 200: z.object({}) },
      successStatus: 200,
      transaction: "none",
      dependencies: {},
      handler: () => ({}),
    });
    expect(() =>
      defineWebhookReplay({
        id: "ingress.replay",
        webhooks: [inline],
        unitOfWork,
        store: eventsToken,
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_OPERATIONS_INVALID" }));
    expect(() =>
      defineWebhookReplay({ id: "ingress.replay", webhooks: [], unitOfWork, store: eventsToken }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_OPERATIONS_INVALID" }));
    // Replay re-dispatches a stored event inside a write transaction; ADR-0019
    // caching never applies, so the declaration is a diagnostic, not a no-op.
    expect(() =>
      defineWebhookReplay({
        id: "ingress.replay",
        webhooks: [webhook],
        unitOfWork,
        store: eventsToken,
        cache: { ttlMs: 60_000, scope: "public" },
      } as never),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_CACHE_FORBIDDEN", field: "cache" }));
    expect(() =>
      defineWebhookReplay({
        id: "ingress.replay",
        webhooks: [webhook],
        unitOfWork: eventsToken as never,
        store: eventsToken,
      }),
    ).toThrow(expect.objectContaining({ field: "unitOfWork" }));
    expect(() =>
      defineWebhookReplay({
        id: "ingress.replay",
        webhooks: [webhook],
        unitOfWork,
        store: {} as never,
      }),
    ).toThrow(expect.objectContaining({ field: "store" }));
    expect(() =>
      defineWebhookReplay({ id: "replay", webhooks: [webhook], unitOfWork, store: eventsToken }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_ID_INVALID" }));
    expect(() =>
      defineWebhookCleanup({ id: "ingress.cleanup", webhooks: [inline], store: eventsToken }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_RETENTION_REQUIRED" }));
    expect(() =>
      defineWebhookCleanup({ id: "ingress.cleanup", webhooks: [], store: eventsToken }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_OPERATIONS_INVALID" }));
    expect(() =>
      defineWebhookCleanup({ id: "ingress.cleanup", webhooks: [webhook], store: 1 as never }),
    ).toThrow(expect.objectContaining({ field: "store" }));
    expect(() => webhookIntent({ effect: notifier } as never)).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_HANDLER_INVALID" }),
    );
  });

  it("names replay outbox bindings without colliding with reserved names", () => {
    const txOutbox = defineOutbox({
      id: "tx",
      intents: { process: webhookIntent({ effect: notifier, perform: async () => undefined }) },
    });
    const other = defineWebhook({
      id: "ingress.other-webhook",
      ...baseDefinition,
      path: "/webhooks/other",
      retention: { eventsMs: 1, claimsMs: 1 },
      receive: {
        mode: "enqueue",
        outbox: txOutbox,
        intent: "process",
        store: eventsToken,
        unitOfWork,
      },
    });
    const operation = defineWebhookReplay({
      id: "ingress.replay",
      webhooks: [webhook, other],
      unitOfWork,
      store: eventsToken,
    });
    expect(Object.keys(operation.dependencies).sort()).toEqual([
      "events",
      "ingressOutbox",
      "tx",
      "txOutbox",
    ]);
  });

  it("requires the application to provide the store, unit of work and dispatcher", () => {
    expect(() =>
      defineApp({
        id: "incomplete",
        modules: [
          defineModule({
            id: "ingress",
            operations: [webhook.operation],
            providers: [valueProvider(storeToken, idempotency)],
            imports: [],
            exports: [],
          }),
        ],
      }),
    ).toThrow(ApplicationCompilationError);
  });
});

describe("webhook response modes", () => {
  const twiml = "<Response><Say>Thanks</Say></Response>";
  const document = defineWebhook({
    id: "ingress.voice-webhook",
    ...baseDefinition,
    path: "/webhooks/voice",
    response: { mode: "text", contentType: "text/xml" },
    transaction: "none",
    dependencies: {},
    handler: ({ event }) =>
      event.verified.eventId === "evt_explicit"
        ? respond(200, twiml, { headers: { "x-voice-step": "gather" } })
        : twiml,
  });
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const image = defineWebhook({
    id: "ingress.image-webhook",
    ...baseDefinition,
    path: "/webhooks/image",
    response: { mode: "binary", contentType: "image/png" },
    successStatus: 201,
    transaction: "none",
    dependencies: {},
    handler: () => bytes,
  });
  const status = defineWebhook({
    id: "ingress.status-webhook",
    ...baseDefinition,
    path: "/webhooks/status",
    response: { mode: "empty" },
    transaction: "none",
    dependencies: {},
    handler: ({ event }) => {
      if (event.verified.eventId === "evt_body") return { leaked: true } as never;
      if (event.verified.eventId === "evt_explicit") return respond(200, undefined);
      return undefined;
    },
  });
  const noContent = defineWebhook({
    id: "ingress.no-content-webhook",
    ...baseDefinition,
    path: "/webhooks/no-content",
    response: { mode: "empty" },
    successStatus: 204,
    transaction: "none",
    dependencies: {},
    handler: () => {},
  });
  const app = defineApp({
    id: "webhooks-test",
    modules: [
      defineModule({
        id: "ingress",
        operations: [document.operation, image.operation, status.operation, noContent.operation],
        providers: [valueProvider(storeToken, fakeIdempotencyStore())],
        imports: [],
        exports: [],
      }),
    ],
  });
  const executor = createExecutor(app);
  const actor = providerActor({ id: "fixture:evt_1", provider: "fixture" });

  it("defaults to a JSON acknowledgement and projects the declared mode into the transport", () => {
    const json = defineWebhook({
      id: "ingress.json-webhook",
      ...baseDefinition,
      output: { 200: z.object({ ok: z.boolean() }) },
      successStatus: 200,
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true }),
    });
    expect(json.response).toEqual({ mode: "json" });
    expect(json.operation.transport?.metadata).toMatchObject({
      response: "json",
      contentType: "application/json; charset=UTF-8",
      webhook: { response: { mode: "json" } },
    });
    expect(document.response).toEqual({ mode: "text", contentType: "text/xml" });
    expect(document.operation.transport?.metadata).toMatchObject({
      response: "text",
      contentType: "text/xml",
      webhook: { response: { mode: "text", contentType: "text/xml" } },
    });
    expect(image.operation.transport?.metadata).toMatchObject({
      response: "binary",
      contentType: "image/png",
    });
    expect(image.operation.successStatus).toBe(201);
    expect(status.operation.transport?.metadata).toMatchObject({
      response: "empty",
      webhook: { response: { mode: "empty" } },
    });
    expect(status.operation.transport?.metadata).not.toHaveProperty("contentType");
    expect(document.operation.successStatus).toBe(200);
    for (const webhook of [json, document, image, status, noContent]) {
      expect(isWebhookTransport(webhook.operation.transport)).toBe(true);
    }
    expect(isWebhookTransport({ kind: "http", binding: "POST /x", metadata: {} })).toBe(false);
    const node = app.graph.operations.find((operation) => operation.id === document.id);
    expect(node?.transport?.metadata).toMatchObject({ response: "text", contentType: "text/xml" });
  });

  it("returns the text document as the operation data, directly or through respond()", async () => {
    const plain = await executor.run("ingress.voice-webhook", receipt({ eventId: "evt_1" }), {
      actor,
    });
    expect(plain).toMatchObject({ ok: true, status: 200, data: twiml });
    const explicit = await executor.run(
      "ingress.voice-webhook",
      receipt({ eventId: "evt_explicit" }),
      { actor },
    );
    expect(explicit).toMatchObject({
      ok: true,
      status: 200,
      data: twiml,
      headers: { "x-voice-step": "gather" },
    });
  });

  it("returns bytes for binary mode and validates the framework-owned schema", async () => {
    const result = await executor.run("ingress.image-webhook", receipt({ eventId: "evt_1" }), {
      actor,
    });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect((result as { data: unknown }).data).toBe(bytes);
  });

  it("answers empty mode with no data and rejects a handler that returns a body", async () => {
    const accepted = await executor.run("ingress.status-webhook", receipt({ eventId: "evt_1" }), {
      actor,
    });
    expect(accepted).toMatchObject({ ok: true, status: 200 });
    expect((accepted as { data: unknown }).data).toBeUndefined();
    const explicit = await executor.run(
      "ingress.status-webhook",
      receipt({ eventId: "evt_explicit" }),
      { actor },
    );
    expect(explicit).toMatchObject({ ok: true, status: 200 });
    const noBody = await executor.run("ingress.no-content-webhook", receipt({ eventId: "evt_1" }), {
      actor,
    });
    expect(noBody).toMatchObject({ ok: true, status: 204 });
    await expect(
      executor.run("ingress.status-webhook", receipt({ eventId: "evt_body" }), { actor }),
    ).rejects.toMatchObject({
      name: "OperationExecutionError",
      code: "SHIP_OPERATION_OUTPUT_INVALID",
      issues: [
        expect.objectContaining({ message: expect.stringContaining("response mode is empty") }),
      ],
    });
  });

  it("keeps enqueue webhooks on the JSON 202 acknowledgement", () => {
    const outbox = defineOutbox({
      id: "ingress.outbox",
      intents: {
        process: webhookIntent({
          effect: notifier,
          perform: ({ effect, event }) => effect.send(event.eventId),
        }),
      },
    });
    expect(() =>
      defineWebhook({
        id: "ingress.fixture-webhook",
        ...baseDefinition,
        retention: { eventsMs: 1, claimsMs: 1 },
        response: { mode: "empty" },
        receive: { mode: "enqueue", outbox, intent: "process", store: eventsToken, unitOfWork },
      } as never),
    ).toThrow(
      expect.objectContaining({ code: "SHIP_WEBHOOK_RESPONSE_INVALID", field: "response" }),
    );
  });
});

describe("webhook replay transport", () => {
  const outbox = defineOutbox({
    id: "ingress.outbox",
    retention: { completedMs: 1, deadLetteredMs: 1 },
    intents: {
      process: webhookIntent({
        effect: notifier,
        perform: ({ effect, event }) => effect.send(event.eventId),
      }),
    },
  });
  const webhook = defineWebhook({
    id: "ingress.fixture-webhook",
    ...baseDefinition,
    retention: { eventsMs: 1_000, claimsMs: 2_000 },
    receive: { mode: "enqueue", outbox, intent: "process", store: eventsToken, unitOfWork },
  });
  const byParams = defineWebhookReplay({
    id: "ingress.webhook-replay",
    webhooks: [webhook],
    unitOfWork,
    store: eventsToken,
    transport: { path: "/webhooks/:eventId/replay" },
  });
  const byBody = defineWebhookReplay({
    id: "ingress.webhook-replay-body",
    webhooks: [webhook],
    unitOfWork,
    store: eventsToken,
    transport: {
      kind: "http",
      binding: "POST /webhooks/replay",
      metadata: {
        method: "POST",
        path: "/webhooks/replay",
        response: "json",
        contentType: "application/json; charset=UTF-8",
        requestBody: { mode: "json" },
      },
    },
  });
  const events = fakeEventStore();
  const backend = fakeOutbox("ingress.outbox");
  const dispatcher = defineOutboxDispatcher(outbox, {
    batchSize: 10,
    lease: { ms: 1000 },
    retry: { attempts: 1, backoff: { initialMs: 1 } },
    deadLetter: true,
  });
  const app = defineApp({
    id: "webhooks-test",
    modules: [
      defineModule({
        id: "ingress",
        operations: [webhook.operation, byParams, byBody, ...dispatcher.operations],
        providers: [
          valueProvider(storeToken, fakeIdempotencyStore()),
          valueProvider(eventsToken, events),
          valueProvider(unitOfWork, fakeUnitOfWork()),
          valueProvider(outbox.writer, backend),
          valueProvider(notifier, { send: async () => undefined }),
        ],
        imports: [],
        exports: [],
      }),
    ],
  });
  const executor = createExecutor(app);

  it("compiles a JSON POST transport whose :eventId parameter or body carries the event id", () => {
    expect(byParams.transport).toEqual({
      kind: "http",
      binding: "POST /webhooks/:eventId/replay",
      metadata: {
        method: "POST",
        path: "/webhooks/:eventId/replay",
        response: "json",
        contentType: "application/json; charset=UTF-8",
        requestBody: { mode: "json" },
      },
    });
    expect(Object.keys(byParams.input)).toEqual(["params"]);
    expect(Object.keys(byBody.input)).toEqual(["body"]);
    expect(byBody.transport?.binding).toBe("POST /webhooks/replay");
    expect(describeWebhookOperation(byParams)).toEqual({
      role: "replay",
      webhookIds: ["ingress.fixture-webhook"],
    });
    expect(byParams.access).toEqual({
      kind: "permissions",
      mode: "all",
      permissions: [WEBHOOK_REPLAY_PERMISSION],
    });
    const node = app.graph.operations.find((operation) => operation.id === byParams.id);
    expect(node?.transport?.binding).toBe("POST /webhooks/:eventId/replay");
  });

  it("re-enqueues through either input shape under the same permission gate", async () => {
    const actor = providerActor({ id: "fixture:evt_1", provider: "fixture" });
    await executor.run("ingress.fixture-webhook", receipt({ eventId: "evt_1" }), { actor });
    const stored = [...events.events.values()][0]!;
    const ops = humanActor({ id: "ops", permissions: [WEBHOOK_REPLAY_PERMISSION] });
    expect(
      await executor.run(
        "ingress.webhook-replay",
        { params: { eventId: stored.id } },
        { actor: humanActor({ id: "nobody" }) },
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await executor.run(
        "ingress.webhook-replay",
        { params: { eventId: stored.id } },
        { actor: ops },
      ),
    ).toMatchObject({ ok: true, data: { eventId: stored.id, queued: true } });
    expect(
      await executor.run(
        "ingress.webhook-replay-body",
        { body: { eventId: stored.id } },
        { actor: ops },
      ),
    ).toMatchObject({ ok: true, data: { eventId: stored.id, queued: true } });
    expect(
      await executor.run("ingress.webhook-replay", { params: { eventId: "nope" } }, { actor: ops }),
    ).toMatchObject({ ok: false, status: 404, error: { code: "WEBHOOK_EVENT_NOT_FOUND" } });
    expect(backend.rows).toHaveLength(3);
  });

  it("carries the event id in any single path parameter, by detection or by name", async () => {
    const legacy = defineWebhookReplay({
      id: "ingress.webhook-replay-legacy",
      webhooks: [webhook],
      unitOfWork,
      store: eventsToken,
      transport: { path: "/webhooks/:id/retry" },
    });
    const named = defineWebhookReplay({
      id: "ingress.webhook-replay-named",
      webhooks: [webhook],
      unitOfWork,
      store: eventsToken,
      transport: { path: "/hooks/:deliveryId", eventIdParameter: "deliveryId" },
    });
    expect(legacy.transport.binding).toBe("POST /webhooks/:id/retry");
    expect(Object.keys(legacy.input)).toEqual(["params"]);
    expect(named.transport.binding).toBe("POST /hooks/:deliveryId");
    const legacyEvents = fakeEventStore();
    const legacyApp = defineApp({
      id: "webhooks-legacy",
      modules: [
        defineModule({
          id: "ingress",
          operations: [webhook.operation, legacy, named, ...dispatcher.operations],
          providers: [
            valueProvider(storeToken, fakeIdempotencyStore()),
            valueProvider(eventsToken, legacyEvents),
            valueProvider(unitOfWork, fakeUnitOfWork()),
            valueProvider(outbox.writer, fakeOutbox("ingress.outbox")),
            valueProvider(notifier, { send: async () => undefined }),
          ],
          imports: [],
          exports: [],
        }),
      ],
    });
    const legacyExecutor = createExecutor(legacyApp);
    const actor = providerActor({ id: "fixture:evt_9", provider: "fixture" });
    await legacyExecutor.run("ingress.fixture-webhook", receipt({ eventId: "evt_9" }), { actor });
    const stored = [...legacyEvents.events.values()][0]!;
    const ops = humanActor({ id: "ops", permissions: [WEBHOOK_REPLAY_PERMISSION] });
    expect(
      await legacyExecutor.run(
        "ingress.webhook-replay-legacy",
        { params: { id: stored.id } },
        { actor: ops },
      ),
    ).toMatchObject({ ok: true, data: { eventId: stored.id, queued: true } });
    expect(
      await legacyExecutor.run(
        "ingress.webhook-replay-named",
        { params: { deliveryId: stored.id } },
        { actor: ops },
      ),
    ).toMatchObject({ ok: true, data: { eventId: stored.id } });
    expect(
      await legacyExecutor.run(
        "ingress.webhook-replay-legacy",
        { params: { eventId: stored.id } } as never,
        { actor: ops },
      ),
    ).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_ERROR" } });
  });

  it.each([
    ["a non-object", "nope"],
    ["a relative path", { path: "webhooks/replay" }],
    ["two parameters", { path: "/webhooks/:id/:eventId" }],
    ["two event parameters", { path: "/webhooks/:eventId/:eventId" }],
    ["a malformed parameter", { path: "/webhooks/:9id/retry" }],
    [
      "a named parameter the path does not declare",
      { path: "/webhooks/replay", eventIdParameter: "id" },
    ],
    [
      "a named parameter that differs from the path",
      { path: "/webhooks/:id/retry", eventIdParameter: "eventId" },
    ],
    [
      "a non-identifier parameter name",
      { path: "/webhooks/:id/retry", eventIdParameter: "not valid" },
    ],
    [
      "a GET transport",
      { kind: "http", binding: "GET /x", metadata: { method: "GET", path: "/x" } },
    ],
    [
      "a raw-body transport",
      {
        kind: "http",
        binding: "POST /x",
        metadata: {
          method: "POST",
          path: "/x",
          response: "json",
          contentType: "application/json",
          requestBody: { mode: "raw", maxBytes: 1, contentTypes: ["a/b"] },
        },
      },
    ],
    ["a non-http transport", { kind: "queue", binding: "x", metadata: { path: "/x" } }],
  ])("rejects %s as a replay transport", (_label, transport) => {
    expect(() =>
      defineWebhookReplay({
        id: "ingress.webhook-replay",
        webhooks: [webhook],
        unitOfWork,
        store: eventsToken,
        transport: transport as never,
      }),
    ).toThrow(expect.objectContaining({ code: "SHIP_WEBHOOK_TRANSPORT_INVALID" }));
  });
});

describe("helpers", () => {
  it("redacts sensitive headers case-insensitively", () => {
    expect(
      redactHeaders(
        { Authorization: "x", "x-sig": "y", accept: "z" },
        new Set(["authorization", "x-sig"]),
      ),
    ).toEqual({ accept: "z" });
  });

  it("recognises event stores structurally", () => {
    expect(isWebhookEventStore(fakeEventStore())).toBe(true);
    expect(isWebhookEventStore({ kind: "ship.webhook-event-store" })).toBe(false);
    expect(webhookEventStoreDependency("a.b")).toEqual({ kind: "ship.dependency", id: "a.b" });
    expect(isWebhook({ kind: "ship.webhook" })).toBe(false);
  });

  it("tolerates intents with unparsable receivedAt by skipping lag reporting", async () => {
    const observer = { dispatched: vi.fn() };
    const intent = webhookIntent({ effect: notifier, observer, perform: async () => undefined });
    await intent.perform({
      effect: { send: async () => undefined },
      payload: { eventId: "e", webhookId: "w", provider: "p", receivedAt: "not-a-date" },
      record: {} as never,
      context: { requestId: "r" },
    });
    expect(observer.dispatched).not.toHaveBeenCalled();
    expect(outboxIntent).toBeTypeOf("function");
    expect(dependency).toBeTypeOf("function");
  });
});

// Keep the exported surface referenced so unused-import lint does not fire for shared fixtures.
void ((_: AnyWebhook) => _);
