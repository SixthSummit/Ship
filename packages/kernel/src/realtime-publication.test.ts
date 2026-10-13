import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publicAccess } from "./access.js";
import { operationActor, systemActor } from "./actor.js";
import {
  ApplicationCompilationError,
  compileApp,
  defineApp,
  type OperationGraphNode,
} from "./application.js";
import { type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { type ApplicationExecutor, createExecutor } from "./executor.js";
import { JOB_INPUT_LOCATION, type LockProvider, lockProviderDependency } from "./job.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import type {
  OutboxBackend,
  OutboxFailureDisposition,
  OutboxIntentInput,
  OutboxRecord,
  OutboxRecordResult,
} from "./outbox.js";
import { describeOutboxOperation, OutboxWriteError } from "./outbox.js";
import { valueProvider } from "./provider.js";
import {
  channelPublisherProvider,
  createChannelPublisher,
  defineChannel,
  publishChannelKey,
  REALTIME_PUBLICATION_MODULE_ID,
  RealtimeError,
  type RealtimePublishBackend,
} from "./realtime.js";
import {
  checkRealtimePublicationDispatch,
  createOutboxChannelPublisher,
  defineRealtimePublicationDispatcher,
  defineRealtimePublicationDispatchJob,
  defineRealtimePublicationModule,
  defineRealtimePublicationOutbox,
  dispatchRealtimePublications,
  findRealtimePublicationOutbox,
  publicationDelivery,
  REALTIME_PUBLICATION_DISPATCH_OPERATION_ID,
  REALTIME_PUBLICATION_OUTBOX_ID,
  REALTIME_PUBLICATION_RUNNER_ACTOR_ID,
  realtimePublicationIntentSchema,
  startRealtimePublicationRunner,
} from "./realtime-publication.js";
import { createTenantScopeAuthority } from "./tenant.js";

const payload = z.object({ status: z.string(), version: z.number().int().positive() });
const feed = defineChannel({ id: "activity.feed", scope: "actor", payload });
const room = defineChannel({ id: "activity.room", scope: "tenant", payload });
const transactionToken = unitOfWorkDependency<{ readonly writes: string[] }>("database.primary");
const tenants = createTenantScopeAuthority({
  id: "tenants",
  authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
});
const actor = operationActor({ id: "actor-a", permissions: ["tenant:acme"] });
const system = { actor: systemActor({ id: "dispatcher" }) };

function fakeBackend(): RealtimePublishBackend & {
  readonly published: { channelId: string; scopeKey: string; payload: unknown }[];
} {
  const published: { channelId: string; scopeKey: string; payload: unknown }[] = [];
  return {
    kind: "ship.realtime-backend",
    id: "fake",
    published,
    publish: async (channel, scopeKey, value) => {
      published.push({ channelId: channel.id, scopeKey, payload: value });
    },
    health: async () => ({ ok: true, adapter: "fake" }),
    close: async () => undefined,
  };
}

/**
 * Minimal durable outbox: rows are recorded against the transaction scope and
 * dropped when that scope rolls back, so the executor's unit of work decides
 * whether an intent survives. Enough of the backend contract to run the
 * generated dispatcher.
 */
function fakeOutbox() {
  let rows: (OutboxRecord & { scope: object })[] = [];
  let sequence = 0;
  const replace = (id: string, patch: Partial<OutboxRecord>) => {
    rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
  };
  const backend: OutboxBackend & {
    readonly records: () => readonly OutboxRecord[];
    rollback(scope: object): void;
  } = {
    kind: "ship.outbox-backend",
    outboxId: REALTIME_PUBLICATION_OUTBOX_ID,
    records: () => rows.map(({ scope: _scope, ...row }) => row),
    rollback: (scope) => {
      rows = rows.filter((row) => row.scope !== scope);
    },
    record: async (scope: object, intents: readonly OutboxIntentInput[]) =>
      intents.map((intent): OutboxRecordResult => {
        if (
          intent.dedupeKey !== undefined &&
          rows.some((row) => row.intentId === intent.intentId && row.dedupeKey === intent.dedupeKey)
        ) {
          return { deduplicated: true };
        }
        sequence += 1;
        const id = `record-${sequence}`;
        rows.push({
          id,
          outboxId: REALTIME_PUBLICATION_OUTBOX_ID,
          intentId: intent.intentId,
          payload: intent.payload,
          ...(intent.dedupeKey !== undefined ? { dedupeKey: intent.dedupeKey } : {}),
          status: "pending",
          attempts: 0,
          availableAt: intent.availableAt,
          createdAt: new Date(),
          scope,
        });
        return { recordId: id, deduplicated: false };
      }),
    claimDue: async (now, batchSize, leaseMs, intentIds) => {
      const due = rows
        .filter(
          (row) =>
            (intentIds === undefined || intentIds.includes(row.intentId)) &&
            row.status === "pending" &&
            row.availableAt.getTime() <= now.getTime(),
        )
        .slice(0, batchSize);
      for (const row of due) {
        replace(row.id, { status: "claimed", leaseExpiresAt: new Date(now.getTime() + leaseMs) });
      }
      return due.map((row) => ({ ...row, status: "claimed" as const }));
    },
    claimUnknownDue: async () => [],
    complete: async (recordId, now) => replace(recordId, { status: "completed", completedAt: now }),
    fail: async (recordId, error, disposition: OutboxFailureDisposition, now) => {
      const attempts = (rows.find((row) => row.id === recordId)?.attempts ?? 0) + 1;
      replace(
        recordId,
        "deadLetter" in disposition
          ? { status: "dead-lettered", attempts, lastError: error, deadLetteredAt: now }
          : { status: "pending", attempts, lastError: error, availableAt: disposition.retryAt },
      );
    },
    listDeadLettered: async () => rows.filter((row) => row.status === "dead-lettered"),
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
    health: async () => ({ pending: 0, claimed: 0, deadLettered: 0 }),
  };
  return backend;
}

function createUnitOfWork(onRollback: (scope: object) => void) {
  const controller: UnitOfWork<{ readonly writes: string[] }> = {
    kind: "ship.unit-of-work",
    id: transactionToken.id,
    run: async (_mode, work) => {
      const scope = { writes: [] as string[] };
      try {
        return await work(scope);
      } catch (error) {
        onRollback(scope);
        throw error;
      }
    },
  };
  return controller;
}

function createFixture(
  options: {
    readonly mountDispatcher?: boolean;
    readonly fail?: boolean;
    readonly dedupeKey?: string;
    readonly channels?: readonly (typeof feed | typeof room)[];
  } = {},
) {
  const realtime = fakeBackend();
  const outbox = fakeOutbox();
  const unitOfWork = createUnitOfWork((scope) => outbox.rollback(scope));
  const save = defineOperation({
    id: "activity.save",
    input: { body: z.object({ status: z.string(), version: z.number().int().optional() }) },
    output: { 200: z.object({ saved: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "write",
    dependencies: { tx: transactionToken, feed: feed.publication, room: room.publication },
    publishes: [feed, room],
    handler: async ({ input, services, context }) => {
      const version = input.body.version ?? 1;
      await services.feed.publish(
        context.actor?.id ?? "anonymous",
        { status: input.body.status, version },
        options.dedupeKey ? { dedupeKey: options.dedupeKey } : undefined,
      );
      const scope = await tenants.issue({
        tenantId: "acme",
        requestId: context.requestId,
        actor: context.actor as never,
      });
      await services.room.publish(scope, { status: input.body.status, version });
      if (options.fail) throw new Error("handler exploded");
      return { saved: true as const };
    },
  });
  const modules = [
    defineModule({
      id: "activity",
      operations: [save],
      providers: [valueProvider(transactionToken, unitOfWork)],
      imports: options.mountDispatcher === false ? [] : [REALTIME_PUBLICATION_MODULE_ID],
      exports: [],
      channels: [feed, room],
    }),
    ...(options.mountDispatcher === false
      ? []
      : [
          defineRealtimePublicationModule({
            channels: options.channels ?? [feed, room],
            realtime,
            outbox,
            batchSize: 10,
            lease: { ms: 1_000 },
            retry: { attempts: 2, backoff: { initialMs: 0 } },
          }),
        ]),
  ];
  return {
    realtime,
    outbox,
    modules,
    get executor() {
      return createExecutor(defineApp({ id: "publication-fixture", modules }));
    },
  };
}

function compileDiagnostics(modules: Parameters<typeof compileApp>[0]["modules"]) {
  try {
    return compileApp({ id: "publication-fixture", modules }).diagnostics ?? [];
  } catch (error) {
    if (error instanceof ApplicationCompilationError) return error.diagnostics;
    throw error;
  }
}

function diagnosticCodes(modules: Parameters<typeof compileApp>[0]["modules"]) {
  return compileDiagnostics(modules).map((diagnostic) => diagnostic.code);
}

describe("defineRealtimePublicationOutbox", () => {
  it("declares one intent per channel keyed by channel id and bound to its publication token", () => {
    const outbox = defineRealtimePublicationOutbox([room, feed]);
    expect(outbox.id).toBe(REALTIME_PUBLICATION_OUTBOX_ID);
    expect(Object.keys(outbox.intents)).toEqual(["activity.feed", "activity.room"]);
    expect(outbox.intents["activity.feed"]?.effect).toBe(feed.publication);
    expect(outbox.intents["activity.room"]?.payload).toBe(realtimePublicationIntentSchema);
    expect(outbox.retention).toEqual({
      completedMs: 24 * 60 * 60 * 1000,
      deadLetteredMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(
      defineRealtimePublicationOutbox([feed], {
        retention: { completedMs: 1, deadLetteredMs: 2 },
      }).retention,
    ).toEqual({ completedMs: 1, deadLetteredMs: 2 });
  });

  it("performs an intent by publishing the stored scope key and payload", async () => {
    const backend = fakeBackend();
    const publisher = createChannelPublisher(feed, backend);
    const outbox = defineRealtimePublicationOutbox([feed]);
    await outbox.intents["activity.feed"]?.perform({
      effect: publisher,
      payload: { scopeKey: "actor-a", payload: { status: "ok", version: 1 } },
      record: {} as never,
      context: { requestId: "r" },
    });
    expect(backend.published).toEqual([
      { channelId: "activity.feed", scopeKey: "actor-a", payload: { status: "ok", version: 1 } },
    ]);
  });

  it("rejects an empty, foreign, or duplicated channel list", () => {
    expect(() => defineRealtimePublicationOutbox([])).toThrow(RealtimeError);
    expect(() => defineRealtimePublicationOutbox([{ id: "x" } as never])).toThrow(
      /created by defineChannel/,
    );
    expect(() => defineRealtimePublicationOutbox([feed, feed])).toThrow(/listed more than once/);
  });

  it("validates the intent shape at enqueue time", async () => {
    const result = await realtimePublicationIntentSchema["~standard"].validate({
      scopeKey: "",
      payload: {},
    });
    expect("issues" in result && result.issues?.length).toBeTruthy();
  });
});

describe("publishChannelKey", () => {
  it("publishes only through publishers created by createChannelPublisher", async () => {
    const backend = fakeBackend();
    await publishChannelKey(createChannelPublisher(feed, backend), "actor-a", { status: "s" });
    expect(backend.published).toHaveLength(1);
    await expect(
      publishChannelKey(
        { kind: "ship.channel-publisher", channel: feed, publish: async () => {} },
        "a",
        {},
      ),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_BACKEND_INVALID" });
    await expect(
      publishChannelKey(createChannelPublisher(feed, backend), "not valid", {}),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_SCOPE_KEY_INVALID" });
  });
});

describe("defineRealtimePublicationDispatcher", () => {
  it("generates a transaction none dispatcher that declares every channel in publishes", () => {
    const dispatcher = defineRealtimePublicationDispatcher(
      defineRealtimePublicationOutbox([feed, room]),
    );
    expect(dispatcher.dispatch.id).toBe("ship-realtime.publication.dispatch");
    expect(dispatcher.dispatch.transaction).toBe("none");
    expect(dispatcher.dispatch.effects).toEqual([]);
    expect(dispatcher.dispatch.publishes).toEqual([feed, room]);
    expect(dispatcher.dispatch.dependencies).toMatchObject({
      activityFeedPublish: feed.publication,
      activityRoomPublish: room.publication,
    });
    expect(describeOutboxOperation(dispatcher.dispatch)).toEqual({
      role: "dispatcher",
      outboxId: REALTIME_PUBLICATION_OUTBOX_ID,
      intentIds: ["activity.feed", "activity.room"],
      batchSize: 100,
    });
  });
});

describe("defineRealtimePublicationModule", () => {
  it("mounts the outbox writer, one publisher per channel, the dispatcher and cleanup", () => {
    const module = defineRealtimePublicationModule({
      channels: [feed],
      realtime: fakeBackend(),
      outbox: fakeOutbox(),
    });
    expect(module.id).toBe(REALTIME_PUBLICATION_MODULE_ID);
    expect(module.operations.map((operation) => operation.id)).toEqual([
      "ship-realtime.publication.dispatch",
      "ship-realtime.publication.list-dead-lettered",
      "ship-realtime.publication.retry",
      "ship-realtime.publication.discard",
      "ship-realtime.publication.cleanup",
    ]);
    expect(module.providers.map((provider) => provider.token.id)).toEqual([
      REALTIME_PUBLICATION_OUTBOX_ID,
      "activity.feed.publish",
    ]);
    expect(module.exports.map((token) => token.id)).toEqual([
      REALTIME_PUBLICATION_OUTBOX_ID,
      "activity.feed.publish",
    ]);
  });

  it("exposes the bound publishers as a registry sharing the module's instances", async () => {
    const backend = fakeBackend();
    const module = defineRealtimePublicationModule({
      channels: [room, feed],
      realtime: backend,
      outbox: fakeOutbox(),
    });
    expect(module.publishers.channels.map((channel) => channel.id)).toEqual([
      "activity.feed",
      "activity.room",
    ]);
    const provided = module.providers.find((provider) => provider.token === feed.publication);
    expect(await provided?.create({})).toBe(module.publishers.get("activity.feed"));
    await module.publishers.publish("activity.feed", "actor-a", { status: "open", version: 1 });
    expect(backend.published).toEqual([
      { channelId: "activity.feed", scopeKey: "actor-a", payload: { status: "open", version: 1 } },
    ]);
    // The module still compiles as an ordinary module beside the channel owner.
    const owner = defineModule({
      id: "activity",
      operations: [],
      providers: [],
      imports: [REALTIME_PUBLICATION_MODULE_ID],
      exports: [],
      channels: [feed, room],
    });
    const app = defineApp({ id: "registry-app", modules: [owner, module] });
    expect(app.moduleById[REALTIME_PUBLICATION_MODULE_ID]?.id).toBe(REALTIME_PUBLICATION_MODULE_ID);
    expect(app.graph.channels.map((channel) => channel.id)).toEqual([
      "activity.feed",
      "activity.room",
    ]);
  });
});

describe("compilation", () => {
  it("accepts a write publisher once the module is mounted and marks its delivery as outbox", () => {
    const fixture = createFixture();
    const app = defineApp({ id: "publication-fixture", modules: fixture.modules });
    const save = app.graph.operations.find((node) => node.id === "activity.save");
    const dispatch = app.graph.operations.find(
      (node) => node.id === "ship-realtime.publication.dispatch",
    ) as OperationGraphNode;
    expect(save).toMatchObject({
      transaction: "write",
      publishes: ["activity.feed", "activity.room"],
      publicationDelivery: "outbox",
    });
    expect(dispatch).toMatchObject({
      transaction: "none",
      publishes: ["activity.feed", "activity.room"],
      publicationDelivery: "immediate",
      outbox: [
        {
          id: REALTIME_PUBLICATION_OUTBOX_ID,
          role: "dispatcher",
          intents: ["activity.feed", "activity.room"],
        },
      ],
    });
    expect(app.graph.channels.find((node) => node.id === "activity.feed")?.publishers).toEqual([
      "activity.save",
      "ship-realtime.publication.dispatch",
    ]);
    expect(
      app.graph.outboxes.find((node) => node.id === REALTIME_PUBLICATION_OUTBOX_ID),
    ).toMatchObject({
      intents: [
        { id: "activity.feed", effectId: "activity.feed.publish", payloadVendor: "ship" },
        { id: "activity.room", effectId: "activity.room.publish", payloadVendor: "ship" },
      ],
      operations: { dispatchers: ["ship-realtime.publication.dispatch"] },
    });
    expect(findRealtimePublicationOutbox(app)?.id).toBe(REALTIME_PUBLICATION_OUTBOX_ID);
  });

  it("marks immediate delivery on a transaction none publisher and omits it otherwise", () => {
    const backend = fakeBackend();
    const touch = defineOperation({
      id: "activity.touch",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { feed: feed.publication },
      publishes: [feed],
      handler: () => ({ ok: true as const }),
    });
    const silent = defineOperation({
      id: "activity.silent",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    const app = defineApp({
      id: "publication-fixture",
      modules: [
        defineModule({
          id: "activity",
          operations: [touch, silent],
          providers: [channelPublisherProvider(feed, backend)],
          imports: [],
          exports: [],
          channels: [feed],
        }),
      ],
    });
    expect(app.graph.operations.find((node) => node.id === "activity.touch")).toMatchObject({
      publicationDelivery: "immediate",
    });
    expect(app.graph.operations.find((node) => node.id === "activity.silent")).not.toHaveProperty(
      "publicationDelivery",
    );
    expect(publicationDelivery(touch)).toBe("immediate");
    expect(findRealtimePublicationOutbox(app)).toBeUndefined();
  });

  it("reports a write publisher without the mounted dispatcher module", () => {
    const fixture = createFixture({ mountDispatcher: false });
    expect(diagnosticCodes(fixture.modules)).toEqual([
      "SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING",
      "SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING",
      "SHIP_PROVIDER_MISSING",
      "SHIP_PROVIDER_MISSING",
    ]);
    const diagnostics = compileDiagnostics(fixture.modules).filter(
      (diagnostic) => diagnostic.code === "SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING",
    );
    expect(diagnostics[0]).toMatchObject({
      operationId: "activity.save",
      moduleId: "activity",
      providerId: "activity.feed.publish",
      path: "publishes",
    });
    expect(diagnostics[0]?.hint).toContain("defineRealtimePublicationModule");
  });

  it("reports a channel the mounted module does not list", () => {
    const fixture = createFixture({ channels: [feed] });
    expect(diagnosticCodes(fixture.modules)).toEqual([
      "SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING",
      "SHIP_PROVIDER_MISSING",
    ]);
    const diagnostics: Parameters<typeof checkRealtimePublicationDispatch>[2] = [];
    checkRealtimePublicationDispatch("publication-fixture", fixture.modules, diagnostics);
    expect(diagnostics).toMatchObject([{ providerId: "activity.room.publish" }]);
  });

  it("lets the framework dispatcher publish to channels owned by modules it does not import", () => {
    const fixture = createFixture();
    expect(diagnosticCodes(fixture.modules)).toEqual([]);
  });
});

describe("execution", () => {
  it("records validated intents in the write transaction and publishes them only when dispatched", async () => {
    const fixture = createFixture();
    const executor = fixture.executor;
    const result = await executor.run(
      "activity.save",
      { body: { status: "ready", version: 3 } },
      { actor },
    );
    expect(result).toMatchObject({ ok: true, data: { saved: true } });
    expect(fixture.realtime.published).toEqual([]);
    expect(fixture.outbox.records()).toMatchObject([
      {
        intentId: "activity.feed",
        status: "pending",
        payload: { scopeKey: "actor-a", payload: { status: "ready", version: 3 } },
      },
      {
        intentId: "activity.room",
        status: "pending",
        payload: { scopeKey: "acme", payload: { status: "ready", version: 3 } },
      },
    ]);

    const dispatched = await executor.run("ship-realtime.publication.dispatch", {}, system);
    expect(dispatched).toMatchObject({ ok: true, data: { claimed: 2, completed: 2 } });
    expect(fixture.realtime.published).toEqual([
      { channelId: "activity.feed", scopeKey: "actor-a", payload: { status: "ready", version: 3 } },
      { channelId: "activity.room", scopeKey: "acme", payload: { status: "ready", version: 3 } },
    ]);
    expect(fixture.outbox.records().map((row) => row.status)).toEqual(["completed", "completed"]);
  });

  it("leaves no intent when the handler fails after publishing", async () => {
    const fixture = createFixture({ fail: true });
    const executor = fixture.executor;
    await expect(
      executor.run("activity.save", { body: { status: "lost" } }, { actor }),
    ).rejects.toThrow(/handler failed/);
    expect(fixture.outbox.records()).toEqual([]);
    expect(fixture.realtime.published).toEqual([]);
    expect(await executor.run("ship-realtime.publication.dispatch", {}, system)).toMatchObject({
      data: { claimed: 0 },
    });
  });

  it("validates scope and payload exactly like the immediate path before recording", async () => {
    const fixture = createFixture();
    const executor = fixture.executor;
    await expect(
      executor.run("activity.save", { body: { status: "bad", version: 0 } }, { actor }),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      cause: { code: "SHIP_REALTIME_PAYLOAD_INVALID" },
    });
    expect(fixture.outbox.records()).toEqual([]);

    await expect(
      executor.run(
        "activity.save",
        { body: { status: "ok" } },
        { actor: operationActor({ id: "not a key", permissions: ["tenant:acme"] }) },
      ),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      cause: { code: "SHIP_REALTIME_SCOPE_KEY_INVALID" },
    });
    expect(fixture.outbox.records()).toEqual([]);
  });

  it("deduplicates a repeated dedupeKey and delivers once", async () => {
    const fixture = createFixture({ dedupeKey: "activity:1" });
    const executor = fixture.executor;
    await executor.run("activity.save", { body: { status: "one" } }, { actor });
    await executor.run("activity.save", { body: { status: "two" } }, { actor });
    expect(fixture.outbox.records().filter((row) => row.intentId === "activity.feed")).toHaveLength(
      1,
    );
    await executor.run("ship-realtime.publication.dispatch", {}, system);
    expect(fixture.realtime.published.filter((item) => item.channelId === "activity.feed")).toEqual(
      [{ channelId: "activity.feed", scopeKey: "actor-a", payload: { status: "one", version: 1 } }],
    );
  });

  it("retries a failed publication and dead-letters after the attempt limit", async () => {
    const fixture = createFixture();
    fixture.realtime.publish = vi.fn(async () => {
      throw new Error("redis is down");
    });
    const executor = fixture.executor;
    await executor.run("activity.save", { body: { status: "ready" } }, { actor });
    expect(await executor.run("ship-realtime.publication.dispatch", {}, system)).toMatchObject({
      data: { claimed: 2, retried: 2, deadLettered: 0 },
    });
    expect(await executor.run("ship-realtime.publication.dispatch", {}, system)).toMatchObject({
      data: { claimed: 2, deadLettered: 2 },
    });
    expect(fixture.outbox.records().map((row) => row.status)).toEqual([
      "dead-lettered",
      "dead-lettered",
    ]);
  });

  it("reports a mismatched outbox backend and a missing transaction scope", async () => {
    const wrong = { ...fakeOutbox(), outboxId: "other" };
    const modules = [
      ...createFixture().modules.filter((module) => module.id !== REALTIME_PUBLICATION_MODULE_ID),
      defineRealtimePublicationModule({
        channels: [feed, room],
        realtime: fakeBackend(),
        outbox: wrong as never,
      }),
    ];
    await expect(
      createExecutor(defineApp({ id: "publication-fixture", modules })).run(
        "activity.save",
        { body: { status: "ready" } },
        { actor },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_OUTBOX_BACKEND_INVALID" });

    const writer = createOutboxChannelPublisher(feed, {
      kind: "ship.outbox-writer",
      outboxId: REALTIME_PUBLICATION_OUTBOX_ID,
      enqueue: async () => {
        throw new OutboxWriteError("SHIP_OUTBOX_INTENT_UNKNOWN", "nope", {
          outboxId: REALTIME_PUBLICATION_OUTBOX_ID,
        });
      },
    });
    await expect(writer.publish("actor-a", { status: "s", version: 1 })).rejects.toBeInstanceOf(
      OutboxWriteError,
    );
    expect(() => createOutboxChannelPublisher({ id: "x" } as never, writer as never)).toThrow(
      RealtimeError,
    );
  });
});

describe("dispatchRealtimePublications", () => {
  it("runs one dispatch pass as the framework system actor and returns the counts", async () => {
    const fixture = createFixture();
    const executor = fixture.executor;
    await executor.run("activity.save", { body: { status: "saved" } }, { actor });
    expect(fixture.realtime.published).toEqual([]);
    await expect(dispatchRealtimePublications(executor)).resolves.toEqual({
      batchSize: 10,
      claimed: 2,
      completed: 2,
      retried: 0,
      deadLettered: 0,
    });
    expect(fixture.realtime.published).toHaveLength(2);
    await expect(
      dispatchRealtimePublications(executor, {
        actor: systemActor({ id: "custom.dispatcher" }),
        requestId: "pass-2",
      }),
    ).resolves.toEqual({ batchSize: 10, claimed: 0, completed: 0, retried: 0, deadLettered: 0 });
    expect(REALTIME_PUBLICATION_DISPATCH_OPERATION_ID).toBe("ship-realtime.publication.dispatch");
    expect(REALTIME_PUBLICATION_RUNNER_ACTOR_ID).toBe("ship.realtime.dispatcher");
  });

  it("reports a dispatch that does not succeed as a typed realtime error", async () => {
    const fixture = createFixture({ mountDispatcher: false });
    const modules = [
      defineModule({
        id: "activity",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        channels: [feed, room],
      }),
    ];
    void fixture;
    const executor = createExecutor(defineApp({ id: "no-dispatcher", modules }));
    await expect(dispatchRealtimePublications(executor)).rejects.toMatchObject({
      code: "SHIP_REALTIME_DISPATCH_FAILED",
      message: expect.stringContaining("mount defineRealtimePublicationModule()"),
      cause: expect.objectContaining({ code: "SHIP_OPERATION_NOT_FOUND" }),
    });
    const broken: ApplicationExecutor<never> = {
      run: (async () => {
        throw new TypeError("not an execution error");
      }) as never,
      tryRun: (() => undefined) as never,
    };
    await expect(dispatchRealtimePublications(broken)).rejects.toBeInstanceOf(TypeError);
    const denied = createFixture().executor;
    await expect(
      dispatchRealtimePublications(denied, { actor: { id: "human", kind: "human" } as never }),
    ).rejects.toMatchObject({
      code: "SHIP_REALTIME_DISPATCH_FAILED",
      message: expect.stringContaining("AUTHORIZATION_ERROR"),
    });
  });
});

describe("startRealtimePublicationRunner", () => {
  const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

  it("validates its options and the executor", () => {
    const executor = createFixture().executor;
    for (const options of [
      { intervalMs: 0 },
      { intervalMs: 1.5 },
      { maxPassesPerCycle: 0 },
      { backoff: { initialMs: 0 } },
      { backoff: "fast" as never },
    ]) {
      expect(() => startRealtimePublicationRunner(executor, options)).toThrow(
        expect.objectContaining({ code: "SHIP_REALTIME_RUNNER_INVALID" }),
      );
    }
    expect(() => startRealtimePublicationRunner({} as never)).toThrow(
      expect.objectContaining({ code: "SHIP_REALTIME_RUNNER_INVALID" }),
    );
  });

  it("drains a backlog in bounded bursts, idles on the interval and stops gracefully", async () => {
    const fixture = createFixture();
    const executor = fixture.executor;
    for (let index = 0; index < 3; index += 1) {
      await executor.run(
        "activity.save",
        { body: { status: "saved", version: index + 1 } },
        { actor },
      );
    }
    // Six intents pending, batch size 10: one pass claims all; the next claims nothing and idles.
    const passes: unknown[] = [];
    const runner = startRealtimePublicationRunner(executor, {
      intervalMs: 5,
      maxPassesPerCycle: 2,
      observer: { pass: (pass) => passes.push(pass) },
    });
    expect(runner.kind).toBe("ship.realtime-publication-runner");
    expect(runner.running).toBe(true);
    await settle(40);
    expect(fixture.realtime.published).toHaveLength(6);
    expect(passes[0]).toMatchObject({ ok: true, result: { claimed: 6, completed: 6 } });
    expect(passes[1]).toMatchObject({ ok: true, result: { claimed: 0 } });
    expect(runner.passes).toBeGreaterThanOrEqual(2);
    const before = runner.passes;
    await runner.stop();
    expect(runner.running).toBe(false);
    await settle(30);
    expect(runner.passes).toBe(before);
    await runner.stop();
    // runOnce still works after stop, for a final drain, and is serialized.
    await executor.run("activity.save", { body: { status: "late" } }, { actor });
    const [first, second] = await Promise.all([runner.runOnce(), runner.runOnce()]);
    expect(first.claimed + second.claimed).toBe(2);
    expect(fixture.realtime.published).toHaveLength(8);
  });

  it("yields to the interval after the burst cap so a backlog cannot starve stop", async () => {
    const fixture = createFixture();
    const executor = fixture.executor;
    // Batch size 10 in the fixture: 24 intents need three claiming passes.
    for (let index = 0; index < 12; index += 1) {
      await executor.run("activity.save", { body: { status: "s", version: index + 1 } }, { actor });
    }
    const claimed: number[] = [];
    const runner = startRealtimePublicationRunner(executor, {
      intervalMs: 1_000,
      maxPassesPerCycle: 2,
      observer: { pass: (pass) => claimed.push(pass.ok ? pass.result.claimed : -1) },
    });
    await settle(40);
    // Two passes in the first cycle, then the loop waits for the interval.
    expect(claimed).toEqual([10, 10]);
    expect(fixture.outbox.records().filter((row) => row.status === "pending")).toHaveLength(4);
    const stopped = runner.stop();
    await expect(stopped).resolves.toBeUndefined();
  });

  it("backs off after a failed pass, keeps running and reports every failure", async () => {
    const fixture = createFixture();
    let calls = 0;
    const failing: ApplicationExecutor<never> = {
      run: (async (...arguments_: Parameters<typeof fixture.executor.run>) => {
        calls += 1;
        if (calls <= 2) throw new Error(`boom ${calls}`);
        return fixture.executor.run(...arguments_);
      }) as never,
      tryRun: (() => {
        throw new Error("unused");
      }) as never,
    };
    const failures: { failures: number; retryInMs: number }[] = [];
    const observed: unknown[] = [];
    const runner = startRealtimePublicationRunner(failing, {
      intervalMs: 5,
      backoff: { initialMs: 5, multiplier: 2, maxMs: 20 },
      observer: { pass: (pass) => observed.push(pass) },
      onError: (error, pass) => {
        expect(error).toBeInstanceOf(Error);
        failures.push({ failures: pass.failures, retryInMs: pass.retryInMs });
      },
    });
    await settle(80);
    await runner.stop();
    expect(failures).toEqual([
      { failures: 1, retryInMs: 5 },
      { failures: 2, retryInMs: 10 },
    ]);
    expect(observed.slice(0, 3)).toMatchObject([
      { ok: false, failures: 1 },
      { ok: false, failures: 2 },
      { ok: true, result: { claimed: 0 } },
    ]);
    calls = 0;
    await expect(runner.runOnce()).rejects.toThrow("boom 1");
  });
});

describe("defineRealtimePublicationDispatchJob", () => {
  it("declares a single-runner job whose every run is one shared dispatch pass", async () => {
    const fixture = createFixture();
    let executor: ApplicationExecutor<never> | undefined;
    const job = defineRealtimePublicationDispatchJob({
      trigger: { kind: "interval", everyMs: 1_000 },
      executor: () => executor as never,
      leaseMs: 5_000,
    });
    expect(job.id).toBe("ship-realtime.publication.dispatch-job");
    expect(job.job).toMatchObject({
      trigger: { kind: "interval", everyMs: 1_000 },
      concurrency: { mode: "single-runner", keyed: true, leaseMs: 5_000 },
      retry: { attempts: 1 },
      transaction: "none",
    });
    const [owner, publication] = fixture.modules;
    const locks: LockProvider = {
      kind: "ship.lock-provider",
      acquire: async (jobId, key, ttlMs) => ({
        jobId,
        key,
        token: "t",
        expiresAt: new Date(Date.now() + ttlMs),
      }),
      release: async () => undefined,
    };
    const modules = [
      owner as NonNullable<typeof owner>,
      defineModule({
        ...(publication as NonNullable<typeof publication>),
        operations: [...(publication as NonNullable<typeof publication>).operations, job],
        providers: [
          ...(publication as NonNullable<typeof publication>).providers,
          valueProvider(lockProviderDependency(), locks),
        ],
      }),
    ];
    const app = defineApp({ id: "dispatch-job-fixture", modules });
    executor = createExecutor(app) as never;
    const run = executor as unknown as ReturnType<typeof createExecutor<typeof app>>;
    await run.run("activity.save", { body: { status: "saved" } }, { actor });
    expect(fixture.realtime.published).toEqual([]);
    const outcome = await run.run(
      job.id,
      { [JOB_INPUT_LOCATION]: {} },
      { actor: systemActor({ id: "ship.jobs.test" }), requestId: "run-1" },
    );
    expect(outcome).toMatchObject({
      ok: true,
      data: { claimed: 2, completed: 2, retried: 0, deadLettered: 0 },
    });
    expect(fixture.realtime.published).toHaveLength(2);
    expect(
      defineRealtimePublicationDispatchJob({
        id: "ops.realtime-dispatch",
        trigger: { kind: "schedule", cron: "* * * * *", tz: "UTC" },
        executor: () => run as never,
      }).id,
    ).toBe("ops.realtime-dispatch");
    expect(() => defineRealtimePublicationDispatchJob({} as never)).toThrow(
      expect.objectContaining({ code: "SHIP_REALTIME_RUNNER_INVALID" }),
    );
  });
});
