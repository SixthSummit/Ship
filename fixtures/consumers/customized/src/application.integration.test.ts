import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import { projectClientContract } from "@sixthsummit/ship-contract/project";
import { createExecutor, systemActor, webhookSecret } from "@sixthsummit/ship-core";
import { createInMemoryRealtimeBackend } from "@sixthsummit/ship-testing";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import {
  createInMemoryJobBackend,
  createInMemoryLockProvider,
  runJobOnce,
} from "@sixthsummit/ship-testing/jobs";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { createInMemoryStorageAdapter } from "@sixthsummit/ship-testing/storage";
import { stripeSignatureHeader } from "@sixthsummit/ship-webhooks/stripe";
import { twilioSignatureHeader } from "@sixthsummit/ship-webhooks/twilio";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publishedChannels } from "./application.js";
import type { SessionDirectory } from "./auth.js";
import type { PaymentEventSink, ReportNotifier } from "./effects.js";
import { createCustomizedHttpApplication } from "./http.js";
import {
  createAttachmentLedger,
  createCacheInvalidationOutbox,
  createIdempotencyStore,
  createPaymentsOutbox,
  createPortfolioUnitOfWork,
  createRealtimePublicationOutbox,
  createReportsOutbox,
  createStoragePurgeOutbox,
  createWebhookEventStore,
} from "./repository.js";
import {
  idempotencyKeys,
  portfolioSchema,
  projects,
  reportRequests,
  reportsOutboxTable,
  storageIntents,
  storageObjects,
  storagePurges,
  webhookEventsTable,
  workItems,
} from "./schema.js";
import { INBOUND_SMS_TWIML } from "./webhooks.js";

const acmeProjectId = "11111111-1111-4111-8111-111111111111";
const betaProjectId = "22222222-2222-4222-8222-222222222222";
const sessions: SessionDirectory = {
  find: (token) => {
    if (token === "analyst-token") {
      return { actorId: "analyst", role: "analyst", tenants: ["acme"] };
    }
    if (token === "publisher-token") {
      return { actorId: "publisher", role: "publisher", tenants: ["acme"] };
    }
    if (token === "operator-token") {
      return { actorId: "operator", role: "operator", tenants: [] };
    }
    return undefined;
  },
};

describe("customized packed application", () => {
  let database: PostgresTestDb<typeof portfolioSchema>;
  const send = vi.fn(async () => undefined);
  const notifier: ReportNotifier = { adapter: "recording", send };
  const realtime = createInMemoryRealtimeBackend({ channels: publishedChannels });
  const record = vi.fn(async () => undefined);
  const paymentSink: PaymentEventSink = { adapter: "recording", record };
  const stripeSecret = "whsec_integration";
  const twilioToken = "twilio-auth-token";
  /** Real time plus a test-controlled offset so dispatch and retention share one clock. */
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  const storage = createInMemoryStorageAdapter({ now: () => clock.now() });
  const infrastructure = () => ({
    unitOfWork: createPortfolioUnitOfWork(database.db),
    notifier,
    outbox: createReportsOutbox(database.db),
    idempotency: createIdempotencyStore(database.db),
    cache: createInMemoryCacheBackend(),
    cacheOutbox: createCacheInvalidationOutbox(database.db),
    realtime,
    realtimeOutbox: createRealtimePublicationOutbox(database.db),
    paymentSink,
    paymentsOutbox: createPaymentsOutbox(database.db),
    webhookEvents: createWebhookEventStore(database.db),
    webhookSecrets: { stripe: webhookSecret(stripeSecret), twilio: webhookSecret(twilioToken) },
    clock: clock.now,
    jobs: createInMemoryJobBackend(),
    locks: createInMemoryLockProvider(),
    storage,
    attachmentLedger: createAttachmentLedger(database.db),
    purgeOutbox: createStoragePurgeOutbox(database.db),
    unattachedGraceMs: 60_000,
    scheduledTenants: ["acme"],
  });

  beforeAll(async () => {
    database = await setupPostgresTestDb(portfolioSchema);
    await database.db.insert(projects).values([
      { id: acmeProjectId, tenantId: "acme", name: "Apollo" },
      { id: betaProjectId, tenantId: "beta", name: "Hidden" },
    ]);
    await database.db.insert(workItems).values([
      {
        projectId: acmeProjectId,
        state: "open",
        effort: 8,
        createdAt: new Date("2026-09-01T12:00:00.000Z"),
      },
      {
        projectId: acmeProjectId,
        state: "open",
        effort: 5,
        createdAt: new Date("2026-09-02T12:00:00.000Z"),
      },
      {
        projectId: acmeProjectId,
        state: "done",
        effort: 3,
        createdAt: new Date("2026-09-03T12:00:00.000Z"),
      },
      {
        projectId: betaProjectId,
        state: "open",
        effort: 100,
        createdAt: new Date("2026-09-04T12:00:00.000Z"),
      },
    ]);
  });

  afterAll(async () => {
    await database.cleanup();
  });

  it("runs a filtered aggregate without crossing the authorized tenant", async () => {
    const { application, http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
      projectClientContract(application),
      {
        baseUrl: "https://golden.example.test",
        headers: { authorization: "ShipSession analyst-token" },
        fetch: async (input, init) => http.request(input, init),
      },
    );

    const result = await client.call("portfolio.summary", {
      params: { tenantId: "acme" },
      query: { states: ["open"], minimumEffort: 5, limit: 10 },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      metadata: { contentType: "application/json; charset=UTF-8" },
    });
    if (!result.ok) throw new Error("summary unexpectedly failed");
    expect(result.data).toEqual({
      projects: [
        {
          projectId: acmeProjectId,
          projectName: "Apollo",
          itemCount: 2,
          totalEffort: 13,
          latestActivity: "2026-09-02T12:00:00.000Z",
        },
      ],
    });
  });

  it("combines role and tenant policy failures into stable HTTP errors", async () => {
    const { http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const roleDenied = await http.request("/tenants/acme/report-notifications", {
      method: "POST",
      headers: {
        authorization: "ShipSession analyst-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ recipient: "ops@example.test", subject: "Status" }),
    });
    const tenantDenied = await http.request(
      "/tenants/beta/portfolio?states%5B%5D=open&minimumEffort=0&limit=10",
      { headers: { authorization: "ShipSession publisher-token" } },
    );
    const malformed = await http.request(
      "/tenants/acme/portfolio?states%5B%5D=open&minimumEffort=0&limit=10",
      { headers: { authorization: "Bearer wrong-scheme" } },
    );

    expect(roleDenied.status).toBe(403);
    expect(await roleDenied.json()).toMatchObject({
      error: { code: "AUTHORIZATION_ERROR" },
    });
    expect(tenantDenied.status).toBe(403);
    expect(await tenantDenied.json()).toMatchObject({
      error: { code: "TENANT_ACCESS_DENIED", details: { tenantId: "beta" } },
    });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toMatchObject({ error: { code: "AUTHENTICATION_ERROR" } });
  });

  it("streams report progress frames over SSE through the structural client", async () => {
    const { application, http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
      projectClientContract(application),
      {
        baseUrl: "https://golden.example.test",
        headers: { authorization: "ShipSession publisher-token" },
        fetch: async (input, init) => http.request(input, init),
      },
    );

    const handle = client.call("reports.progress", {
      params: { tenantId: "acme" },
      body: { steps: 3 },
    });
    const frames: { step: number; total: number; percent: number }[] = [];
    for await (const frame of handle.frames) frames.push(frame);

    expect(frames).toEqual([
      { step: 1, total: 3, percent: 33 },
      { step: 2, total: 3, percent: 67 },
      { step: 3, total: 3, percent: 100 },
    ]);
    await expect(handle.terminal).resolves.toEqual({ tenantId: "acme", steps: 3 });
    expect(handle.status).toBe("closed");
    expect(handle.metadata?.headers["content-type"]).toBe("text/event-stream; charset=utf-8");

    const denied = client.call("reports.progress", {
      params: { tenantId: "beta" },
      body: { steps: 3 },
    });
    await denied.terminal;
    expect(denied.status).toBe("error");
    expect(denied.error).toMatchObject({ code: "TENANT_ACCESS_DENIED", status: 403 });

    const failed = client.call("reports.progress", {
      params: { tenantId: "acme" },
      body: { steps: 3, failAtStep: 3 },
    });
    const partial: number[] = [];
    for await (const frame of failed.frames) partial.push(frame.step);
    expect(partial).toEqual([1, 2]);
    expect(failed.error).toEqual({
      code: "RENDER_STEP_FAILED",
      status: 409,
      message: "Report rendering failed",
      details: { step: 3 },
    });

    const raw = await http.request("/tenants/acme/report-progress", {
      method: "POST",
      headers: {
        authorization: "ShipSession publisher-token",
        "content-type": "application/json",
        "x-request-id": "progress-raw",
      },
      body: JSON.stringify({ steps: 1 }),
    });
    expect(raw.headers.get("x-ship-stream")).toBe("sse/1");
    expect(await raw.text()).toBe(
      'id: 1\nevent: frame\ndata: {"step":1,"total":1,"percent":100}\n\n' +
        'id: 2\nevent: terminal\ndata: {"tenantId":"acme","steps":1}\n\n',
    );
  });

  it("dispatches the declared effect through the injected adapter", async () => {
    const { application, http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
      projectClientContract(application),
      {
        baseUrl: "https://golden.example.test",
        headers: { authorization: "ShipSession publisher-token" },
        fetch: async (input, init) => http.request(input, init),
      },
    );

    const result = await client.call("reports.notify", {
      params: { tenantId: "acme" },
      body: { recipient: "ops@example.test", subject: "Weekly status" },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 202,
      data: { accepted: true, adapter: "recording" },
    });
    expect(send).toHaveBeenCalledWith({
      tenantId: "acme",
      recipient: "ops@example.test",
      subject: "Weekly status",
      requestedBy: "publisher",
    });
    expect(realtime.published).toEqual([
      expect.objectContaining({ channelId: "reports.delivered", scopeKey: "publisher" }),
    ]);
    const contract = projectClientContract(application);
    expect(contract.channels).toEqual({
      "portfolio.activity": expect.objectContaining({ scope: "resource", presence: true }),
      "reports.delivered": expect.objectContaining({ scope: "actor", presence: false }),
      "reports.requested": expect.objectContaining({ scope: "actor", presence: false }),
    });
    expect(contract.operations.find(({ id }) => id === "reports.notify")?.publishes).toEqual([
      "reports.delivered",
    ]);
  });

  it("commits the request and its delivery intent together, then dispatches durably", async () => {
    const { application, http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
      projectClientContract(application),
      {
        baseUrl: "https://golden.example.test",
        headers: { authorization: "ShipSession publisher-token" },
        fetch: async (input, init) => http.request(input, init),
      },
    );
    const body = { requestKey: "weekly-1", recipient: "ops@example.test", subject: "Weekly" };
    const sendBefore = send.mock.calls.length;

    const denied = await client.call("reports.request", { params: { tenantId: "beta" }, body });
    expect(denied).toMatchObject({ ok: false, status: 403 });
    expect(await database.db.select().from(reportRequests)).toHaveLength(0);
    expect(await database.db.select().from(reportsOutboxTable)).toHaveLength(0);

    const first = await client.call("reports.request", { params: { tenantId: "acme" }, body });
    const replay = await client.call("reports.request", { params: { tenantId: "acme" }, body });
    expect(first).toMatchObject({ ok: true, status: 201, data: { queued: true } });
    if (!first.ok || !replay.ok) throw new Error("request unexpectedly failed");
    // The replay carries the stored result under a fresh request id.
    expect(replay.status).toBe(first.status);
    expect(replay.data).toEqual(first.data);
    expect(await database.db.select().from(reportRequests)).toMatchObject([
      { id: first.data.requestId, tenantId: "acme", requestedBy: "publisher" },
    ]);
    // One table, two outboxes: the notification intent and the cache purge the
    // write declared both commit with the request row.
    const intents = await database.db.select().from(reportsOutboxTable);
    expect(intents.filter((row) => row.outboxId === "reports.outbox")).toMatchObject([
      { intentId: "notify", status: "pending", dedupeKey: first.data.requestId },
    ]);
    expect(intents.filter((row) => row.outboxId === "ship-cache.invalidation")).toMatchObject([
      { intentId: "purge-tag", status: "pending", payload: { tag: "portfolio.summary" } },
    ]);
    // The realtime event commits with the same row and is invisible to
    // subscribers until its own dispatcher runs.
    expect(intents.filter((row) => row.outboxId === "ship-realtime.publication")).toMatchObject([
      {
        intentId: "reports.requested",
        status: "pending",
        dedupeKey: first.data.requestId,
        payload: {
          scopeKey: "publisher",
          payload: { requestId: first.data.requestId, tenantId: "acme", subject: "Weekly" },
        },
      },
    ]);
    expect(realtime.published.map((item) => item.channelId)).not.toContain("reports.requested");
    expect(send).toHaveBeenCalledTimes(sendBefore);

    const executor = createExecutor(application);
    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(send).toHaveBeenLastCalledWith({
      tenantId: "acme",
      recipient: "ops@example.test",
      subject: "Weekly",
      requestedBy: "publisher",
    });
    const dispatched = await database.db.select().from(reportsOutboxTable);
    expect(dispatched.find((row) => row.intentId === "notify")).toMatchObject({
      status: "completed",
    });
    // The cache purge belongs to its own dispatcher and is untouched here.
    expect(dispatched.find((row) => row.intentId === "purge-tag")).toMatchObject({
      status: "pending",
    });

    await expect(
      executor.run(
        "ship-cache.invalidation.dispatch",
        {},
        { actor: systemActor({ id: "worker" }) },
      ),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });

    await expect(
      executor.run(
        "ship-realtime.publication.dispatch",
        {},
        { actor: systemActor({ id: "worker" }) },
      ),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(realtime.published).toContainEqual(
      expect.objectContaining({
        channelId: "reports.requested",
        scopeKey: "publisher",
        payload: { requestId: first.data.requestId, tenantId: "acme", subject: "Weekly" },
      }),
    );
    expect(await database.db.select().from(reportsOutboxTable)).toContainEqual(
      expect.objectContaining({ outboxId: "ship-realtime.publication", status: "completed" }),
    );
  });

  it("accepts a signed Stripe event only after the raw bytes and intent are committed", async () => {
    const { application, http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const body = '{"id":"evt_golden_1","type":"invoice.paid","data":{"object":{"amount":1200}}}';
    const signature = await stripeSignatureHeader({ secret: stripeSecret, rawBody: body });
    const deliver = () =>
      http.request("/webhooks/stripe", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body,
      });

    const first = await deliver();
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { accepted: boolean; eventId: string };
    const [event] = await database.db.select().from(webhookEventsTable);
    expect(event).toMatchObject({
      id: accepted.eventId,
      webhookId: "payments.stripe-webhook",
      provider: "stripe",
      providerEventId: "evt_golden_1",
    });
    expect(Buffer.from(event?.body as Uint8Array).toString("utf8")).toBe(body);
    expect(event?.headers).not.toHaveProperty("stripe-signature");
    const intents = await database.db
      .select()
      .from(reportsOutboxTable)
      .where(sql`${reportsOutboxTable.outboxId} = 'payments.outbox'`);
    expect(intents).toMatchObject([{ intentId: "process-webhook", status: "pending" }]);
    expect(record).not.toHaveBeenCalled();

    // A retried delivery replays the stored acknowledgement without a second event.
    const duplicate = await deliver();
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toEqual(accepted);
    expect(await database.db.select().from(webhookEventsTable)).toHaveLength(1);

    // Tampered bytes never reach the handler and never echo the body.
    const tampered = await http.request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: body.replace("1200", "12"),
    });
    expect(tampered.status).toBe(401);
    const text = await tampered.text();
    expect(text).not.toContain("invoice.paid");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "WEBHOOK_VERIFICATION_FAILED" } });

    const executor = createExecutor(application);
    await expect(
      executor.run("payments.outbox.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(record).toHaveBeenCalledWith({ eventId: accepted.eventId, provider: "stripe" });

    // Replay is mounted through the adapter on the legacy route whose :id
    // segment carries the event id: the operator session re-enqueues by id.
    const replayRequest = (token: string) =>
      http.request(`/webhooks/${accepted.eventId}/retry`, {
        method: "POST",
        headers: { authorization: `ShipSession ${token}` },
      });
    const forbidden = await replayRequest("analyst-token");
    expect(forbidden.status).toBe(403);
    const replayed = await replayRequest("operator-token");
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      eventId: accepted.eventId,
      webhookId: "payments.stripe-webhook",
      queued: true,
    });
    const missing = await http.request("/webhooks/00000000-0000-4000-8000-000000000000/retry", {
      method: "POST",
      headers: { authorization: "ShipSession operator-token" },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_EVENT_NOT_FOUND" },
    });
    await expect(
      executor.run("payments.outbox.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { completed: 1 } });
    expect(record).toHaveBeenCalledTimes(2);

    // Retention removes the dispatched event and its expired claim once the window passes.
    clock.offsetMs = 40 * 24 * 60 * 60 * 1000;
    await database.db
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(sql`${idempotencyKeys.key} like 'payments.stripe-webhook:%'`);
    await expect(
      executor.run("payments.webhook-cleanup", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { eventsDeleted: 1, claimsDeleted: 1 } });
    expect(await database.db.select().from(webhookEventsTable)).toHaveLength(0);
  });

  it("verifies an inbound Twilio SMS against the public URL, not the proxied host", async () => {
    const { http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const form = "From=%2B15550001111&To=%2B15550002222&Body=Hello&MessageSid=SM1";
    const signature = await twilioSignatureHeader({
      authToken: twilioToken,
      url: "https://golden.example.test/webhooks/twilio/sms",
      rawBody: form,
    });
    const deliver = (headers: Record<string, string>, body = form) =>
      http.request("http://internal-ingress:8080/webhooks/twilio/sms", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signature,
          "x-forwarded-host": "internal-ingress",
          ...headers,
        },
        body,
      });

    // Twilio executes the reply: it must be exactly 200 text/xml carrying the TwiML.
    const accepted = await deliver({});
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("content-type")).toBe("text/xml");
    await expect(accepted.text()).resolves.toBe(INBOUND_SMS_TWIML);
    const replayed = await deliver({});
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("content-type")).toBe("text/xml");
    await expect(replayed.text()).resolves.toBe(INBOUND_SMS_TWIML);
    const forged = await deliver({}, `${form}&Body=Pwned`);
    expect(forged.status).toBe(401);
    expect(forged.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    const unsigned = await deliver({ "x-twilio-signature": "" });
    expect(unsigned.status).toBe(401);
  });

  it("acknowledges a Twilio status callback with a bodiless 200", async () => {
    const { http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const form = "MessageSid=SM2&MessageStatus=delivered";
    const signature = await twilioSignatureHeader({
      authToken: twilioToken,
      url: "https://golden.example.test/webhooks/twilio/sms-status",
      rawBody: form,
    });
    const response = await http.request("/webhooks/twilio/sms-status", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: form,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await expect(response.text()).resolves.toBe("");
  });

  it("runs the enqueued delivery job against PostgreSQL: one request row and one intent per period", async () => {
    const { application } = createCustomizedHttpApplication(infrastructure(), sessions);
    const executor = createExecutor(application);
    const input = { tenantId: "acme", period: "2026-09-18" };

    const first = await runJobOnce(application, "reports.deliver", input, { executor });
    const again = await runJobOnce(application, "reports.deliver", input, { executor });

    expect(first).toMatchObject({ ok: true, data: { queued: true } });
    expect(again).toMatchObject({ ok: true, data: { queued: false } });
    const requests = await database.db.select().from(reportRequests);
    expect(requests.filter((row) => row.subject === "Digest for 2026-09-18")).toHaveLength(2);
    const intents = await database.db.select().from(reportsOutboxTable);
    expect(intents.filter((row) => row.dedupeKey === "digest:acme:2026-09-18")).toHaveLength(1);
    await expect(
      executor.run("reports.outbox.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { completed: 1 } });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Digest for 2026-09-18" }),
    );
  });
});

describe("customized managed storage against PostgreSQL", () => {
  let database: PostgresTestDb<typeof portfolioSchema>;
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  const storage = createInMemoryStorageAdapter({ now: () => clock.now() });
  const projectId = acmeProjectId;

  beforeAll(async () => {
    database = await setupPostgresTestDb(portfolioSchema);
  });

  afterAll(async () => {
    await database.cleanup();
  });

  function build() {
    const infrastructure = {
      unitOfWork: createPortfolioUnitOfWork(database.db),
      notifier: { adapter: "recording", send: vi.fn(async () => undefined) } as ReportNotifier,
      outbox: createReportsOutbox(database.db),
      idempotency: createIdempotencyStore(database.db),
      cache: createInMemoryCacheBackend(),
      cacheOutbox: createCacheInvalidationOutbox(database.db),
      realtime: createInMemoryRealtimeBackend({ channels: publishedChannels }),
      realtimeOutbox: createRealtimePublicationOutbox(database.db),
      paymentSink: {
        adapter: "recording",
        record: vi.fn(async () => undefined),
      } as PaymentEventSink,
      paymentsOutbox: createPaymentsOutbox(database.db),
      webhookEvents: createWebhookEventStore(database.db),
      webhookSecrets: { stripe: webhookSecret("whsec_x"), twilio: webhookSecret("twilio") },
      clock: clock.now,
      jobs: createInMemoryJobBackend(),
      locks: createInMemoryLockProvider(),
      storage,
      attachmentLedger: createAttachmentLedger(database.db),
      purgeOutbox: createStoragePurgeOutbox(database.db),
      unattachedGraceMs: 60_000,
      scheduledTenants: ["acme"],
    };
    const { application, http } = createCustomizedHttpApplication(infrastructure, sessions);
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
      projectClientContract(application),
      {
        baseUrl: "https://golden.example.test",
        headers: { authorization: "ShipSession publisher-token" },
        fetch: async (input, init) => http.request(input, init),
      },
    );
    return { application, http, client, infrastructure };
  }

  it("commits the detachment and the purge intent together, then deletes the object on dispatch", async () => {
    const { application, client } = build();
    const bytes = new TextEncoder().encode("png-bytes");
    const intent = await client.call("ship-storage.create-intent", {
      body: { attachment: "portfolio.photo", contentType: "image/png", size: bytes.byteLength },
    });
    expect(intent).toMatchObject({ ok: true, status: 201 });
    if (!intent.ok) throw new Error("intent failed");
    expect(await storage.upload(intent.data.upload.url, bytes, intent.data.upload.headers)).toBe(
      200,
    );
    const complete = await client.call("ship-storage.complete", {
      params: { intentId: intent.data.intentId },
    });
    expect(complete).toMatchObject({ ok: true, status: 200 });
    if (!complete.ok) throw new Error("completion failed");
    expect(await database.db.select().from(storageObjects)).toMatchObject([
      { id: complete.data.objectId, status: "uploaded", attachmentId: "portfolio.photo" },
    ]);

    const attached = await client.call("portfolio.attach-photo", {
      params: { tenantId: "acme", projectId },
      body: { objectId: complete.data.objectId },
    });
    expect(attached).toMatchObject({ ok: true, status: 201, data: { count: 1 } });
    expect(await database.db.select().from(storageObjects)).toMatchObject([
      { status: "attached", ownerId: `acme/${projectId}` },
    ]);

    const removed = await client.call("portfolio.remove-photo", {
      params: { tenantId: "acme", projectId, objectId: complete.data.objectId },
    });
    expect(removed).toMatchObject({ ok: true, data: { removed: true } });
    const purgeRows = await database.db.select().from(storagePurges);
    expect(purgeRows).toMatchObject([{ objectId: complete.data.objectId, purgedAt: null }]);
    const purgeIntents = (await database.db.select().from(reportsOutboxTable)).filter(
      (row) => row.outboxId === "ship-storage.purge",
    );
    expect(purgeIntents).toMatchObject([
      {
        intentId: "purge-object",
        status: "pending",
        payload: { objectId: complete.data.objectId },
      },
    ]);
    expect(storage.keys()).toEqual([intent.data.objectKey]);

    const executor = createExecutor(application);
    await expect(
      executor.run("ship-storage.purge.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(storage.keys()).toEqual([]);
    expect(await database.db.select().from(storagePurges)).toMatchObject([
      { objectId: complete.data.objectId, attempts: 1 },
    ]);
    expect((await database.db.select().from(storagePurges))[0]?.purgedAt).not.toBeNull();
    // A replayed dispatch finds nothing to claim and the purge row unchanged.
    await expect(
      executor.run("ship-storage.purge.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { claimed: 0 } });
  });

  it("abandons an induced orphan intent on sweep and fences its late completion", async () => {
    const { application, client } = build();
    const intent = await client.call("ship-storage.create-intent", {
      body: { attachment: "portfolio.photo", contentType: "image/webp", size: 4 },
    });
    if (!intent.ok) throw new Error("intent failed");
    expect(
      await storage.upload(
        intent.data.upload.url,
        new TextEncoder().encode("webp"),
        intent.data.upload.headers,
      ),
    ).toBe(200);
    clock.offsetMs += 16 * 60_000;
    const executor = createExecutor(application);
    await expect(
      runJobOnce(application, "ship-storage.sweep", {}, { executor }),
    ).resolves.toMatchObject({ ok: true, data: { abandoned: 1 } });
    expect(await database.db.select().from(storageIntents)).toContainEqual(
      expect.objectContaining({ id: intent.data.intentId, status: "abandoned" }),
    );
    expect(storage.keys()).not.toContain(intent.data.objectKey);
    const late = await client.call("ship-storage.complete", {
      params: { intentId: intent.data.intentId },
    });
    expect(late).toMatchObject({ ok: false, status: 410, error: { code: "INTENT_EXPIRED" } });
    clock.offsetMs = 0;
  });
});
