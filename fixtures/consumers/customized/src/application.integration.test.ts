import {
  createRequestClientRegistry,
  totpCode,
  totpStep,
} from "@sixthsummit/ship-auth-credentials";
import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import { projectClientContract } from "@sixthsummit/ship-contract/project";
import {
  createExecutor,
  createExecutor as createRuntimeExecutor,
  startJobRuntime,
  systemActor,
  webhookSecret,
} from "@sixthsummit/ship-core";
import { logMailProvider } from "@sixthsummit/ship-mail";
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
  createCredentialStore,
  createIdempotencyStore,
  createJobBackend,
  createMailLedger,
  createPaymentsOutbox,
  createPortfolioUnitOfWork,
  createRealtimePublicationOutbox,
  createReportsOutbox,
  createStoragePurgeOutbox,
  createWebhookEventStore,
} from "./repository.js";
import {
  authAuditEvents,
  authSessions,
  documents,
  idempotencyKeys,
  mailSendsTable,
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
    if (token === "sre-token") {
      return { actorId: "sre", role: "sre", tenants: [] };
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
  const mailProvider = logMailProvider();
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
    mailProvider,
    mailLedger: createMailLedger(database.db),
    scheduledTenants: ["acme"],
    credentialStore: createCredentialStore(database.db),
    authClients: createRequestClientRegistry(),
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

  it("retries a dead-lettered PostgreSQL job run and replays a receipt from the console over HTTP", async () => {
    const jobs = createJobBackend(database.db, { pollIntervalMs: 25 });
    const { application, http } = createCustomizedHttpApplication(
      { ...infrastructure(), jobs, locks: jobs.lockProvider },
      sessions,
    );
    const runtime = await startJobRuntime(application, { backend: jobs, mode: "worker" });
    try {
      // "gamma" is not an enrolled tenant: the declared failure is final and dead-letters at once.
      const accepted = await jobs.enqueue("reports.deliver", {
        tenantId: "gamma",
        period: "2026-10-22",
      });
      if (!accepted.accepted) throw new Error("rejected");
      const failedRuns = () =>
        http.request("/console/jobs/runs?status=failed&jobId=reports.deliver", {
          headers: { authorization: "ShipSession sre-token" },
        });
      const deadline = Date.now() + 15_000;
      let listed: { runs: { runId: string; attempts: number }[] } = { runs: [] };
      while (listed.runs.length === 0 && Date.now() < deadline) {
        listed = (await (await failedRuns()).json()) as typeof listed;
        if (listed.runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(listed.runs).toMatchObject([{ runId: accepted.runId, attempts: 1 }]);

      // The operator role (replay + read) is refused; only the SRE role holds console.operate.
      const refused = await http.request("/console/jobs/retry", {
        method: "POST",
        headers: {
          authorization: "ShipSession operator-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ runId: accepted.runId }),
      });
      expect(refused.status).toBe(403);
      const retried = await http.request("/console/jobs/retry", {
        method: "POST",
        headers: { authorization: "ShipSession sre-token", "content-type": "application/json" },
        body: JSON.stringify({ runId: accepted.runId }),
      });
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({ run: { status: "waiting" } });
      let again: { runs: { attempts: number }[] } = { runs: [] };
      const retryDeadline = Date.now() + 15_000;
      while ((again.runs[0]?.attempts ?? 0) < 2 && Date.now() < retryDeadline) {
        again = (await (await failedRuns()).json()) as typeof again;
        if ((again.runs[0]?.attempts ?? 0) < 2)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(again.runs[0]?.attempts).toBe(2);

      // Durable pause through the control table, then resume.
      const paused = await http.request("/console/jobs/pause", {
        method: "POST",
        headers: { authorization: "ShipSession sre-token", "content-type": "application/json" },
        body: JSON.stringify({ jobId: "reports.deliver" }),
      });
      expect(paused.status).toBe(200);
      const overview = await http.request("/console/jobs", {
        headers: { authorization: "ShipSession sre-token" },
      });
      await expect(overview.json()).resolves.toMatchObject({
        capabilities: { adapter: "drizzle", pause: true },
        jobs: expect.arrayContaining([
          expect.objectContaining({ jobId: "reports.deliver", paused: true, failed: 1 }),
        ]),
      });
      await http.request("/console/jobs/resume", {
        method: "POST",
        headers: { authorization: "ShipSession sre-token", "content-type": "application/json" },
        body: JSON.stringify({ jobId: "reports.deliver" }),
      });

      // A stored Stripe receipt is listed with its spawned record and replayed by the SRE.
      const body = '{"id":"evt_console_1","type":"invoice.paid","data":{"object":{"amount":5}}}';
      const signature = await stripeSignatureHeader({ secret: stripeSecret, rawBody: body });
      const delivered = await http.request("/webhooks/stripe", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body,
      });
      const { eventId } = (await delivered.json()) as { eventId: string };
      const executor = createRuntimeExecutor(application);
      await executor.run("payments.outbox.dispatch", {}, { actor: systemActor({ id: "worker" }) });
      const receipts = await http.request(
        "/console/webhooks/receipts?webhookId=payments.stripe-webhook&limit=10",
        { headers: { authorization: "ShipSession sre-token" } },
      );
      expect(receipts.status).toBe(200);
      await expect(receipts.json()).resolves.toMatchObject({
        capabilities: { list: true, dispatch: true },
        receipts: [
          {
            eventId,
            providerEventId: "evt_console_1",
            verification: "verified",
            dispatch: { outboxId: "payments.outbox", status: "completed" },
          },
        ],
      });
      const replayed = await http.request(`/console/webhooks/receipts/${eventId}/replay`, {
        method: "POST",
        headers: { authorization: "ShipSession sre-token" },
      });
      expect(replayed.status).toBe(200);
      await expect(replayed.json()).resolves.toMatchObject({ eventId, queued: true });
      const forbidden = await http.request(`/console/webhooks/receipts/${eventId}/replay`, {
        method: "POST",
        headers: { authorization: "ShipSession operator-token" },
      });
      expect(forbidden.status).toBe(403);
      const records = await http.request(
        "/console/outbox/records?outboxId=payments.outbox&status=pending",
        { headers: { authorization: "ShipSession sre-token" } },
      );
      await expect(records.json()).resolves.toMatchObject({
        records: [{ intentId: "process-webhook", status: "pending" }],
      });
    } finally {
      await runtime.stop();
    }
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
  it("sends transactional mail once per idempotency key with one ledger row and one provider call", async () => {
    const infra = infrastructure();
    const { application, http } = createCustomizedHttpApplication(infra, sessions);
    await startJobRuntime(application, { backend: infra.jobs, mode: "api" });
    const executor = createExecutor(application);
    const post = () =>
      http.request("/tenants/acme/report-emails", {
        method: "POST",
        headers: {
          authorization: "ShipSession publisher-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          recipient: "owner@real-customer.example",
          period: "2026-09-18",
          projectCount: 2,
        }),
      });
    const first = await post();
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ accepted: true, deduplicated: false });
    await expect((await post()).json()).resolves.toMatchObject({ deduplicated: true });

    await expect(infra.jobs.drain()).resolves.toEqual({ executed: 1, completed: 1, failed: 0 });
    const replay = await runJobOnce(application, "mail.deliver", infra.jobs.runs()[0]?.input, {
      executor,
    });
    expect(replay).toMatchObject({ ok: true, data: { status: "duplicate", attempt: 1 } });
    // A later send with the same key enqueues again (the first run is terminal) and is
    // still answered from the ledger.
    await expect((await post()).json()).resolves.toMatchObject({ deduplicated: false });
    await expect(infra.jobs.drain()).resolves.toEqual({ executed: 1, completed: 1, failed: 0 });

    expect(mailProvider.sent()).toHaveLength(1);
    expect(mailProvider.sent()[0]?.envelope.subject).toBe("Portfolio digest for 2026-09-18");
    const rows = await database.db.select().from(mailSendsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idempotencyKey: "digest-email:acme:2026-09-18:owner@real-customer.example",
      mailerId: "reports.mailer",
      message: "digestReady",
      recipients: ["owner@real-customer.example"],
      status: "sent",
      attempts: 1,
      provider: "log",
      tenantId: "acme",
    });
    await expect(
      infra.mailLedger.list({ recipient: "owner@real-customer.example", limit: 10 }),
    ).resolves.toHaveLength(1);
  });
});

describe("customized credential auth against PostgreSQL", () => {
  let database: PostgresTestDb<typeof portfolioSchema>;
  const mailProvider = logMailProvider();
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };

  beforeAll(async () => {
    database = await setupPostgresTestDb(portfolioSchema);
  });

  afterAll(async () => {
    await database.cleanup();
  });

  it("runs register, verify, sign-in, TOTP, recovery, revoke-all and the console audit panel on the auth tables", async () => {
    const store = createCredentialStore(database.db);
    const infra = {
      unitOfWork: createPortfolioUnitOfWork(database.db),
      notifier: { adapter: "recording", send: vi.fn(async () => undefined) },
      outbox: createReportsOutbox(database.db),
      idempotency: createIdempotencyStore(database.db),
      cache: createInMemoryCacheBackend(),
      cacheOutbox: createCacheInvalidationOutbox(database.db),
      realtime: createInMemoryRealtimeBackend({ channels: publishedChannels }),
      realtimeOutbox: createRealtimePublicationOutbox(database.db),
      paymentSink: { adapter: "recording", record: vi.fn(async () => undefined) },
      paymentsOutbox: createPaymentsOutbox(database.db),
      webhookEvents: createWebhookEventStore(database.db),
      webhookSecrets: { stripe: webhookSecret("whsec_x"), twilio: webhookSecret("twilio-x") },
      clock: clock.now,
      jobs: createInMemoryJobBackend(),
      locks: createInMemoryLockProvider(),
      storage: createInMemoryStorageAdapter({ now: () => clock.now() }),
      attachmentLedger: createAttachmentLedger(database.db),
      purgeOutbox: createStoragePurgeOutbox(database.db),
      mailProvider,
      mailLedger: createMailLedger(database.db),
      credentialStore: store,
      authClients: createRequestClientRegistry(),
    };
    const { application, http } = createCustomizedHttpApplication(infra, sessions);
    await startJobRuntime(application, { backend: infra.jobs, mode: "api" });
    const post = async (path: string, body: unknown, token?: string) => {
      const response = await http.request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.4",
          "user-agent": "golden/1.0",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON bodies
      const json: any = response.headers.get("content-type")?.includes("json")
        ? await response.json()
        : undefined;
      return { status: response.status, body: json };
    };
    const password = "correct horse battery staple";

    expect((await post("/auth/register", { email: "ada@example.test", password })).status).toBe(
      201,
    );
    await expect(infra.jobs.drain()).resolves.toMatchObject({ completed: 1, failed: 0 });
    const verifyUrl =
      /https:\/\/\S+/u.exec(mailProvider.sent().at(-1)?.envelope.text ?? "")?.[0] ?? "";
    expect(
      (await post("/auth/verify-email", { token: verifyUrl.slice(verifyUrl.lastIndexOf("/") + 1) }))
        .status,
    ).toBe(200);
    const signedIn = await post("/auth/sign-in", { email: "ada@example.test", password });
    expect(signedIn.body).toMatchObject({ status: "signed-in", session: { mfaState: "none" } });
    const token = signedIn.body.session.token as string;
    const sessionRows = await database.db.select().from(authSessions);
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toMatchObject({
      ip: "198.51.100.4",
      userAgent: "golden/1.0",
      mfaState: "none",
    });
    expect(sessionRows[0]?.tokenHash).not.toContain("ship_s_");

    // TOTP enrolment and a challenged sign-in, with the replay guard on the stored step.
    const enrol = await post("/auth/totp/enrol", { password }, token);
    const confirm = await post(
      "/auth/totp/confirm",
      { code: totpCode(enrol.body.secret, totpStep(clock.now())) },
      token,
    );
    expect(confirm.status).toBe(200);
    clock.offsetMs += 60_000;
    const challenged = await post("/auth/sign-in", { email: "ada@example.test", password });
    expect(challenged.body.status).toBe("mfa-required");
    const code = totpCode(enrol.body.secret, totpStep(clock.now()));
    const verified = await post("/auth/totp/verify", {
      challenge: challenged.body.challenge.token,
      code,
    });
    expect(verified.body.status).toBe("signed-in");
    const again = await post("/auth/sign-in", { email: "ada@example.test", password });
    expect(
      (await post("/auth/totp/verify", { challenge: again.body.challenge.token, code })).status,
    ).toBe(401);
    const recovered = await post("/auth/recovery/consume", {
      challenge: again.body.challenge.token,
      code: confirm.body.recoveryCodes[0],
    });
    expect(recovered.body).toMatchObject({ status: "signed-in", recoveryCodesRemaining: 9 });

    // A browser signs in over the session cookie beside the bearer sessions.
    clock.offsetMs += 60_000;
    const cookieChallenge = await post("/auth/sign-in", { email: "ada@example.test", password });
    const cookieSignIn = await http.request("/auth/totp/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://portfolio.golden.test",
      },
      body: JSON.stringify({
        challenge: cookieChallenge.body.challenge.token,
        code: totpCode(enrol.body.secret, totpStep(clock.now())),
        transport: "cookie",
      }),
    });
    expect(cookieSignIn.status).toBe(200);
    const cookieBody = await cookieSignIn.json();
    expect(cookieBody.session).toMatchObject({ transport: "cookie", mfaState: "verified" });
    const cookieHeader = cookieSignIn.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    expect(cookieHeader).toMatch(/^ship_session=ship_s_[^;]+; ship_csrf=/u);
    const meViaCookie = await http.request("/auth/me", { headers: { cookie: cookieHeader } });
    expect(meViaCookie.status).toBe(200);
    expect((await meViaCookie.json()).session.id).toBe(cookieBody.session.id);

    // Revoke-all from one session invalidates every bearer and the cookie on the next request.
    expect((await post("/auth/sessions/revoke-all", {}, verified.body.session.token)).body).toEqual(
      { revoked: 4 },
    );
    for (const bearer of [token, verified.body.session.token, recovered.body.session.token]) {
      expect(
        (await http.request("/auth/me", { headers: { authorization: `Bearer ${bearer}` } })).status,
      ).toBe(401);
    }
    expect((await http.request("/auth/me", { headers: { cookie: cookieHeader } })).status).toBe(
      401,
    );

    // The audit rows are PostgreSQL rows and the console panel reads them behind console.operate.
    const rows = await database.db.select().from(authAuditEvents);
    expect(rows.map((row) => row.event)).toEqual(
      expect.arrayContaining([
        "register",
        "email.verify",
        "sign-in",
        "mfa.enrolled",
        "mfa.challenged",
        "mfa.verify",
        "mfa.recover",
        "sessions.revoke-all",
      ]),
    );
    for (const row of rows) expect(JSON.stringify(row)).not.toContain("ship_");
    const refused = await http.request("/console/auth-audit/events", {
      headers: { authorization: "ShipSession operator-token" },
    });
    expect(refused.status).toBe(403);
    const panel = await http.request(
      "/console/auth-audit/events?email=ada@example.test&event=mfa.recover",
      {
        headers: { authorization: "ShipSession sre-token" },
      },
    );
    expect(panel.status).toBe(200);
    await expect(panel.json()).resolves.toMatchObject({
      events: [{ event: "mfa.recover", outcome: "success" }],
    });
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
      mailProvider: logMailProvider(),
      mailLedger: createMailLedger(database.db),
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

describe("customized rich text documents against PostgreSQL", () => {
  let database: PostgresTestDb<typeof portfolioSchema>;
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  const storage = createInMemoryStorageAdapter({ now: () => clock.now() });
  const documentId = "66666666-6666-4666-8666-666666666666";

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
      mailProvider: logMailProvider(),
      mailLedger: createMailLedger(database.db),
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
    return { application, http, client };
  }

  it("keeps an embedded image exactly as long as the owning document", async () => {
    const { application, client } = build();
    const bytes = new TextEncoder().encode("png-bytes");
    const intent = await client.call("ship-storage.create-intent", {
      body: {
        attachment: "portfolio.document-image",
        contentType: "image/png",
        size: bytes.byteLength,
      },
    });
    if (!intent.ok) throw new Error("intent failed");
    expect(await storage.upload(intent.data.upload.url, bytes, intent.data.upload.headers)).toBe(
      200,
    );
    const complete = await client.call("ship-storage.complete", {
      params: { intentId: intent.data.intentId },
    });
    if (!complete.ok) throw new Error("completion failed");
    const objectId = complete.data.objectId;

    const document = {
      schemaVersion: 1,
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Dear " },
            { type: "mergeField", attrs: { key: "client.name" } },
          ],
        },
        { type: "attachment", attrs: { objectId, alt: "Site plan" } },
      ],
    };
    const saved = await client.call("portfolio.save-document", {
      params: { tenantId: "acme", documentId },
      body: { title: "Engagement letter", document },
    });
    expect(saved).toMatchObject({
      ok: true,
      status: 200,
      data: { text: "Dear {{client.name}}\nSite plan", attached: [objectId], detached: [] },
    });
    // The row holds the document model and the text projection; the object is attached to it.
    expect(await database.db.select().from(documents)).toMatchObject([
      {
        id: documentId,
        tenantId: "acme",
        body: document,
        bodyText: "Dear {{client.name}}\nSite plan",
      },
    ]);
    expect(await database.db.select().from(storageObjects)).toContainEqual(
      expect.objectContaining({
        id: objectId,
        status: "attached",
        ownerId: `acme/document/${documentId}`,
      }),
    );
    const read = await client.call("portfolio.document", {
      params: { tenantId: "acme", documentId },
    });
    expect(read).toMatchObject({ ok: true, data: { attachments: [objectId] } });
    if (!read.ok) throw new Error("read failed");
    expect(read.data.html).toContain('<figure class="ship-attachment"><img src="');
    expect(read.data.html).toContain('data-key="client.name"');

    // A save that fails validation changes nothing: the row and the attachment stay.
    const refused = await client.call("portfolio.save-document", {
      params: { tenantId: "acme", documentId },
      body: {
        title: "Engagement letter",
        document: { ...document, content: [{ type: "iframe" }] },
      },
    });
    expect(refused).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_ERROR" } });
    expect(await database.db.select().from(storagePurges)).toEqual([]);

    // Deleting the document commits the row deletion and the purge intent together.
    const deleted = await client.call("portfolio.delete-document", {
      params: { tenantId: "acme", documentId },
    });
    expect(deleted).toMatchObject({ ok: true, data: { deleted: true, purging: [objectId] } });
    expect(await database.db.select().from(documents)).toEqual([]);
    expect(await database.db.select().from(storageObjects)).toContainEqual(
      expect.objectContaining({ id: objectId, status: "purging" }),
    );
    expect(await database.db.select().from(storagePurges)).toMatchObject([
      { objectId, purgedAt: null },
    ]);
    expect(storage.keys()).toContain(intent.data.objectKey);
    const executor = createExecutor(application);
    await expect(
      executor.run("ship-storage.purge.dispatch", {}, { actor: systemActor({ id: "worker" }) }),
    ).resolves.toMatchObject({ ok: true, data: { completed: 1 } });
    expect(storage.keys()).not.toContain(intent.data.objectKey);
    expect((await database.db.select().from(storagePurges))[0]?.purgedAt).not.toBeNull();
    // The deleted document renders nothing and the object cannot be reused.
    expect(
      await client.call("portfolio.document", { params: { tenantId: "acme", documentId } }),
    ).toMatchObject({ ok: false, status: 404, error: { code: "DOCUMENT_NOT_FOUND" } });
    expect(
      await client.call("portfolio.save-document", {
        params: { tenantId: "acme", documentId },
        body: { title: "Again", document },
      }),
    ).toMatchObject({ ok: false, status: 422, error: { code: "DOCUMENT_INVALID" } });
  });
});
