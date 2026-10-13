import {
  channelPublisherProvider,
  createExecutor,
  defineApp,
  defineChannel,
  defineModule,
  defineOperation,
  defineRealtimePublicationModule,
  defineRealtimePublicationOutbox,
  dependency,
  operationActor,
  publicAccess,
  REALTIME_PUBLICATION_MODULE_ID,
  type RealtimePublishBackend,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createInMemoryOutbox } from "./outbox.js";
import {
  collectPublishes,
  conformanceChannels,
  createInMemoryRealtimeBackend,
  drainRealtimePublications,
  realtimeBackendConformance,
} from "./realtime.js";

describe("in-memory realtime backend conformance", () => {
  realtimeBackendConformance({
    test: it,
    createBackend: (channels, options) =>
      createInMemoryRealtimeBackend({ channels, tenantScopes: options.tenantScopes }),
  });
});

describe("createInMemoryRealtimeBackend", () => {
  it("rejects invalid channels and unregistered publications", async () => {
    expect(() => createInMemoryRealtimeBackend({ channels: [{} as never] })).toThrowError(
      expect.objectContaining({ code: "SHIP_REALTIME_CHANNEL_INVALID" }),
    );
    const backend = createInMemoryRealtimeBackend({ channels: [] });
    await expect(
      backend.publish(conformanceChannels.feed, "alice", { n: 1 }),
    ).rejects.toMatchObject({
      code: "SHIP_REALTIME_CHANNEL_INVALID",
      channelId: "conformance.feed",
    });
    backend.register([conformanceChannels.feed]);
    await backend.publish(conformanceChannels.feed, "alice", { n: 1 });
    expect(backend.published).toEqual([
      expect.objectContaining({
        channelId: "conformance.feed",
        scopeKey: "alice",
        payload: { n: 1 },
      }),
    ]);
    backend.reset();
    expect(backend.published).toEqual([]);
    await backend.close();
    expect(await backend.health()).toEqual({ ok: false, adapter: "memory" });
    await expect(
      backend.publish(conformanceChannels.feed, "alice", { n: 1 }),
    ).rejects.toMatchObject({ code: "SHIP_REALTIME_BACKEND_UNAVAILABLE" });
    expect(
      await backend.subscribe(
        {
          channelId: "conformance.feed",
          scopeKey: "alice",
          actor: operationActor({ id: "alice" }),
          connectionId: "c",
          requestId: "r",
        },
        () => undefined,
      ),
    ).toEqual({ ok: false, reason: "unavailable" });
    await backend.unsubscribe("missing");
  });
});

describe("collectPublishes", () => {
  const activity = defineChannel({
    id: "activity.feed",
    scope: "actor",
    payload: z.object({ status: z.string() }),
  });
  const clock = { now: () => "2026-09-18T00:00:00.000Z" };
  const clockToken = dependency<typeof clock>("platform.clock");
  const original: RealtimePublishBackend = {
    kind: "ship.realtime-backend",
    id: "production",
    publish: async () => {
      throw new Error("production backend must not be used in tests");
    },
    health: async () => ({ ok: true, adapter: "production" }),
    close: async () => undefined,
  };
  const touch = defineOperation({
    id: "activity.touch",
    input: { body: z.object({ status: z.string() }) },
    output: { 202: z.object({ accepted: z.literal(true), at: z.string() }) },
    successStatus: 202,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: { feed: activity.publication, clock: clockToken },
    publishes: [activity],
    handler: async ({ input, services, context }) => {
      await services.feed.publish(context.actor?.id ?? "anonymous", { status: input.body.status });
      return { accepted: true as const, at: services.clock.now() };
    },
  });
  const application = defineApp({
    id: "collect-fixture",
    modules: [
      defineModule({
        id: "activity",
        operations: [touch],
        providers: [channelPublisherProvider(activity, original), valueProvider(clockToken, clock)],
        imports: [],
        exports: [],
        channels: [activity],
      }),
    ],
  });

  it("recompiles the app onto a recording backend and preserves other providers", async () => {
    const collected = collectPublishes(application);
    expect(collected.application.id).toBe("collect-fixture");
    expect(collected.application.graph).toEqual(application.graph);
    const result = await createExecutor(collected.application).run(
      "activity.touch",
      { body: { status: "open" } },
      { requestId: "r1", actor: operationActor({ id: "alice" }) },
    );
    expect(result).toMatchObject({
      ok: true,
      status: 202,
      data: { accepted: true, at: clock.now() },
    });
    expect(collected.publishes()).toEqual([
      expect.objectContaining({
        channelId: "activity.feed",
        scopeKey: "alice",
        payload: { status: "open" },
      }),
    ]);
    expect(collected.backend.published).toHaveLength(1);

    await expect(
      createExecutor(application).run(
        "activity.touch",
        { body: { status: "open" } },
        { requestId: "r2", actor: operationActor({ id: "alice" }) },
      ),
    ).rejects.toThrow(/handler failed/u);
  });
});

describe("drainRealtimePublications", () => {
  const activity = defineChannel({
    id: "activity.feed",
    scope: "actor",
    payload: z.object({ status: z.string() }),
  });
  const transactionToken = unitOfWorkDependency<{ readonly writes: string[] }>("database.primary");
  const unitOfWork: UnitOfWork<{ readonly writes: string[] }> = {
    kind: "ship.unit-of-work",
    id: transactionToken.id,
    run: async (_mode, work) => work({ writes: [] }),
  };
  const save = defineOperation({
    id: "activity.save",
    input: { body: z.object({ status: z.string() }) },
    output: { 200: z.object({ saved: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "write",
    dependencies: { tx: transactionToken, feed: activity.publication },
    publishes: [activity],
    handler: async ({ input, services, context }) => {
      await services.feed.publish(context.actor?.id ?? "anonymous", { status: input.body.status });
      return { saved: true as const };
    },
  });
  const outbox = createInMemoryOutbox(defineRealtimePublicationOutbox([activity]));
  const application = defineApp({
    id: "drain-fixture",
    modules: [
      defineModule({
        id: "activity",
        operations: [save],
        providers: [valueProvider(transactionToken, unitOfWork)],
        imports: [REALTIME_PUBLICATION_MODULE_ID],
        exports: [],
        channels: [activity],
      }),
      defineRealtimePublicationModule({
        channels: [activity],
        realtime: createInMemoryRealtimeBackend({ channels: [activity] }),
        outbox,
      }),
    ],
  });

  it("dispatches recorded publication intents onto the recording backend", async () => {
    const collected = collectPublishes(application);
    const executor = createExecutor(collected.application);
    await executor.run(
      "activity.save",
      { body: { status: "saved" } },
      { requestId: "r1", actor: operationActor({ id: "alice" }) },
    );
    expect(collected.publishes()).toEqual([]);
    expect(outbox.records()).toMatchObject([{ intentId: "activity.feed", status: "pending" }]);

    await expect(drainRealtimePublications(executor)).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(collected.publishes()).toEqual([
      expect.objectContaining({
        channelId: "activity.feed",
        scopeKey: "alice",
        payload: { status: "saved" },
      }),
    ]);
  });
});
