import { projectClientContract } from "@sixthsummit/ship-contract/project";
import {
  cacheInvalidationOutbox,
  collectJobs,
  createExecutor,
  defineRealtimePublicationOutbox,
  operationActor,
  providerActor,
  REALTIME_PUBLICATION_OUTBOX_ID,
  systemActor,
  type TenantScope,
  type UnitOfWork,
  webhookSecret,
} from "@sixthsummit/ship-core";
import { defineStoragePurgeOutbox, STORAGE_PURGE_OUTBOX_ID } from "@sixthsummit/ship-storage";
import {
  collectPublishes,
  createInMemoryAttachmentLedger,
  createInMemoryIdempotencyStore,
  createInMemoryJobBackend,
  createInMemoryLockProvider,
  createInMemoryOutbox,
  createInMemoryRealtimeBackend,
  createInMemoryStorageAdapter,
  createInMemoryWebhookEventStore,
  drainOutbox,
  drainRealtimePublications,
  runJobOnce,
} from "@sixthsummit/ship-testing";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import { describe, expect, it, vi } from "vitest";
import {
  type CustomizedInfrastructure,
  createCustomizedApplication,
  DISPATCH_BATCH_SIZE,
  DISPATCH_ROUNDS_PER_SECOND,
  PORTFOLIO_SUMMARY_TAG,
  projectActivity,
  publishedChannels,
} from "./application.js";
import { createLegacyBridge } from "./bridge.js";
import type { ReportNotifier } from "./effects.js";
import {
  paymentsOutbox as paymentsOutboxDefinition,
  REPORTS_EXPECTED_RATE_PER_SECOND,
  reportsOutbox,
} from "./outbox.js";
import type { PortfolioCapabilities } from "./repository.js";
import { INBOUND_SMS_TWIML } from "./webhooks.js";

function fixtureUnitOfWork(
  summarize = vi.fn(async () => []),
  recordReportRequest = vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
): UnitOfWork<PortfolioCapabilities> {
  return {
    kind: "ship.unit-of-work",
    id: "database.portfolio",
    run: async (_mode, work) =>
      work({
        portfolio: {
          kind: "ship.drizzle.tenant-repository",
          id: "portfolio.projects",
          forTenant: (_scope: TenantScope<string>) => ({ summarize, recordReportRequest }),
        },
      }),
  };
}

function fixtureNotifier(send = vi.fn(async () => undefined)): ReportNotifier {
  return { adapter: "fixture", send };
}

type FixtureInfrastructure = CustomizedInfrastructure & {
  readonly realtime: ReturnType<typeof createInMemoryRealtimeBackend>;
  readonly outbox: ReturnType<typeof createInMemoryOutbox>;
  readonly cacheOutbox: ReturnType<typeof createInMemoryOutbox>;
  readonly cache: ReturnType<typeof createInMemoryCacheBackend>;
  readonly paymentsOutbox: ReturnType<typeof createInMemoryOutbox>;
  readonly realtimeOutbox: ReturnType<typeof createInMemoryOutbox>;
  readonly webhookEvents: ReturnType<typeof createInMemoryWebhookEventStore>;
  readonly storage: ReturnType<typeof createInMemoryStorageAdapter>;
  readonly attachmentLedger: ReturnType<typeof createInMemoryAttachmentLedger>;
  readonly purgeOutbox: ReturnType<typeof createInMemoryOutbox>;
};

function fixtureInfrastructure(
  overrides: Partial<CustomizedInfrastructure> = {},
): FixtureInfrastructure {
  const paymentsOutbox = createInMemoryOutbox(paymentsOutboxDefinition);
  return {
    unitOfWork: fixtureUnitOfWork(),
    notifier: fixtureNotifier(),
    outbox: createInMemoryOutbox(reportsOutbox),
    idempotency: createInMemoryIdempotencyStore(),
    cache: createInMemoryCacheBackend(),
    cacheOutbox: createInMemoryOutbox(cacheInvalidationOutbox),
    realtime: createInMemoryRealtimeBackend({ channels: publishedChannels }),
    realtimeOutbox: createInMemoryOutbox(defineRealtimePublicationOutbox(publishedChannels)),
    paymentSink: { adapter: "fixture", record: vi.fn(async () => undefined) },
    paymentsOutbox,
    webhookEvents: createInMemoryWebhookEventStore({ outbox: paymentsOutbox }),
    webhookSecrets: { stripe: webhookSecret("whsec_fixture"), twilio: webhookSecret("auth-token") },
    jobs: createInMemoryJobBackend(),
    locks: createInMemoryLockProvider(),
    storage: createInMemoryStorageAdapter(),
    attachmentLedger: createInMemoryAttachmentLedger(),
    purgeOutbox: createInMemoryOutbox(defineStoragePurgeOutbox()),
    scheduledTenants: ["acme", "beta"],
    ...overrides,
  } as FixtureInfrastructure;
}

const publisher = operationActor({
  id: "publisher",
  permissions: ["reports:notify", "tenant:acme"],
});

describe("customized portfolio application", () => {
  it("denies cross-tenant queries before repository work", async () => {
    const summarize = vi.fn(async () => []);
    const result = await createExecutor(
      createCustomizedApplication(
        fixtureInfrastructure({ unitOfWork: fixtureUnitOfWork(summarize) }),
      ),
    ).run(
      "portfolio.summary",
      {
        params: { tenantId: "beta" },
        query: { states: ["open"], minimumEffort: 0, limit: 10 },
      },
      {
        requestId: "cross-tenant",
        actor: operationActor({
          id: "analyst",
          permissions: ["portfolio:read", "tenant:acme"],
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "TENANT_ACCESS_DENIED", details: { tenantId: "beta" } },
    });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("routes a declared effect only to the selected adapter", async () => {
    const selected = vi.fn(async () => undefined);
    const unused = vi.fn(async () => undefined);
    const collected = collectPublishes(
      createCustomizedApplication(fixtureInfrastructure({ notifier: fixtureNotifier(selected) })),
    );
    const result = await createExecutor(collected.application).run(
      "reports.notify",
      {
        params: { tenantId: "acme" },
        body: { recipient: "ops@example.test", subject: "Weekly status" },
      },
      {
        requestId: "notify",
        actor: operationActor({
          id: "publisher",
          permissions: ["reports:notify", "tenant:acme"],
        }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 202,
      data: { accepted: true, adapter: "fixture" },
    });
    expect(selected).toHaveBeenCalledWith({
      tenantId: "acme",
      recipient: "ops@example.test",
      subject: "Weekly status",
      requestedBy: "publisher",
    });
    expect(unused).not.toHaveBeenCalled();
    expect(collected.publishes()).toEqual([
      expect.objectContaining({
        channelId: "reports.delivered",
        scopeKey: "publisher",
        payload: {
          tenantId: "acme",
          recipient: "ops@example.test",
          subject: "Weekly status",
          adapter: "fixture",
        },
      }),
    ]);
  });

  it("authorizes project activity subscriptions by permission and resource shape", async () => {
    const context = { requestId: "subscribe" };
    const reader = operationActor({ id: "analyst", permissions: ["portfolio:read"] });
    const projectId = "11111111-1111-4111-8111-111111111111";
    expect(await projectActivity.authorizeSubscription?.(reader, projectId, context)).toBe(true);
    expect(await projectActivity.authorizeSubscription?.(reader, "not-a-project", context)).toBe(
      false,
    );
    expect(
      await projectActivity.authorizeSubscription?.(
        operationActor({ id: "guest" }),
        projectId,
        context,
      ),
    ).toBe(false);
  });

  it("streams validated progress frames and returns the terminal summary", async () => {
    const frames: unknown[] = [];
    const result = await createExecutor(createCustomizedApplication(fixtureInfrastructure())).run(
      "reports.progress",
      { params: { tenantId: "acme" }, body: { steps: 4 } },
      {
        requestId: "progress",
        actor: publisher,
        stream: { write: (frame) => void frames.push(frame) },
      },
    );

    expect(frames).toEqual([
      { step: 1, total: 4, percent: 25 },
      { step: 2, total: 4, percent: 50 },
      { step: 3, total: 4, percent: 75 },
      { step: 4, total: 4, percent: 100 },
    ]);
    expect(result).toMatchObject({ ok: true, status: 200, data: { tenantId: "acme", steps: 4 } });
  });

  it("denies cross-tenant streams before any frame is emitted", async () => {
    const frames: unknown[] = [];
    const result = await createExecutor(createCustomizedApplication(fixtureInfrastructure())).run(
      "reports.progress",
      { params: { tenantId: "beta" }, body: { steps: 2 } },
      {
        requestId: "progress-denied",
        actor: publisher,
        stream: { write: (frame) => void frames.push(frame) },
      },
    );

    expect(frames).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "TENANT_ACCESS_DENIED" },
    });
  });

  it("publishes the effect and tenant boundary in the compiled graph", () => {
    const graph = createCustomizedApplication(fixtureInfrastructure()).graph;
    const notify = graph.operations.find((operation) => operation.id === "reports.notify");
    const summary = graph.operations.find((operation) => operation.id === "portfolio.summary");

    expect(notify).toMatchObject({
      transaction: "none",
      effects: [{ id: "reports.notifier", delivery: "immediate" }],
      publishes: ["reports.delivered"],
    });
    expect(summary).toMatchObject({
      transaction: "read",
      effects: [],
      publishes: [],
      cache: {
        ttlMs: 30_000,
        scope: "tenant",
        tags: [PORTFOLIO_SUMMARY_TAG],
        varies: true,
        backendId: "platform.cache",
        cacheControl: "private, max-age=30",
      },
    });
    expect(graph.operations.find((operation) => operation.id === "reports.progress")).toMatchObject(
      {
        transaction: "none",
        transport: {
          kind: "http",
          binding: "POST /tenants/:tenantId/report-progress",
          response: {
            mode: "stream",
            framing: "sse",
            frame: { vendor: "zod" },
            heartbeatMs: 15_000,
            maxDurationMs: 60_000,
            maxFrames: 100,
          },
        },
      },
    );
    expect(graph.channels).toEqual([
      expect.objectContaining({
        id: "portfolio.activity",
        moduleId: "portfolio",
        scope: "resource",
        presence: true,
        publishers: [],
      }),
      expect.objectContaining({
        id: "reports.delivered",
        moduleId: "reports",
        scope: "actor",
        presence: false,
        publishers: ["reports.notify", "ship-realtime.publication.dispatch"],
      }),
      expect.objectContaining({
        id: "reports.requested",
        moduleId: "reports",
        scope: "actor",
        presence: false,
        publishers: ["reports.request", "ship-realtime.publication.dispatch"],
      }),
    ]);
    expect(graph.outboxes.map((outbox) => outbox.id)).toEqual([
      "payments.outbox",
      "reports.outbox",
      "ship-cache.invalidation",
      REALTIME_PUBLICATION_OUTBOX_ID,
    ]);
    expect(graph.outboxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reports.outbox",
          intents: [{ id: "notify", effectId: "reports.notifier", payloadVendor: "zod" }],
          operations: {
            writers: ["reports.deliver", "reports.request"],
            dispatchers: ["reports.outbox.dispatch"],
            cleanups: ["jobs.cleanup"],
            management: [
              "reports.outbox.discard",
              "reports.outbox.list-dead-lettered",
              "reports.outbox.retry",
            ],
          },
        }),
        expect.objectContaining({
          id: "payments.outbox",
          operations: expect.objectContaining({
            dispatchers: ["payments.outbox.dispatch"],
            cleanups: ["jobs.cleanup"],
          }),
        }),
        expect.objectContaining({
          id: "ship-cache.invalidation",
          intents: [{ id: "purge-tag", effectId: "ship-cache.backend", payloadVendor: "ship" }],
          operations: expect.objectContaining({
            dispatchers: ["ship-cache.invalidation.dispatch"],
          }),
        }),
      ]),
    );
    expect(graph.operations.find((operation) => operation.id === "reports.request")).toMatchObject({
      transaction: "write",
      idempotency: { windowMs: 24 * 60 * 60 * 1000, storeId: "platform.idempotency" },
      outbox: [{ id: "reports.outbox", role: "writer" }],
      invalidates: [PORTFOLIO_SUMMARY_TAG],
      publishes: ["reports.requested"],
      publicationDelivery: "outbox",
    });
    expect(notify).toMatchObject({ publicationDelivery: "immediate" });
    expect(
      graph.outboxes.find((outbox) => outbox.id === REALTIME_PUBLICATION_OUTBOX_ID),
    ).toMatchObject({
      intents: [
        { id: "reports.delivered", effectId: "reports.delivered.publish" },
        { id: "reports.requested", effectId: "reports.requested.publish" },
      ],
      operations: expect.objectContaining({
        dispatchers: ["ship-realtime.publication.dispatch"],
        cleanups: ["ship-realtime.publication.cleanup"],
      }),
    });
  });

  it("records the request and delivery intent, then performs the effect only when dispatched", async () => {
    const send = vi.fn(async () => undefined);
    const infrastructure = fixtureInfrastructure({ notifier: fixtureNotifier(send) });
    const executor = createExecutor(createCustomizedApplication(infrastructure));
    const body = { requestKey: "weekly-1", recipient: "ops@example.test", subject: "Weekly" };

    const result = await executor.run(
      "reports.request",
      { params: { tenantId: "acme" }, body },
      { requestId: "request-1", actor: publisher },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      data: { requestId: "11111111-1111-4111-8111-111111111111", queued: true },
    });
    expect(send).not.toHaveBeenCalled();
    expect(infrastructure.outbox.records()).toMatchObject([
      { intentId: "notify", status: "pending", dedupeKey: "11111111-1111-4111-8111-111111111111" },
    ]);

    await expect(drainOutbox(executor, reportsOutbox)).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(send).toHaveBeenCalledWith({
      tenantId: "acme",
      recipient: "ops@example.test",
      subject: "Weekly",
      requestedBy: "publisher",
    });
  });

  it("records the requested event with the write and publishes it only when dispatched", async () => {
    const infrastructure = fixtureInfrastructure();
    const collected = collectPublishes(createCustomizedApplication(infrastructure));
    const executor = createExecutor(collected.application);
    const body = { requestKey: "weekly-2", recipient: "ops@example.test", subject: "Weekly" };

    const result = await executor.run(
      "reports.request",
      { params: { tenantId: "acme" }, body },
      { requestId: "request-2", actor: publisher },
    );
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(collected.publishes()).toEqual([]);
    expect(infrastructure.realtimeOutbox.records()).toMatchObject([
      {
        intentId: "reports.requested",
        status: "pending",
        dedupeKey: "11111111-1111-4111-8111-111111111111",
        payload: {
          scopeKey: "publisher",
          payload: {
            requestId: "11111111-1111-4111-8111-111111111111",
            tenantId: "acme",
            subject: "Weekly",
          },
        },
      },
    ]);

    await expect(drainRealtimePublications(executor)).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(collected.publishes()).toEqual([
      expect.objectContaining({
        channelId: "reports.requested",
        scopeKey: "publisher",
        payload: {
          requestId: "11111111-1111-4111-8111-111111111111",
          tenantId: "acme",
          subject: "Weekly",
        },
      }),
    ]);
  });

  it("replays the stored result for a repeated request key without re-running the handler", async () => {
    const recordReportRequest = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222" }));
    const infrastructure = fixtureInfrastructure({
      unitOfWork: fixtureUnitOfWork(
        vi.fn(async () => []),
        recordReportRequest,
      ),
    });
    const executor = createExecutor(createCustomizedApplication(infrastructure));
    const input = {
      params: { tenantId: "acme" },
      body: { requestKey: "weekly-2", recipient: "ops@example.test", subject: "Weekly" },
    };

    const first = await executor.run("reports.request", input, { actor: publisher });
    const replay = await executor.run("reports.request", input, { actor: publisher });

    expect(first).toMatchObject({ ok: true, data: { queued: true } });
    expect(replay).toMatchObject({ ok: true, data: { queued: true } });
    expect(recordReportRequest).toHaveBeenCalledTimes(1);
    expect(infrastructure.outbox.records()).toHaveLength(1);
  });

  it("restricts the dispatcher and cleanup to system actors and cleans by retention", async () => {
    const time = { now: Date.now() + 3_600_000 };
    const infrastructure = fixtureInfrastructure({ clock: () => new Date(time.now) });
    const executor = createExecutor(createCustomizedApplication(infrastructure));
    await executor.run(
      "reports.request",
      {
        params: { tenantId: "acme" },
        body: { requestKey: "weekly-3", recipient: "ops@example.test", subject: "Weekly" },
      },
      { actor: publisher },
    );

    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: publisher }),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: { code: "AUTHORIZATION_ERROR", details: { requiredActorKind: "system" } },
    });
    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });

    time.now += 8 * 24 * 60 * 60 * 1000;
    await expect(
      executor.run("jobs.cleanup", { payload: {} }, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        outboxes: [
          { id: "reports.outbox", completedDeleted: 1, deadLetteredDeleted: 0 },
          { id: "payments.outbox", completedDeleted: 0, deadLetteredDeleted: 0 },
        ],
      },
    });
    expect(infrastructure.outbox.records()).toEqual([]);
  });

  it("serves the tenant summary from the declared cache and keys it per tenant", async () => {
    const summarize = vi.fn(async () => []);
    const infrastructure = fixtureInfrastructure({
      unitOfWork: fixtureUnitOfWork(summarize),
    });
    const executor = createExecutor(createCustomizedApplication(infrastructure));
    const query = { states: ["open" as const], minimumEffort: 0, limit: 10 };
    const acme = operationActor({ id: "analyst", permissions: ["portfolio:read", "tenant:acme"] });
    const other = operationActor({ id: "auditor", permissions: ["portfolio:read", "tenant:beta"] });

    const miss = await executor.run(
      "portfolio.summary",
      { params: { tenantId: "acme" }, query },
      { requestId: "summary-1", actor: acme },
    );
    const hit = await executor.run(
      "portfolio.summary",
      { params: { tenantId: "acme" }, query },
      { requestId: "summary-2", actor: acme },
    );
    const otherTenant = await executor.run(
      "portfolio.summary",
      { params: { tenantId: "beta" }, query },
      { requestId: "summary-3", actor: other },
    );

    expect(miss).toMatchObject({ ok: true, cache: "miss" });
    expect(hit).toMatchObject({ ok: true, cache: "hit" });
    expect(otherTenant).toMatchObject({ ok: true, cache: "miss" });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("commits a purge intent with the write and purges only once dispatched", async () => {
    const summarize = vi.fn(async () => []);
    const infrastructure = fixtureInfrastructure({
      unitOfWork: fixtureUnitOfWork(summarize),
    });
    const executor = createExecutor(createCustomizedApplication(infrastructure));
    const query = { states: ["open" as const], minimumEffort: 0, limit: 10 };
    const acme = operationActor({ id: "analyst", permissions: ["portfolio:read", "tenant:acme"] });

    await executor.run(
      "portfolio.summary",
      { params: { tenantId: "acme" }, query },
      { actor: acme },
    );
    await executor.run(
      "reports.request",
      {
        params: { tenantId: "acme" },
        body: { requestKey: "weekly-4", recipient: "ops@example.test", subject: "Weekly" },
      },
      { actor: publisher },
    );

    expect(infrastructure.cacheOutbox.records()).toMatchObject([
      { intentId: "purge-tag", status: "pending", payload: { tag: PORTFOLIO_SUMMARY_TAG } },
    ]);
    // Invalidation is eventual: the entry survives until the dispatcher runs.
    await expect(
      executor.run("portfolio.summary", { params: { tenantId: "acme" }, query }, { actor: acme }),
    ).resolves.toMatchObject({ cache: "hit" });

    await expect(drainOutbox(executor, cacheInvalidationOutbox)).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(infrastructure.cache.size()).toBe(0);
    await expect(
      executor.run("portfolio.summary", { params: { tenantId: "acme" }, query }, { actor: acme }),
    ).resolves.toMatchObject({ cache: "miss" });
  });

  it("projects both webhooks with provider, body policy, idempotency window and guarantees", () => {
    const graph = createCustomizedApplication(fixtureInfrastructure()).graph;
    const stripe = graph.operations.find((operation) => operation.id === "payments.stripe-webhook");
    const sms = graph.operations.find((operation) => operation.id === "messaging.inbound-sms");
    expect(stripe).toMatchObject({
      access: { kind: "provider", provider: "stripe" },
      transaction: "write",
      idempotency: { windowMs: 3 * 24 * 60 * 60 * 1000, storeId: "platform.idempotency" },
      outbox: [{ id: "payments.outbox", role: "writer" }],
      transport: {
        binding: "POST /webhooks/stripe",
        metadata: {
          requestBody: { mode: "raw", maxBytes: 262_144, contentTypes: ["application/json"] },
          webhook: {
            provider: "stripe",
            mode: "enqueue",
            guarantees: { signature: true, freshness: true, replay: false },
            outbox: { id: "payments.outbox", intent: "process-webhook" },
          },
        },
      },
    });
    expect(sms).toMatchObject({
      access: { kind: "provider", provider: "twilio" },
      transaction: "none",
      transport: {
        metadata: {
          response: "text",
          contentType: "text/xml",
          webhook: {
            provider: "twilio",
            mode: "inline",
            response: { mode: "text", contentType: "text/xml" },
            guarantees: { signature: true, freshness: false, replay: false },
            idempotency: { inFlight: { kind: "wait", maxMs: 2_000 } },
          },
        },
      },
    });
    const status = graph.operations.find((operation) => operation.id === "messaging.sms-status");
    expect(status).toMatchObject({
      access: { kind: "provider", provider: "twilio" },
      transport: {
        binding: "POST /webhooks/twilio/sms-status",
        metadata: { response: "empty", webhook: { response: { mode: "empty" } } },
      },
    });
    expect(status?.transport?.metadata).not.toHaveProperty("contentType");
    const replay = graph.operations.find((operation) => operation.id === "payments.webhook-replay");
    expect(replay).toMatchObject({
      access: { kind: "permissions", permissions: ["ship.webhooks:replay"] },
      transport: { binding: "POST /webhooks/:id/retry" },
    });
    expect(graph.operations.map((operation) => operation.id)).toEqual(
      expect.arrayContaining([
        "payments.webhook-replay",
        "payments.webhook-cleanup",
        "payments.outbox.dispatch",
      ]),
    );
  });

  it("records a verified Stripe event durably and performs the ledger effect only on dispatch", async () => {
    const record = vi.fn(async () => undefined);
    const infrastructure = fixtureInfrastructure({ paymentSink: { adapter: "fixture", record } });
    const executor = createExecutor(createCustomizedApplication(infrastructure));
    const rawBody = new TextEncoder().encode('{"id":"evt_1","type":"invoice.paid"}');
    const input = {
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
      body: rawBody,
      verified: { eventId: "evt_1", bodyDigest: "0".repeat(64) },
    };
    const actor = providerActor({ id: "stripe:evt_1", provider: "stripe" });

    const accepted = await executor.run("payments.stripe-webhook", input, { actor });
    expect(accepted).toMatchObject({ ok: true, status: 202, data: { accepted: true } });
    const [event] = infrastructure.webhookEvents.events();
    expect(event).toMatchObject({
      webhookId: "payments.stripe-webhook",
      provider: "stripe",
      providerEventId: "evt_1",
      outboxRecordId: "payments.outbox:1",
    });
    // The signature header is redacted from the stored event.
    expect(event?.headers).toEqual({ "content-type": "application/json" });
    expect(record).not.toHaveBeenCalled();

    const duplicate = await executor.run("payments.stripe-webhook", input, { actor });
    expect(duplicate).toMatchObject({ ok: true, status: 202, replayed: true });
    expect(infrastructure.webhookEvents.events()).toHaveLength(1);

    const rejected = await executor.run("payments.stripe-webhook", input, {
      actor: providerActor({ id: "x", provider: "twilio" }),
    });
    expect(rejected).toMatchObject({ ok: false, status: 403 });

    await expect(drainOutbox(executor, paymentsOutboxDefinition)).resolves.toMatchObject({
      completed: 1,
    });
    expect(record).toHaveBeenCalledWith({ eventId: event?.id, provider: "stripe" });
  });

  it("answers a verified inbound SMS inline with TwiML and a status callback with nothing", async () => {
    const executor = createExecutor(createCustomizedApplication(fixtureInfrastructure()));
    const receipt = (body: string) => ({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new TextEncoder().encode(body),
      verified: { bodyDigest: "1".repeat(64) },
    });
    const actor = providerActor({ id: "twilio:req", provider: "twilio" });
    const reply = await executor.run("messaging.inbound-sms", receipt("From=%2B1&Body=hi"), {
      actor,
    });
    expect(reply).toMatchObject({ ok: true, status: 200, data: INBOUND_SMS_TWIML });
    const status = await executor.run(
      "messaging.sms-status",
      receipt("MessageSid=SM1&MessageStatus=delivered"),
      { actor },
    );
    expect(status).toMatchObject({ ok: true, status: 200 });
    expect((status as { data?: unknown }).data).toBeUndefined();
  });
});

describe("customized declared jobs", () => {
  it("projects both jobs, the cleanup sweep and the management operations into the graph", () => {
    const graph = createCustomizedApplication(fixtureInfrastructure()).graph;
    expect(
      graph.jobs.map((job) => [job.id, job.trigger.kind, job.concurrency.mode, job.enqueues]),
    ).toEqual([
      ["jobs.cleanup", "schedule", "single-runner", []],
      ["reports.deliver", "enqueue", "single-runner", []],
      ["reports.digest", "schedule", "single-runner", ["reports.deliver"]],
    ]);
    expect(graph.jobs.find((job) => job.id === "reports.deliver")).toMatchObject({
      transaction: "write",
      concurrency: { keyed: true, max: 4 },
      operations: { enqueuedBy: ["reports.digest"] },
    });
    expect(graph.operations.map((operation) => operation.id)).toEqual(
      expect.arrayContaining(["jobs.list-failed", "jobs.retry", "jobs.discard", "jobs.health"]),
    );
  });

  it("fans the scheduled digest out to one delivery per enrolled tenant, deduplicated by period", async () => {
    const infrastructure = fixtureInfrastructure({
      clock: () => new Date("2026-09-18T06:00:00.000Z"),
    });
    const app = createCustomizedApplication(infrastructure);
    const jobs = infrastructure.jobs as ReturnType<typeof createInMemoryJobBackend>;
    jobs.attach({
      jobs: collectJobs(app).map((job) => job.job),
      execute: async () => ({ ok: true, data: undefined }),
    });

    const first = await runJobOnce(app, "reports.digest", {});
    const second = await runJobOnce(app, "reports.digest", {});

    expect(first).toMatchObject({ ok: true, data: { period: "2026-09-18" } });
    if (!first.ok) throw new Error("unreachable");
    expect((first.data as { enqueued: readonly string[] }).enqueued).toHaveLength(2);
    expect(second).toMatchObject({ ok: true, data: { enqueued: [] } });
    expect(jobs.runs().map((run) => [run.jobId, run.key, run.input])).toEqual([
      ["reports.deliver", "acme", { tenantId: "acme", period: "2026-09-18" }],
      ["reports.deliver", "beta", { tenantId: "beta", period: "2026-09-18" }],
    ]);
  });

  it("delivers as a system actor: re-authorizes the tenant, writes through the unit of work and enqueues the intent", async () => {
    const recordReportRequest = vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333" }));
    const send = vi.fn(async () => undefined);
    const infrastructure = fixtureInfrastructure({
      unitOfWork: fixtureUnitOfWork(
        vi.fn(async () => []),
        recordReportRequest,
      ),
      notifier: fixtureNotifier(send),
    });
    const app = createCustomizedApplication(infrastructure);
    const executor = createExecutor(app);

    const delivered = await runJobOnce(
      app,
      "reports.deliver",
      { tenantId: "acme", period: "2026-09-18" },
      { executor },
    );
    expect(delivered).toMatchObject({ ok: true, data: { queued: true } });
    expect(recordReportRequest).toHaveBeenCalledWith({
      recipient: "reports@example.test",
      subject: "Digest for 2026-09-18",
      requestedBy: "ship.testing.jobs",
    });
    expect(infrastructure.outbox.records()).toMatchObject([
      { intentId: "notify", status: "pending", dedupeKey: "digest:acme:2026-09-18" },
    ]);
    expect(send).not.toHaveBeenCalled();
    await drainOutbox(executor, reportsOutbox);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "acme", subject: "Digest for 2026-09-18" }),
    );

    // A tenant the application never enrolled is refused even for system work.
    await expect(
      runJobOnce(app, "reports.deliver", { tenantId: "gamma", period: "2026-09-18" }, { executor }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: "TENANT_ACCESS_DENIED" } });
    // Jobs are system-only: a human publisher cannot start one directly.
    await expect(
      executor.run(
        "reports.deliver",
        { payload: { tenantId: "acme", period: "2026-09-18" } },
        { actor: publisher },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: { details: { requiredActorKind: "system" } },
    });
  });
});

describe("customized legacy bridge", () => {
  const actor = operationActor({ id: "publisher", permissions: ["reports:notify", "tenant:acme"] });

  it("publishes to any declared channel through a registry derived from the application", async () => {
    const infrastructure = fixtureInfrastructure();
    const application = createCustomizedApplication(infrastructure);
    const bridge = createLegacyBridge(application, infrastructure.realtime);
    expect(bridge.publishers.channels.map((channel) => channel.id)).toEqual([
      "portfolio.activity",
      "reports.delivered",
      "reports.requested",
    ]);
    await bridge.publish("reports.delivered", "publisher", {
      tenantId: "acme",
      recipient: "ops@example.test",
      subject: "Bridged",
      adapter: "legacy",
    });
    await bridge.notifyDelivered("publisher", {
      tenantId: "acme",
      recipient: "ops@example.test",
      subject: "Typed",
      adapter: "legacy",
    });
    expect(
      infrastructure.realtime.published.map((item) => [item.channelId, item.scopeKey]),
    ).toEqual([
      ["reports.delivered", "publisher"],
      ["reports.delivered", "publisher"],
    ]);
    // The channel schema still guards the erased path.
    await expect(
      bridge.publish("reports.delivered", "publisher", { subject: 1 }),
    ).rejects.toMatchObject({
      code: "SHIP_REALTIME_PAYLOAD_INVALID",
      channelId: "reports.delivered",
    });
    await expect(bridge.publish("reports.unknown", "publisher", {})).rejects.toMatchObject({
      code: "SHIP_REALTIME_CHANNEL_INVALID",
    });
    expect(infrastructure.realtime.published).toHaveLength(2);
  });

  it("answers a legacy call with the 500 envelope instead of throwing", async () => {
    const infrastructure = fixtureInfrastructure({
      notifier: fixtureNotifier(
        vi.fn(async () => {
          throw new Error("smtp down");
        }),
      ),
    });
    const bridge = createLegacyBridge(
      createCustomizedApplication(infrastructure),
      infrastructure.realtime,
    );
    const failed = await bridge.call(
      "reports.notify",
      { params: { tenantId: "acme" }, body: { recipient: "ops@example.test", subject: "x" } },
      actor,
    );
    expect(failed).toMatchObject({
      ok: false,
      status: 500,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        details: { code: "SHIP_OPERATION_HANDLER_FAILED", operationId: "reports.notify" },
      },
    });
    const denied = await bridge.call(
      "reports.notify",
      { params: { tenantId: "beta" }, body: { recipient: "ops@example.test", subject: "x" } },
      actor,
    );
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "TENANT_ACCESS_DENIED" },
    });
  });

  it("dispatches durable publications with the framework runner, without the jobs capability", async () => {
    const infrastructure = fixtureInfrastructure();
    const bridge = createLegacyBridge(
      createCustomizedApplication(infrastructure),
      infrastructure.realtime,
    );
    const passes: number[] = [];
    const runner = bridge.startDispatcher({
      intervalMs: 5,
      observer: { pass: (pass) => passes.push(pass.ok ? pass.result.completed : -1) },
    });
    const recorded = await bridge.call(
      "reports.request",
      {
        params: { tenantId: "acme" },
        body: { requestKey: "bridge-1", recipient: "ops@example.test", subject: "Weekly" },
      },
      actor,
    );
    expect(recorded).toMatchObject({ ok: true, status: 201 });
    await vi.waitFor(() =>
      expect(infrastructure.realtime.published).toContainEqual(
        expect.objectContaining({ channelId: "reports.requested", scopeKey: "publisher" }),
      ),
    );
    await runner.stop();
    expect(passes).toContain(1);
    expect(infrastructure.realtimeOutbox.records()).toMatchObject([
      { intentId: "reports.requested", status: "completed" },
    ]);
  });

  it("drains a reports backlog adaptively: full batches back to back, then the idle interval", async () => {
    // Every request row gets its own id, so every delivery intent has its own dedupe key.
    const infrastructure = fixtureInfrastructure({
      unitOfWork: fixtureUnitOfWork(
        undefined,
        vi.fn(async () => ({ id: crypto.randomUUID() })),
      ),
    });
    const bridge = createLegacyBridge(
      createCustomizedApplication(infrastructure),
      infrastructure.realtime,
    );
    // Two full batches plus one: the runner must take the full ones at once
    // and only wait the (long) interval after the short third pass.
    const backlog = DISPATCH_BATCH_SIZE * 2 + 1;
    for (let index = 0; index < backlog; index += 1) {
      const recorded = await bridge.call(
        "reports.request",
        {
          params: { tenantId: "acme" },
          body: { requestKey: `adaptive-${index}`, recipient: "ops@example.test", subject: "W" },
        },
        actor,
      );
      expect(recorded).toMatchObject({ ok: true, status: 201 });
    }
    const claimed: number[] = [];
    const runner = bridge.startReportsDispatcher({
      intervalMs: 60_000,
      observer: { pass: (pass) => claimed.push(pass.ok ? pass.result.claimed : -1) },
    });
    expect(runner.kind).toBe("ship.outbox-dispatch-runner");
    await vi.waitFor(() => expect(claimed).toEqual([DISPATCH_BATCH_SIZE, DISPATCH_BATCH_SIZE, 1]));
    expect(infrastructure.notifier.send).toHaveBeenCalledTimes(backlog);
    expect(
      infrastructure.outbox.records().filter((record) => record.status === "pending"),
    ).toHaveLength(0);
    await runner.stop();
    // The short pass yielded to the interval: no fourth pass ran.
    expect(runner.passes).toBe(3);
  });

  it("declares the expected report rate and a dispatch capacity that covers it", () => {
    const app = createCustomizedApplication(fixtureInfrastructure());
    expect(app.diagnostics ?? []).not.toContainEqual(
      expect.objectContaining({ code: "SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE" }),
    );
    expect(app.graph.outboxes.find((outbox) => outbox.id === "reports.outbox")).toMatchObject({
      expectedRatePerSecond: REPORTS_EXPECTED_RATE_PER_SECOND,
      dispatchCapacityPerSecond: DISPATCH_BATCH_SIZE * DISPATCH_ROUNDS_PER_SECOND,
    });
    expect(DISPATCH_BATCH_SIZE * DISPATCH_ROUNDS_PER_SECOND).toBeGreaterThanOrEqual(
      REPORTS_EXPECTED_RATE_PER_SECOND,
    );
  });

  it("projects channel payload JSON Schema from the plain Zod declarations", () => {
    const contract = projectClientContract(createCustomizedApplication(fixtureInfrastructure()));
    expect(contract.channels?.["reports.delivered"]).toEqual({
      scope: "actor",
      presence: false,
      payload: {
        vendor: "zod",
        jsonSchema: expect.objectContaining({
          type: "object",
          required: ["tenantId", "recipient", "subject", "adapter"],
          properties: expect.objectContaining({
            recipient: expect.objectContaining({ type: "string", format: "email" }),
            adapter: { type: "string" },
          }),
        }),
      },
    });
    const graph = createCustomizedApplication(fixtureInfrastructure()).graph;
    expect(graph.channels.map((channel) => channel.payload)).toEqual([
      { vendor: "zod", projectable: true },
      { vendor: "zod", projectable: true },
      { vendor: "zod", projectable: true },
    ]);
  });

  it("pages project presence and answers whether an actor is online", async () => {
    const backend = createInMemoryRealtimeBackend({ channels: [projectActivity] });
    const projectId = "11111111-1111-4111-8111-111111111111";
    const request = { channelId: "portfolio.activity", scopeKey: projectId, requestId: "presence" };
    const readers = ["ana", "ben", "cai"].map((id) =>
      operationActor({ id, permissions: ["portfolio:read"] }),
    );
    for (const reader of readers) {
      const joined = await backend.subscribe(
        { ...request, actor: reader, connectionId: `${reader.id}-1` },
        () => undefined,
      );
      expect(joined.ok).toBe(true);
    }
    const first = await backend.presence?.snapshot({ ...request, actor: readers[0], limit: 2 });
    expect(first).toEqual({
      ok: true,
      snapshot: { count: 3, actorIds: ["ana", "ben"], nextCursor: "ben" },
    });
    expect(
      await backend.presence?.snapshot({ ...request, actor: readers[0], limit: 2, cursor: "ben" }),
    ).toEqual({ ok: true, snapshot: { count: 3, actorIds: ["cai"] } });
    expect(
      await backend.presence?.actorOnline({ ...request, actor: readers[0], actorId: "cai" }),
    ).toEqual({ ok: true, online: true });
    await backend.disconnect("cai-1");
    expect(
      await backend.presence?.actorOnline({ ...request, actor: readers[0], actorId: "cai" }),
    ).toEqual({ ok: true, online: false });
    expect(
      await backend.presence?.actorOnline({
        ...request,
        actor: operationActor({ id: "guest" }),
        actorId: "ana",
      }),
    ).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("managed storage", () => {
  const editor = operationActor({
    id: "editor",
    permissions: ["portfolio:read", "portfolio:write", "tenant:acme"],
  });
  const projectId = "33333333-3333-4333-8333-333333333333";

  async function uploadPhoto(
    executor: ReturnType<typeof createExecutor>,
    storage: ReturnType<typeof createInMemoryStorageAdapter>,
    bytes = new TextEncoder().encode("png-bytes"),
  ) {
    const intent = await executor.run(
      "ship-storage.create-intent",
      { body: { attachment: "portfolio.photo", contentType: "image/png", size: bytes.byteLength } },
      { actor: editor },
    );
    if (!intent.ok) throw new Error(`intent failed: ${intent.error.code}`);
    expect(await storage.upload(intent.data.upload.url, bytes, intent.data.upload.headers)).toBe(
      200,
    );
    const complete = await executor.run(
      "ship-storage.complete",
      { params: { intentId: intent.data.intentId } },
      { actor: editor },
    );
    if (!complete.ok) throw new Error(`completion failed: ${complete.error.code}`);
    return complete.data;
  }

  it("projects the attachment policy into the graph and the client contract without provider detail", () => {
    const application = createCustomizedApplication(fixtureInfrastructure());
    expect(application.graph.attachments).toEqual([
      expect.objectContaining({
        id: "portfolio.photo",
        moduleId: "portfolio",
        cardinality: "many",
        maxBytes: 5_000_000,
        visibility: "private",
        maxCount: 12,
        variants: ["thumb"],
        providerId: "portfolio.photo.attachment",
        operations: ["portfolio.attach-photo", "portfolio.photos", "portfolio.remove-photo"],
      }),
    ]);
    const contract = projectClientContract(application);
    expect(contract.attachments).toEqual({
      "portfolio.photo": {
        cardinality: "many",
        contentTypes: ["image/jpeg", "image/png", "image/webp"],
        maxBytes: 5_000_000,
        visibility: "private",
        maxCount: 12,
        variants: ["thumb"],
      },
    });
    expect(JSON.stringify(contract)).not.toContain("memory");
    expect(
      contract.operations.find((operation) => operation.id === "ship-storage.create-intent")
        ?.transport?.binding,
    ).toBe("POST /storage/intents");
  });

  it("uploads through a signed intent, attaches to a project, lists with a pending thumbnail and purges on removal", async () => {
    const infrastructure = fixtureInfrastructure();
    const application = createCustomizedApplication(infrastructure);
    const executor = createExecutor(application);
    const { objectId } = await uploadPhoto(executor, infrastructure.storage);

    const attached = await executor.run(
      "portfolio.attach-photo",
      { params: { tenantId: "acme", projectId }, body: { objectId } },
      { actor: editor },
    );
    expect(attached).toMatchObject({ ok: true, data: { objectId, count: 1 } });
    const again = await executor.run(
      "portfolio.attach-photo",
      { params: { tenantId: "acme", projectId }, body: { objectId } },
      { actor: editor },
    );
    expect(again).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE" } });
    const crossTenant = await executor.run(
      "portfolio.photos",
      { params: { tenantId: "beta", projectId } },
      { actor: editor },
    );
    expect(crossTenant).toMatchObject({ ok: false, error: { code: "TENANT_ACCESS_DENIED" } });

    const listed = await executor.run(
      "portfolio.photos",
      { params: { tenantId: "acme", projectId } },
      { actor: editor },
    );
    expect(listed).toMatchObject({
      ok: true,
      data: {
        photos: [
          {
            objectId,
            contentType: "image/png",
            size: 9,
            url: expect.stringContaining("portfolio.photo/"),
            thumb: null,
          },
        ],
      },
    });
    const variantRun = infrastructure.jobs
      .runs()
      .find((run) => run.jobId === "ship-storage.generate-variant");
    expect(variantRun?.input).toEqual({ objectId, variant: "thumb" });
    await expect(
      runJobOnce(application, "ship-storage.generate-variant", variantRun?.input, { executor }),
    ).resolves.toMatchObject({ ok: true, data: { rendered: true } });
    const withThumb = await executor.run(
      "portfolio.photos",
      { params: { tenantId: "acme", projectId } },
      { actor: editor },
    );
    expect(withThumb).toMatchObject({
      ok: true,
      data: { photos: [{ thumb: expect.stringContaining("variants/thumb.webp") }] },
    });

    const removed = await executor.run(
      "portfolio.remove-photo",
      { params: { tenantId: "acme", projectId, objectId } },
      { actor: editor },
    );
    expect(removed).toMatchObject({ ok: true, data: { removed: true } });
    expect(infrastructure.purgeOutbox.records()).toMatchObject([
      { intentId: "purge-object", payload: { objectId }, status: "pending" },
    ]);
    expect(infrastructure.storage.keys()).toHaveLength(2);
    await expect(drainOutbox(executor, STORAGE_PURGE_OUTBOX_ID)).resolves.toMatchObject({
      completed: 1,
    });
    expect(infrastructure.storage.keys()).toEqual([]);
    expect((await infrastructure.attachmentLedger.readPurge(objectId))?.purgedAt).toBeDefined();
    expect(
      await executor.run(
        "portfolio.photos",
        { params: { tenantId: "acme", projectId } },
        { actor: editor },
      ),
    ).toMatchObject({ ok: true, data: { photos: [] } });
  });

  it("abandons an intent that never completes and removes its stray bytes on sweep", async () => {
    let now = new Date("2026-10-22T10:00:00.000Z");
    const infrastructure = fixtureInfrastructure({ clock: () => now });
    const application = createCustomizedApplication(infrastructure);
    const executor = createExecutor(application);
    const intent = await executor.run(
      "ship-storage.create-intent",
      { body: { attachment: "portfolio.photo", contentType: "image/jpeg", size: 3 } },
      { actor: editor },
    );
    if (!intent.ok) throw new Error("intent failed");
    expect(
      await infrastructure.storage.upload(
        intent.data.upload.url,
        new TextEncoder().encode("jpg"),
        intent.data.upload.headers,
      ),
    ).toBe(200);
    now = new Date(now.getTime() + 16 * 60_000);
    await expect(
      runJobOnce(application, "ship-storage.sweep", {}, { executor }),
    ).resolves.toMatchObject({ ok: true, data: { abandoned: 1 } });
    expect(infrastructure.storage.keys()).toEqual([]);
    expect(
      await executor.run(
        "ship-storage.complete",
        { params: { intentId: intent.data.intentId } },
        { actor: editor },
      ),
    ).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  });
});
