import type { UnitOfWork } from "@sixthsummit/ship-core";
import {
  createExecutor,
  defineActorResolver,
  defineApp,
  defineChannel,
  defineJob,
  defineModule,
  defineOperation,
  defineOutbox,
  defineOutboxDispatcher,
  defineWebhook,
  effectDependency,
  idempotencyStoreDependency,
  JOBS_MANAGE_PERMISSION,
  jobBackendDependency,
  OUTBOX_MANAGE_PERMISSION,
  operationActor,
  outboxIntent,
  permission,
  startJobRuntime,
  unitOfWorkDependency,
  valueProvider,
  WEBHOOK_REPLAY_PERMISSION,
  webhookEventStoreDependency,
  webhookIntent,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, defineHonoCredentialAdapter } from "@sixthsummit/ship-hono";
import {
  createInMemoryIdempotencyStore,
  createInMemoryJobBackend,
  createInMemoryOutbox,
  createInMemoryRealtimeBackend,
  createInMemoryWebhookEventStore,
  fakeWebhookProvider,
} from "@sixthsummit/ship-testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InvalidConsoleDefinitionError } from "./errors.js";
import { defineConsoleModule } from "./module.js";
import { CONSOLE_OPERATE_PERMISSION, consoleAccess } from "./permission.js";
import { createConsoleWebhookObserver } from "./webhooks.js";

// ---------------------------------------------------------------------------
// Fixture application: one job that fails, one scheduled job, one enqueue-mode
// webhook with its outbox, one realtime channel.
// ---------------------------------------------------------------------------

const unitOfWork = unitOfWorkDependency<Record<string, never>>("database.primary");
const idempotency = idempotencyStoreDependency("platform.idempotency");
const webhookEvents = webhookEventStoreDependency("platform.webhook-events");
const sink = effectDependency<{ record(event: { eventId: string }): Promise<void> }>(
  "payments.sink",
  { delivery: "immediate" },
);
const notifier = effectDependency<{ send(message: unknown): Promise<void> }>("reports.notifier", {
  delivery: "immediate",
});

const paymentsOutbox = defineOutbox({
  id: "payments.outbox",
  retention: { completedMs: 1_000, deadLetteredMs: 1_000 },
  intents: {
    "process-webhook": webhookIntent({
      effect: sink,
      perform: ({ effect, event }) => effect.record({ eventId: event.eventId }),
    }),
  },
});
const reportsOutbox = defineOutbox({
  id: "reports.outbox",
  retention: { completedMs: 1_000, deadLetteredMs: 1_000 },
  intents: {
    notify: outboxIntent({
      payload: z.object({ recipient: z.string() }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});

const activity = defineChannel({
  id: "reports.activity",
  scope: "actor",
  payload: z.object({ count: z.number() }),
});

const provider = fakeWebhookProvider({ id: "fake-provider" });
const stripeLike = defineWebhook({
  id: "payments.webhook",
  path: "/webhooks/fake",
  provider: webhookVerifierToken({ verifier: provider.verifier, secret: webhookSecret("s3cret") }),
  body: { maxBytes: 65_536, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 60_000, store: idempotency, inFlight: { kind: "retry", status: 409 } },
  retention: { eventsMs: 60_000, claimsMs: 60_000 },
  receive: {
    mode: "enqueue",
    outbox: paymentsOutbox,
    intent: "process-webhook",
    store: webhookEvents,
    unitOfWork,
  },
});

const render = defineJob({
  id: "reports.render",
  input: z.object({ tenantId: z.string() }),
  trigger: { kind: "enqueue" },
  concurrency: { mode: "parallel", max: 2 },
  retry: { attempts: 1, backoff: { initialMs: 1 } },
  transaction: "none",
  dependencies: {},
  handler: async ({ input }) => {
    if (input.tenantId === "boom") throw new Error("render exploded");
    return { rendered: input.tenantId };
  },
});
const digest = defineJob({
  id: "reports.digest",
  input: z.object({}),
  trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
  concurrency: { mode: "parallel", max: 1 },
  retry: { attempts: 1, backoff: { initialMs: 1 } },
  transaction: "none",
  dependencies: {},
  handler: async () => ({ ok: true }),
});

function fixtureUnitOfWork(): UnitOfWork<Record<string, never>> {
  return {
    kind: "ship.unit-of-work",
    id: "database.primary",
    run: async (_mode, work) => work({}),
  };
}

function fixture(
  options: { readonly observer?: ReturnType<typeof createConsoleWebhookObserver> } = {},
) {
  const clock = () => new Date("2026-10-22T12:00:00.000Z");
  const jobs = createInMemoryJobBackend({ clock: () => new Date() });
  const payments = createInMemoryOutbox(paymentsOutbox);
  const reports = createInMemoryOutbox(reportsOutbox);
  const events = createInMemoryWebhookEventStore({ outbox: payments });
  const realtime = createInMemoryRealtimeBackend({ channels: [activity] });
  const reportsModule = defineModule({
    id: "reports",
    operations: [render, digest],
    providers: [
      valueProvider(unitOfWork, fixtureUnitOfWork()),
      valueProvider(jobBackendDependency(), jobs),
      valueProvider(reportsOutbox.writer, reports),
      valueProvider(notifier, { send: vi.fn(async () => undefined) }),
    ],
    imports: [],
    exports: [unitOfWork, jobBackendDependency(), reportsOutbox.writer],
    channels: [activity],
  });
  const paymentsDispatcher = defineOutboxDispatcher(paymentsOutbox, {
    batchSize: 10,
    lease: { ms: 1_000 },
    retry: { attempts: 2, backoff: { initialMs: 1 } },
    deadLetter: true,
  });
  const paymentsModule = defineModule({
    id: "payments",
    operations: [stripeLike.operation, ...paymentsDispatcher.operations],
    providers: [
      valueProvider(paymentsOutbox.writer, payments),
      valueProvider(webhookEvents, events),
      valueProvider(idempotency, createInMemoryIdempotencyStore()),
      valueProvider(sink, { record: vi.fn(async () => undefined) }),
    ],
    imports: ["reports"],
    exports: [paymentsOutbox.writer, webhookEvents],
  });
  const audit = defineOperation({
    id: "console.auth-audit.events",
    input: {},
    output: { 200: z.object({ events: z.array(z.string()) }) },
    successStatus: 200,
    errors: [],
    access: consoleAccess(),
    transaction: "none",
    dependencies: {},
    handler: () => ({ events: ["login"] }),
  });
  const console = defineConsoleModule({
    imports: ["reports", "payments"],
    jobs: true,
    outboxes: [reportsOutbox, paymentsOutbox],
    webhooks: {
      webhooks: [stripeLike],
      store: webhookEvents,
      unitOfWork,
      ...(options.observer ? { observer: options.observer } : {}),
    },
    realtime: { backend: realtime, channels: [activity] },
    extensions: [{ id: "auth-audit", title: "Auth audit", operations: [audit] }],
    clock,
  });
  const app = defineApp({
    id: "console-fixture",
    modules: [reportsModule, paymentsModule, console],
    runtime: { workers: { mode: "api" } },
  });
  return { app, console, jobs, payments, reports, events, realtime, executor: createExecutor(app) };
}

const operator = operationActor({ id: "operator", permissions: [CONSOLE_OPERATE_PERMISSION] });
/** Holds every framework management slug an "admin" role usually carries, but not the console one. */
const admin = operationActor({
  id: "admin",
  permissions: [JOBS_MANAGE_PERMISSION, OUTBOX_MANAGE_PERMISSION, WEBHOOK_REPLAY_PERMISSION],
});

async function storeReceipt(fixture: ReturnType<typeof fixture>, eventId: string) {
  await fixture.events.record(
    {},
    {
      id: eventId,
      webhookId: "payments.webhook",
      provider: "fake-provider",
      providerEventId: "evt_1",
      requestId: "req-1",
      receivedAt: new Date("2026-10-22T11:00:00.000Z"),
      contentType: "application/json",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"id":"evt_1"}'),
    },
  );
  const [recorded] = await fixture.payments.record({}, [
    {
      intentId: "process-webhook",
      payload: {
        eventId,
        webhookId: "payments.webhook",
        provider: "fake-provider",
        receivedAt: "2026-10-22T11:00:00.000Z",
      },
      availableAt: new Date("2026-10-22T11:00:00.000Z"),
    },
  ]);
  if (recorded && !recorded.deduplicated) await fixture.events.link({}, eventId, recorded.recordId);
}

describe("defineConsoleModule", () => {
  it("composes every panel as declared operations under one module", () => {
    const { console, app } = fixture();
    expect(console.id).toBe("console");
    expect(console.panels.map((panel) => panel.id)).toEqual([
      "jobs",
      "cron",
      "webhooks",
      "realtime",
      "outbox",
      "auth-audit",
    ]);
    const ids = console.operations.map((operation) => operation.id);
    expect(ids).toContain("console.panels");
    expect(ids).toContain("console.jobs.retry");
    expect(ids).toContain("console.webhooks.replay");
    expect(ids).toContain("console.auth-audit.events");
    for (const operation of console.operations) {
      expect(operation.access).toEqual(permission(CONSOLE_OPERATE_PERMISSION));
    }
    expect(app.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("refuses an admin holding every management slug but not console.operate, on every operation", async () => {
    const { console, executor } = fixture();
    for (const operation of console.operations) {
      const result = await executor.run(operation.id as never, {} as never, { actor: admin });
      expect(result, operation.id).toMatchObject({
        ok: false,
        status: 403,
        error: { code: "AUTHORIZATION_ERROR" },
      });
    }
    await expect(executor.run("console.panels", {}, { actor: operator })).resolves.toMatchObject({
      ok: true,
      data: { id: "console", basePath: "/console", permission: CONSOLE_OPERATE_PERMISSION },
    });
  });

  it("enforces the guard over HTTP as well", async () => {
    const { app } = fixture();
    const http = createHonoAdapter(app, {
      auth: {
        credentials: defineHonoCredentialAdapter({
          id: "http.token",
          extract: (request) => request.headers.get("authorization") ?? undefined,
        }),
        actors: defineActorResolver<string>({
          id: "auth.token",
          resolve: ({ credential }) =>
            credential === "operator"
              ? { ok: true, actor: operator }
              : credential === "admin"
                ? { ok: true, actor: admin }
                : { ok: true },
        }),
      },
      webhooks: { publicBaseUrl: "https://console.example.test" },
    });
    const denied = await http.request("/console/jobs", { headers: { authorization: "admin" } });
    expect(denied.status).toBe(403);
    const anonymous = await http.request("/console/jobs");
    expect(anonymous.status).toBe(401);
    const allowed = await http.request("/console/jobs/runs?limit=5&status=failed", {
      headers: { authorization: "operator" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ runs: [] });
  });

  it("lists, retries, discards, bulk-retries, pauses and resumes jobs", async () => {
    const harness = fixture();
    const { executor, jobs } = harness;
    await startJobRuntime(harness.app, { backend: jobs, mode: "api" });
    await jobs.enqueue("reports.render", { tenantId: "boom" });
    await jobs.enqueue("reports.render", { tenantId: "boom" });
    await jobs.enqueue("reports.render", { tenantId: "acme" });
    await jobs.drain();

    const overview = await executor.run("console.jobs.overview", {}, { actor: operator });
    expect(overview).toMatchObject({
      ok: true,
      data: {
        capabilities: { adapter: "memory", runs: true, schedules: true, pause: true },
        jobs: [
          { jobId: "reports.digest", declared: true, trigger: { kind: "schedule" }, failed: 0 },
          {
            jobId: "reports.render",
            declared: true,
            trigger: { kind: "enqueue" },
            concurrency: { mode: "parallel", max: 2 },
            retryAttempts: 1,
            failed: 2,
            paused: false,
          },
        ],
      },
    });

    const failed = await executor.run(
      "console.jobs.runs",
      { query: { status: "failed", limit: 10 } },
      { actor: operator },
    );
    expect(failed.ok).toBe(true);
    const runs = failed.ok ? failed.data.runs : [];
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("render exploded"),
    });

    const detail = await executor.run(
      "console.jobs.run",
      { query: { runId: runs[0]?.runId ?? "" } },
      { actor: operator },
    );
    expect(detail).toMatchObject({ ok: true, data: { run: { runId: runs[0]?.runId } } });
    await expect(
      executor.run("console.jobs.run", { query: { runId: "missing" } }, { actor: operator }),
    ).resolves.toMatchObject({ ok: false, status: 404, error: { code: "JOB_RUN_NOT_FOUND" } });

    await expect(
      executor.run(
        "console.jobs.retry",
        { body: { runId: runs[0]?.runId ?? "" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({ ok: true, data: { run: { status: "waiting" } } });
    await expect(
      executor.run(
        "console.jobs.discard",
        { body: { runId: runs[1]?.runId ?? "", reason: "stale" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { run: { status: "discarded", discardReason: "stale" } },
    });
    await expect(
      executor.run("console.jobs.retry", { body: { runId: "missing" } }, { actor: operator }),
    ).resolves.toMatchObject({ ok: false, status: 404 });

    await jobs.drain();
    await expect(
      executor.run(
        "console.jobs.retry-all",
        { body: { jobId: "reports.render" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({ ok: true, data: { retried: 1 } });

    await expect(
      executor.run(
        "console.jobs.pause",
        { body: { jobId: "reports.render" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({ ok: true, data: { jobId: "reports.render", paused: true } });
    expect(await jobs.introspection.listPaused()).toEqual(["reports.render"]);
    // A paused job keeps its waiting run; nothing claims it.
    expect((await jobs.drain()).executed).toBe(0);
    await expect(
      executor.run(
        "console.jobs.resume",
        { body: { jobId: "reports.render" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({ ok: true, data: { paused: false } });
    expect((await jobs.drain()).executed).toBe(1);
    await expect(
      executor.run(
        "console.jobs.pause",
        { body: { jobId: "reports.unknown" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({ ok: false, status: 404, error: { code: "CONSOLE_JOB_NOT_FOUND" } });
  });

  it("reports schedules and triggers a scheduled job now", async () => {
    const harness = fixture();
    const { executor, jobs } = harness;
    await startJobRuntime(harness.app, { backend: jobs, mode: "worker" });
    await jobs.quit();
    const schedules = await executor.run("console.cron.schedules", {}, { actor: operator });
    expect(schedules).toMatchObject({
      ok: true,
      data: {
        schedules: [
          {
            jobId: "reports.digest",
            trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
            reconciled: true,
            paused: false,
            nextAt: expect.any(String),
          },
        ],
      },
    });
    await expect(
      executor.run(
        "console.cron.trigger",
        { body: { jobId: "reports.digest" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 202,
      data: { jobId: "reports.digest", deduplicated: false },
    });
    await expect(
      executor.run(
        "console.cron.trigger",
        { body: { jobId: "reports.render" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "CONSOLE_SCHEDULE_NOT_FOUND" },
    });
    expect((await jobs.drain()).completed).toBe(1);
  });

  it("reports a missing introspection capability as a declared 501", async () => {
    const harness = fixture();
    const bare = { ...harness.jobs, introspection: undefined };
    const app = defineApp({
      id: "bare",
      modules: [
        defineModule({
          id: "reports",
          operations: [render],
          providers: [valueProvider(jobBackendDependency(), bare)],
          imports: [],
          exports: [jobBackendDependency()],
        }),
        defineConsoleModule({ imports: ["reports"], jobs: true }),
      ],
    });
    const executor = createExecutor(app);
    await expect(
      executor.run("console.jobs.overview", {}, { actor: operator }),
    ).resolves.toMatchObject({
      ok: true,
      data: { capabilities: { runs: false, schedules: false, pause: false } },
    });
    await expect(
      executor.run("console.jobs.runs", { query: {} }, { actor: operator }),
    ).resolves.toMatchObject({
      ok: false,
      status: 501,
      error: { code: "CONSOLE_CAPABILITY_UNAVAILABLE", details: { capability: "jobs.runs" } },
    });
  });

  it("lists receipts with their spawned outbox record, shows detail and replays", async () => {
    const observer = createConsoleWebhookObserver({ capacity: 2, clock: () => new Date(0) });
    observer.observer.received?.({
      webhookId: "payments.webhook",
      provider: "fake-provider",
      outcome: "rejected",
      status: 401,
      reason: "signature-mismatch",
      durationMs: 3,
    });
    const harness = fixture({ observer });
    const { executor, payments } = harness;
    await storeReceipt(harness, "11111111-1111-4111-8111-111111111111");

    const receipts = await executor.run(
      "console.webhooks.receipts",
      { query: { webhookId: "payments.webhook" } },
      { actor: operator },
    );
    expect(receipts).toMatchObject({
      ok: true,
      data: {
        webhooks: [
          {
            id: "payments.webhook",
            provider: "fake-provider",
            path: "/webhooks/fake",
            mode: "enqueue",
            outboxId: "payments.outbox",
            intent: "process-webhook",
          },
        ],
        capabilities: { list: true, dispatch: true, observed: true },
        receipts: [
          {
            eventId: "11111111-1111-4111-8111-111111111111",
            providerEventId: "evt_1",
            bytes: 14,
            verification: "verified",
            dispatch: { outboxId: "payments.outbox", status: "pending", attempts: 0 },
          },
        ],
        observed: [{ outcome: "rejected", status: 401, reason: "signature-mismatch" }],
      },
    });

    const detail = await executor.run(
      "console.webhooks.receipt",
      { query: { eventId: "11111111-1111-4111-8111-111111111111" } },
      { actor: operator },
    );
    expect(detail).toMatchObject({
      ok: true,
      data: {
        receipt: { headers: { "content-type": "application/json" }, bodyText: '{"id":"evt_1"}' },
      },
    });
    await expect(
      executor.run("console.webhooks.receipt", { query: { eventId: "nope" } }, { actor: operator }),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "WEBHOOK_EVENT_NOT_FOUND" },
    });

    // Complete the first dispatch so the replay records a fresh intent.
    const [claimed] = await payments.claimDue(new Date("2026-10-22T12:00:00.000Z"), 1, 1_000);
    await payments.complete(claimed?.id ?? "", new Date());
    const replayed = await executor.run(
      "console.webhooks.replay",
      { params: { eventId: "11111111-1111-4111-8111-111111111111" } },
      { actor: operator },
    );
    expect(replayed).toMatchObject({
      ok: true,
      data: { eventId: "11111111-1111-4111-8111-111111111111", queued: true },
    });
    expect(payments.records().filter((record) => record.status === "pending")).toHaveLength(1);
    await expect(
      executor.run("console.webhooks.replay", { params: { eventId: "nope" } }, { actor: admin }),
    ).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("inspects outboxes and retries or discards dead letters", async () => {
    const harness = fixture();
    const { executor, reports } = harness;
    await reports.record({}, [
      { intentId: "notify", payload: { recipient: "a@example.test" }, availableAt: new Date(0) },
      { intentId: "notify", payload: { recipient: "b@example.test" }, availableAt: new Date(0) },
    ]);
    const [claimed] = await reports.claimDue(new Date(1), 1, 1_000);
    await reports.fail(claimed?.id ?? "", "smtp down", { deadLetter: true }, new Date(2));

    await expect(
      executor.run("console.outbox.overview", {}, { actor: operator }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        outboxes: [
          {
            outboxId: "payments.outbox",
            pending: 0,
            deadLettered: 0,
            capabilities: { records: true },
          },
          {
            outboxId: "reports.outbox",
            intents: ["notify"],
            pending: 1,
            deadLettered: 1,
            adapter: "memory",
          },
        ],
      },
    });
    const dead = await executor.run(
      "console.outbox.records",
      { query: { outboxId: "reports.outbox", status: "dead-lettered" } },
      { actor: operator },
    );
    expect(dead).toMatchObject({
      ok: true,
      data: { records: [{ status: "dead-lettered", lastError: "smtp down", attempts: 1 }] },
    });
    const recordId = dead.ok ? (dead.data.records[0]?.id ?? "") : "";
    await expect(
      executor.run(
        "console.outbox.retry",
        { body: { outboxId: "reports.outbox", recordId } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({ ok: true, data: { record: { status: "pending" } } });
    await expect(
      executor.run(
        "console.outbox.retry",
        { body: { outboxId: "reports.outbox", recordId } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "OUTBOX_RECORD_NOT_FOUND" },
    });
    await expect(
      executor.run(
        "console.outbox.records",
        { query: { outboxId: "unknown.outbox" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "CONSOLE_OUTBOX_NOT_FOUND" },
    });
    const [again] = await reports.claimDue(new Date(3), 5, 1_000);
    await reports.fail(again?.id ?? "", "still down", { deadLetter: true }, new Date(4));
    await expect(
      executor.run(
        "console.outbox.discard",
        { body: { outboxId: "reports.outbox", recordId: again?.id ?? "", reason: "bounced" } },
        { actor: operator },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { record: { status: "discarded", discardReason: "bounced" } },
    });
  });

  it("reports realtime channels with subscriber counts and the last publish", async () => {
    const harness = fixture();
    const { executor, realtime } = harness;
    await realtime.subscribe(
      {
        channelId: "reports.activity",
        scopeKey: "operator",
        actor: operator,
        connectionId: "c1",
        requestId: "r1",
      },
      () => undefined,
    );
    await realtime.publish(activity, "operator", { count: 1 });
    const channels = await executor.run("console.realtime.channels", {}, { actor: operator });
    expect(channels).toMatchObject({
      ok: true,
      data: {
        backend: { adapter: "memory", ok: true },
        capabilities: { introspection: true },
        channels: [
          {
            channelId: "reports.activity",
            scope: "actor",
            presence: false,
            subscribers: 1,
            scopes: 1,
            lastPublishedAt: expect.any(String),
            lastScopeKey: "operator",
          },
        ],
      },
    });
  });

  it("runs extension operations behind the same permission", async () => {
    const { executor } = fixture();
    await expect(
      executor.run("console.auth-audit.events", {}, { actor: operator }),
    ).resolves.toMatchObject({ ok: true, data: { events: ["login"] } });
  });

  it("validates its options and extensions with stable codes", () => {
    const badAccess = defineOperation({
      id: "console.audit.events",
      input: {},
      output: { 200: z.object({}) },
      successStatus: 200,
      errors: [],
      access: permission("audit:read"),
      transaction: "none",
      dependencies: {},
      handler: () => ({}),
    });
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof InvalidConsoleDefinitionError ? error.code : error;
      }
      return undefined;
    };
    expect(code(() => defineConsoleModule(null as never))).toBe("SHIP_CONSOLE_OPTIONS_INVALID");
    expect(code(() => defineConsoleModule({ imports: [], id: "Ops" }))).toBe(
      "SHIP_CONSOLE_ID_INVALID",
    );
    expect(code(() => defineConsoleModule({ imports: [], basePath: "console/" }))).toBe(
      "SHIP_CONSOLE_OPTIONS_INVALID",
    );
    expect(code(() => defineConsoleModule({ imports: "x" as never }))).toBe(
      "SHIP_CONSOLE_OPTIONS_INVALID",
    );
    expect(code(() => defineConsoleModule({ imports: [], clock: 1 as never }))).toBe(
      "SHIP_CONSOLE_OPTIONS_INVALID",
    );
    expect(code(() => defineConsoleModule({ imports: [] }))).toBe("SHIP_CONSOLE_PANEL_EMPTY");
    expect(
      code(() =>
        defineConsoleModule({
          imports: [],
          extensions: [{ id: "audit", title: "Audit", operations: [badAccess] }],
        }),
      ),
    ).toBe("SHIP_CONSOLE_EXTENSION_ACCESS_INVALID");
    expect(
      code(() =>
        defineConsoleModule({
          imports: [],
          extensions: [{ id: "other", title: "Other", operations: [badAccess] }],
        }),
      ),
    ).toBe("SHIP_CONSOLE_EXTENSION_OPERATION_ID_INVALID");
    expect(
      code(() => defineConsoleModule({ imports: [], extensions: [{ id: "Bad" } as never] })),
    ).toBe("SHIP_CONSOLE_EXTENSION_INVALID");
    expect(() => createConsoleWebhookObserver({ capacity: 0 })).toThrow(TypeError);
  });
});
