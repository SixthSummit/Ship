/**
 * Transactional publication through the durable outbox against a real
 * PostgreSQL unit of work, a real Redis, and an in-process Socket.IO gateway.
 *
 * Proves the ADR-0017 §9 composition end to end: a write operation records a
 * publication intent in its own transaction, nothing reaches a subscriber
 * until the framework dispatcher runs, a rollback leaves no intent, a
 * process that dies after commit is recovered by the next dispatcher, and a
 * repeated dedupeKey delivers once.
 */
import {
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  defineRealtimePublicationModule,
  defineRealtimePublicationOutbox,
  operationError,
  operationFailure,
  publicAccess,
  REALTIME_PUBLICATION_MODULE_ID,
  REALTIME_PUBLICATION_OUTBOX_ID,
  systemActor,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import {
  createDrizzleOutbox,
  createDrizzleUnitOfWork,
  shipOutboxTable,
} from "@sixthsummit/ship-drizzle";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { io, type Socket } from "socket.io-client";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { actors, credentials, feed, tenantScopes } from "./__fixtures__/shared.js";
import { createRealtimeGateway, type RealtimeGateway } from "./gateway.js";
import { CLIENT_EVENTS, SERVER_EVENTS, SHIP_NAMESPACE } from "./protocol.js";
import { createRealtimePublisher, type RealtimePublisher } from "./publisher.js";

const records = pgTable("publication_records", {
  id: serial("id").primaryKey(),
  value: text("value").notNull(),
});
const outboxTable = shipOutboxTable();
const schema = { records, outboxTable };
type Schema = typeof schema;

interface Capabilities {
  readonly domain: { insert(value: string): Promise<void> };
}

const transactionToken = unitOfWorkDependency<Capabilities>("database.integration");
const writeRejected = operationError({ code: "WRITE_REJECTED", status: 409, message: "Rejected" });
const system = { actor: systemActor({ id: "dispatcher" }) };
const ACTOR = "subscriber";

let database: PostgresTestDb<Schema>;
let redis: StartedTestContainer;
let redisUrl = "";
let gateway: RealtimeGateway;
let gatewayUrl = "";
const publishers: RealtimePublisher[] = [];
const sockets: Socket[] = [];

interface Event {
  readonly channel: string;
  readonly scopeKey: string;
  readonly seq: number;
  readonly payload: { readonly n: number; readonly padding?: string };
}

/** One application instance. Building a second one models a process restart. */
function application() {
  const publisher = createRealtimePublisher({ redis: { url: redisUrl }, channels: [feed] });
  publishers.push(publisher);
  const save = defineOperation({
    id: "activity.save",
    input: {
      body: z.object({
        value: z.string(),
        n: z.number().int(),
        fail: z.boolean().optional(),
        dedupeKey: z.string().optional(),
      }),
    },
    output: { 200: z.object({ saved: z.literal(true) }) },
    successStatus: 200,
    errors: [writeRejected],
    access: publicAccess(),
    transaction: "write",
    dependencies: { tx: transactionToken, feed: feed.publication },
    publishes: [feed],
    handler: async ({ input, services }) => {
      await services.tx.domain.insert(input.body.value);
      // The fixture channel payload is { n, sentAt }; value rides along as padding.
      await services.feed.publish(
        ACTOR,
        { n: input.body.n, sentAt: Date.now(), padding: input.body.value },
        input.body.dedupeKey ? { dedupeKey: input.body.dedupeKey } : undefined,
      );
      if (input.body.fail) throw operationFailure(writeRejected);
      return { saved: true as const };
    },
  });
  const activity = defineModule({
    id: "activity",
    operations: [save],
    providers: [
      valueProvider(
        transactionToken,
        createDrizzleUnitOfWork({
          id: transactionToken.id,
          database: database.db,
          create: (transaction) => ({
            domain: {
              insert: async (value: string) => {
                await transaction.insert(records).values({ value });
              },
            },
          }),
        }),
      ),
    ],
    imports: [REALTIME_PUBLICATION_MODULE_ID],
    exports: [],
    channels: [feed],
  });
  const realtime = defineRealtimePublicationModule({
    channels: [feed],
    realtime: publisher,
    outbox: createDrizzleOutbox({
      outbox: defineRealtimePublicationOutbox([feed]),
      database: database.db,
      table: outboxTable,
    }),
    batchSize: 10,
    lease: { ms: 5_000 },
    retry: { attempts: 3, backoff: { initialMs: 0 } },
  });
  const app = defineApp({ id: "publication-integration", modules: [activity, realtime] });
  return { app, executor: createExecutor(app), publisher };
}

function connect(): Promise<Socket> {
  const socket = io(`${gatewayUrl}${SHIP_NAMESPACE}`, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    auth: { credential: ACTOR },
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

async function subscribe(): Promise<{ socket: Socket; events: Event[] }> {
  const socket = await connect();
  const events: Event[] = [];
  socket.on(SERVER_EVENTS.event, (event: Event) => events.push(event));
  const ack = await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
    channel: feed.id,
    scopeKey: ACTOR,
  });
  expect(ack).toMatchObject({ ok: true });
  return { socket, events };
}

function until(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("transactional publication through the outbox", () => {
  beforeAll(async () => {
    [database, redis] = await Promise.all([
      setupPostgresTestDb(schema),
      new GenericContainer("redis:7-alpine").withExposedPorts(6379).start(),
    ]);
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    gateway = createRealtimeGateway({
      channels: [feed],
      auth: { credentials, actors },
      redis: { url: redisUrl },
      tenantScopes,
      gatewayId: "g-outbox",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
    });
    const address = await gateway.listen();
    gatewayUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await truncateAll(database);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    for (const publisher of publishers.splice(0)) await publisher.close();
  });

  afterAll(async () => {
    await gateway?.close();
    await database?.cleanup();
    await redis?.stop();
  });

  it("commits the intent with the write and delivers to a subscriber only once dispatched", async () => {
    const { executor, publisher } = application();
    const { events } = await subscribe();

    const written = await executor.run("activity.save", { body: { value: "first", n: 1 } });
    expect(written).toMatchObject({ ok: true, data: { saved: true } });
    expect(await database.db.select().from(records)).toHaveLength(1);
    expect(await database.db.select().from(outboxTable)).toMatchObject([
      {
        outboxId: REALTIME_PUBLICATION_OUTBOX_ID,
        intentId: feed.id,
        status: "pending",
        payload: { scopeKey: ACTOR, payload: { n: 1, padding: "first" } },
      },
    ]);
    // Eventual by construction: committed, but not yet visible to subscribers.
    await settle();
    expect(events).toEqual([]);

    const dispatched = await executor.run("ship-realtime.publication.dispatch", {}, system);
    expect(dispatched).toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    await publisher.flush();
    await until(() => events.length === 1, "delivery after dispatch");
    expect(events[0]).toMatchObject({
      channel: feed.id,
      scopeKey: ACTOR,
      seq: 1,
      payload: { n: 1, padding: "first" },
    });
    expect(await database.db.select().from(outboxTable)).toMatchObject([{ status: "completed" }]);
  });

  it("leaves no intent and delivers nothing when the write rolls back", async () => {
    const { executor, publisher } = application();
    const { events } = await subscribe();

    await expect(
      executor.run("activity.save", { body: { value: "lost", n: 2, fail: true } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "WRITE_REJECTED" } });
    expect(await database.db.select().from(records)).toHaveLength(0);
    expect(await database.db.select().from(outboxTable)).toHaveLength(0);

    expect(await executor.run("ship-realtime.publication.dispatch", {}, system)).toMatchObject({
      data: { claimed: 0 },
    });
    await publisher.flush();
    await settle();
    expect(events).toEqual([]);
  });

  it("recovers a committed publication when the process dies before dispatching", async () => {
    const first = application();
    await first.executor.run("activity.save", { body: { value: "survivor", n: 3 } });
    expect(await database.db.select().from(outboxTable)).toMatchObject([{ status: "pending" }]);
    // The process dies here: its executor and publisher are gone, the row is not.
    await first.publisher.close();

    const second = application();
    const { events } = await subscribe();
    const dispatched = await second.executor.run("ship-realtime.publication.dispatch", {}, system);
    expect(dispatched).toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    await second.publisher.flush();
    await until(() => events.length === 1, "delivery from the replacement process");
    expect(events[0]).toMatchObject({ payload: { n: 3, padding: "survivor" } });
  });

  it("delivers once for two publishes sharing a dedupeKey", async () => {
    const { executor, publisher } = application();
    const { events } = await subscribe();

    for (const n of [4, 5]) {
      const result = await executor.run("activity.save", {
        body: { value: `retry-${n}`, n, dedupeKey: "activity:same" },
      });
      expect(result).toMatchObject({ ok: true });
    }
    expect(await database.db.select().from(records)).toHaveLength(2);
    expect(await database.db.select().from(outboxTable)).toMatchObject([
      { dedupeKey: "activity:same", payload: { payload: { n: 4 } } },
    ]);

    expect(await executor.run("ship-realtime.publication.dispatch", {}, system)).toMatchObject({
      data: { claimed: 1, completed: 1 },
    });
    await publisher.flush();
    await until(() => events.length === 1, "single delivery");
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { n: 4, padding: "retry-4" } });
  });
});
