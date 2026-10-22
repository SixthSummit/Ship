import {
  createExecutor,
  defineApp,
  defineModule,
  defineOutbox,
  defineOutboxDispatcher,
  defineWebhook,
  defineWebhookCleanup,
  defineWebhookReplay,
  effectDependency,
  humanActor,
  idempotencyStoreDependency,
  systemActor,
  unitOfWorkDependency,
  valueProvider,
  WEBHOOK_REPLAY_PERMISSION,
  webhookEventStoreDependency,
  webhookIntent,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { createHonoAdapter } from "@sixthsummit/ship-hono";
import {
  createPostgresTestPool,
  fakeWebhookProvider,
  type PostgresTestDb,
  setupPostgresTestDb,
  truncateAll,
} from "@sixthsummit/ship-testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDrizzleIdempotencyStore, shipIdempotencyTable } from "./idempotency.js";
import { createDrizzleOutbox, shipOutboxTable } from "./outbox.js";
import { createDrizzleUnitOfWork } from "./unit-of-work.js";
import { createDrizzleWebhookEventStore, shipWebhookEventsTable } from "./webhook-events.js";

const outboxTable = shipOutboxTable();
const idempotencyTable = shipIdempotencyTable();
const eventsTable = shipWebhookEventsTable();
const schema = { outboxTable, idempotencyTable, eventsTable };
type Schema = typeof schema;

const SECRET = "whsec_integration";
const fake = fakeWebhookProvider();
const provider = webhookVerifierToken({ verifier: fake.verifier, secret: webhookSecret(SECRET) });
const storeToken = idempotencyStoreDependency("platform.idempotency");
const eventsToken = webhookEventStoreDependency("platform.webhook-events");
const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
const notifier = effectDependency<{ send(eventId: string): Promise<void> }>("ingress.notifier", {
  delivery: "immediate",
});
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
const durable = defineWebhook({
  id: "ingress.durable-hook",
  path: "/webhooks/durable",
  provider,
  body: { maxBytes: 4096, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 60_000, store: storeToken, inFlight: { kind: "retry", status: 409 } },
  retention: { eventsMs: 60_000, claimsMs: 60_000 },
  receive: { mode: "enqueue", outbox, intent: "process", store: eventsToken, unitOfWork },
});
const replay = defineWebhookReplay({
  id: "ingress.webhook-replay",
  webhooks: [durable],
  unitOfWork,
  store: eventsToken,
});
const dispatcher = defineOutboxDispatcher(outbox, {
  batchSize: 50,
  lease: { ms: 10_000 },
  retry: { attempts: 1, backoff: { initialMs: 1 } },
  deadLetter: true,
});

interface ProcessOptions {
  readonly pool: pg.Pool;
  readonly inline?: {
    readonly inFlight: { kind: "wait"; maxMs: number } | { kind: "retry"; status: number };
    readonly handler: (arguments_: {
      event: { verified: { eventId?: string } };
    }) => Promise<unknown>;
  };
  readonly clock?: () => Date;
  readonly send?: (eventId: string) => Promise<void>;
  /** Runs inside the write transaction right after the event row is inserted. */
  readonly afterRecord?: () => Promise<void>;
}

/** One "process": its own pool, stores, executor and HTTP surface over the shared database. */
function createProcess(options: ProcessOptions) {
  const database = drizzle(options.pool, { schema });
  const events = createDrizzleWebhookEventStore({
    database,
    table: eventsTable,
    outboxTable,
    idempotencyTable,
  });
  const store = options.afterRecord
    ? {
        ...events,
        record: async (scope: object, event: Parameters<typeof events.record>[1]) => {
          await events.record(scope, event);
          await options.afterRecord?.();
        },
      }
    : events;
  const inline = options.inline
    ? defineWebhook({
        id: "ingress.inline-hook",
        path: "/webhooks/inline",
        provider,
        body: { maxBytes: 4096, mediaTypes: ["application/json"] },
        idempotency: { windowMs: 60_000, store: storeToken, inFlight: options.inline.inFlight },
        output: { 200: z.object({ handled: z.string() }) },
        successStatus: 200,
        transaction: "none",
        dependencies: {},
        handler: options.inline.handler as never,
      })
    : undefined;
  const cleanup = defineWebhookCleanup({
    id: "ingress.webhook-cleanup",
    webhooks: [durable],
    store: eventsToken,
    clock: options.clock,
  });
  const application = defineApp({
    id: "webhooks-integration",
    modules: [
      defineModule({
        id: "ingress",
        operations: [
          durable.operation,
          ...(inline ? [inline.operation] : []),
          replay,
          cleanup,
          ...dispatcher.operations,
        ],
        providers: [
          valueProvider(
            storeToken,
            createDrizzleIdempotencyStore({ database, table: idempotencyTable }),
          ),
          valueProvider(eventsToken, store),
          valueProvider(
            unitOfWork,
            createDrizzleUnitOfWork({
              id: "database.primary",
              database,
              create: () => ({ marker: "tx" as const }),
            }),
          ),
          valueProvider(
            outbox.writer,
            createDrizzleOutbox({ outbox, database, table: outboxTable }),
          ),
          valueProvider(notifier, { send: options.send ?? (async () => undefined) }),
        ],
        imports: [],
        exports: [],
      }),
    ],
  });
  return {
    application,
    executor: createExecutor(application),
    http: createHonoAdapter(application, {
      webhooks: { publicBaseUrl: "https://api.example.test" },
    }),
  };
}

async function signed(body: string, eventId: string) {
  const headers = await fake.sign({ rawBody: body, secret: SECRET, eventId });
  return { method: "POST", headers: { ...headers, "content-type": "application/json" }, body };
}

describe("webhook ingress over PostgreSQL", () => {
  let context: PostgresTestDb<Schema>;
  let poolA: pg.Pool;
  let poolB: pg.Pool;

  beforeAll(async () => {
    context = await setupPostgresTestDb(schema);
    poolA = createPostgresTestPool(context.connectionString, { max: 20 });
    poolB = createPostgresTestPool(context.connectionString, { max: 20 });
  });

  beforeEach(async () => {
    await truncateAll(context);
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
    await context?.cleanup();
  });

  it("acknowledges enqueue-mode deliveries only after the event, intent and claim commit together", async () => {
    const processA = createProcess({ pool: poolA });
    const processB = createProcess({ pool: poolB });
    const body = '{"id":"evt_1","type":"invoice.paid"}';

    const first = await processA.http.request("/webhooks/durable", await signed(body, "evt_1"));
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { eventId: string };
    const [eventRow] = await context.db.select().from(eventsTable);
    const [intentRow] = await context.db.select().from(outboxTable);
    const [claimRow] = await context.db.select().from(idempotencyTable);
    expect(eventRow).toMatchObject({
      id: accepted.eventId,
      webhookId: "ingress.durable-hook",
      provider: "fake-provider",
      providerEventId: "evt_1",
      outboxRecordId: intentRow?.id,
    });
    expect(Buffer.from(eventRow?.body as Uint8Array).toString("utf8")).toBe(body);
    expect(eventRow?.headers).not.toHaveProperty("x-fake-provider-signature");
    expect(intentRow).toMatchObject({
      intentId: "process",
      status: "pending",
      dedupeKey: accepted.eventId,
    });
    expect(claimRow).toMatchObject({ key: "ingress.durable-hook:evt_1", status: "completed" });

    // The other process sees the completed claim and replays without a second execution.
    const duplicate = await processB.http.request("/webhooks/durable", await signed(body, "evt_1"));
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toEqual({ accepted: true, eventId: accepted.eventId });
    expect(await context.db.select().from(eventsTable)).toHaveLength(1);
    expect(await context.db.select().from(outboxTable)).toHaveLength(1);
  });

  it("rolls back the event and claim when the transaction fails after the insert, so a retry runs fresh", async () => {
    let crash = true;
    const processA = createProcess({
      pool: poolA,
      afterRecord: async () => {
        if (crash) throw new Error("simulated crash before commit");
      },
    });
    const body = '{"id":"evt_crash"}';
    const crashed = await processA.http.request(
      "/webhooks/durable",
      await signed(body, "evt_crash"),
    );
    expect(crashed.status).toBe(500);
    await expect(crashed.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_HANDLER_FAILED" },
    });
    expect(await context.db.select().from(eventsTable)).toHaveLength(0);
    expect(await context.db.select().from(idempotencyTable)).toHaveLength(0);

    crash = false;
    const retried = await processA.http.request(
      "/webhooks/durable",
      await signed(body, "evt_crash"),
    );
    expect(retried.status).toBe(202);
    expect(await context.db.select().from(eventsTable)).toHaveLength(1);
  });

  it("never fabricates a result when the process dies after commit but before responding", async () => {
    const processA = createProcess({ pool: poolA });
    const processB = createProcess({ pool: poolB });
    const body = '{"id":"evt_lost"}';
    // Simulate the crash by aborting the request after the executor committed.
    const controller = new AbortController();
    const request = await signed(body, "evt_lost");
    const responsePromise = processA.http.request("/webhooks/durable", {
      ...request,
      signal: controller.signal,
    });
    await responsePromise;
    // Whatever the first process answered, the provider retries. The durable claim
    // replays the committed 202 with the same event id: one event, one intent.
    const retried = await processB.http.request("/webhooks/durable", request);
    expect(retried.status).toBe(202);
    const rows = await context.db.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    await expect(retried.json()).resolves.toEqual({ accepted: true, eventId: rows[0]?.id });
  });

  it("follows the declared in-flight policy across processes for inline webhooks", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async ({ event }: { event: { verified: { eventId?: string } } }) => {
      await gate;
      return { handled: event.verified.eventId ?? "" };
    });
    const retrying = createProcess({
      pool: poolA,
      inline: { inFlight: { kind: "retry", status: 409 }, handler },
    });
    const waiting = createProcess({
      pool: poolB,
      inline: { inFlight: { kind: "wait", maxMs: 5_000 }, handler },
    });
    const request = await signed('{"id":"evt_inline"}', "evt_inline");
    const first = retrying.http.request("/webhooks/inline", request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const concurrentRetry = await retrying.http.request("/webhooks/inline", request);
    expect(concurrentRetry.status).toBe(409);
    await expect(concurrentRetry.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_IN_FLIGHT" },
    });
    const concurrentWait = waiting.http.request("/webhooks/inline", request);
    setTimeout(() => release(), 100);
    const [original, waited] = await Promise.all([first, concurrentWait]);
    expect(original.status).toBe(200);
    expect(waited.status).toBe(200);
    await expect(waited.json()).resolves.toEqual({ handled: "evt_inline" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("durably accepts a burst of valid events with bounded latency and none queued in memory", async () => {
    const processA = createProcess({ pool: poolA });
    const bodies = Array.from({ length: 10 }, (_, index) => `{"id":"evt_burst_${index}"}`);
    const latencies: number[] = [];
    const responses = await Promise.all(
      bodies.map(async (body, index) => {
        const request = await signed(body, `evt_burst_${index}`);
        const started = performance.now();
        const response = await processA.http.request("/webhooks/durable", request);
        latencies.push(performance.now() - started);
        return response;
      }),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(202));
    const sorted = [...latencies].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
    // Declared bound for a warm local container; the assertion documents the budget.
    expect(p95).toBeLessThan(2_000);
    // Durable acceptance means every acknowledged event is already in the database
    // and in the outbox: nothing waits in process memory.
    expect(await context.db.select().from(eventsTable)).toHaveLength(10);
    const intents = await context.db.select().from(outboxTable);
    expect(intents.filter((row) => row.status === "pending")).toHaveLength(10);
  });

  it("answers every request with 503 and loses nothing while the store is down", async () => {
    const deadPool = new pg.Pool({
      host: "127.0.0.1",
      port: 1,
      user: "nobody",
      password: "nobody",
      database: "none",
      connectionTimeoutMillis: 300,
      max: 5,
    });
    try {
      const down = createProcess({ pool: deadPool });
      const requests = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          signed(`{"id":"evt_down_${index}"}`, `evt_down_${index}`),
        ),
      );
      const responses = await Promise.all(
        requests.map((request) => down.http.request("/webhooks/durable", request)),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(5).fill(503));
      for (const response of responses) {
        expect(response.headers.get("retry-after")).toBe("1");
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "WEBHOOK_UNAVAILABLE" },
        });
      }
      // The provider retries against a healthy process and every event lands exactly once.
      const healthy = createProcess({ pool: poolA });
      for (const request of requests) {
        expect((await healthy.http.request("/webhooks/durable", request)).status).toBe(202);
      }
      expect(await context.db.select().from(eventsTable)).toHaveLength(5);
    } finally {
      await deadPool.end();
    }
  });

  it("lists stored events newest first, by webhook and before an instant", async () => {
    const processA = createProcess({ pool: poolA, send: vi.fn(async () => undefined) });
    const first = await processA.http.request("/webhooks/durable", await signed('{"id":"a"}', "a"));
    const second = await processA.http.request(
      "/webhooks/durable",
      await signed('{"id":"b"}', "b"),
    );
    const eventA = ((await first.json()) as { eventId: string }).eventId;
    const eventB = ((await second.json()) as { eventId: string }).eventId;
    const store = createDrizzleWebhookEventStore({ database: context.db, table: eventsTable });
    const listed = await store.list?.({ limit: 10 });
    expect(listed?.map((event) => event.id)).toEqual([eventB, eventA]);
    expect(listed?.[0]).toMatchObject({ webhookId: "ingress.durable-hook", providerEventId: "b" });
    expect(await store.list?.({ webhookId: "ingress.other", limit: 10 })).toEqual([]);
    expect(await store.list?.({ limit: 1 })).toHaveLength(1);
    const before = listed?.[0]?.receivedAt ?? new Date();
    expect((await store.list?.({ before, limit: 10 }))?.map((event) => event.id)).toEqual([eventA]);
  });

  it("dispatches, replays and cleans up stored events without deleting undispatched ones", async () => {
    const send = vi.fn(async () => undefined);
    const clock = { now: new Date() };
    const processA = createProcess({ pool: poolA, send, clock: () => clock.now });
    const system = systemActor({ id: "runner" });
    const operator = humanActor({ id: "ops", permissions: [WEBHOOK_REPLAY_PERMISSION] });

    const first = await processA.http.request("/webhooks/durable", await signed('{"id":"a"}', "a"));
    const second = await processA.http.request(
      "/webhooks/durable",
      await signed('{"id":"b"}', "b"),
    );
    const eventA = ((await first.json()) as { eventId: string }).eventId;
    const eventB = ((await second.json()) as { eventId: string }).eventId;

    // Dispatch only the first intent by completing it; leave the second pending.
    const [recordA] = await context.db
      .select()
      .from(outboxTable)
      .where(sql`${outboxTable.dedupeKey} = ${eventA}`);
    await context.db
      .update(outboxTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(sql`${outboxTable.id} = ${recordA?.id}`);

    const replayed = await processA.executor.run(
      "ingress.webhook-replay",
      { body: { eventId: eventA } },
      { actor: operator },
    );
    expect(replayed).toMatchObject({ ok: true, data: { eventId: eventA, queued: true } });
    const dispatched = await processA.executor.run(
      "ingress.outbox.dispatch",
      {},
      { actor: system },
    );
    expect(dispatched).toMatchObject({ ok: true, data: { completed: 2 } });
    expect(send).toHaveBeenCalledWith(eventA);
    expect(send).toHaveBeenCalledWith(eventB);

    // Put the second event's intent back to pending to prove retention never deletes it.
    await context.db
      .update(outboxTable)
      .set({ status: "pending", completedAt: null })
      .where(sql`${outboxTable.dedupeKey} = ${eventB}`);
    clock.now = new Date(Date.now() + 120_000);
    const cleaned = await processA.executor.run("ingress.webhook-cleanup", {}, { actor: system });
    expect(cleaned).toMatchObject({ ok: true, data: { eventsDeleted: 1, claimsDeleted: 2 } });
    const remaining = await context.db.select().from(eventsTable);
    expect(remaining.map((row) => row.id)).toEqual([eventB]);
    expect(await context.db.select().from(idempotencyTable)).toHaveLength(0);
  });
});
