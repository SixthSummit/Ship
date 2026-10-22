import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { defineChannel, operationActor } from "@sixthsummit/ship-core";
import {
  conformanceChannels,
  conformanceTenantScopes,
  realtimeBackendConformance,
} from "@sixthsummit/ship-testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSocketIoRealtimeBackend } from "./backend.js";
import { encodeEnvelope } from "./envelope.js";
import { ATTR_CHANNEL_ID, ATTR_CHANNEL_SCOPE, createRealtimeMetrics } from "./metrics.js";
import { createMemoryRedisHub, realtimeKeys } from "./redis.js";

const alice = operationActor({ id: "alice", permissions: ["tenant:acme"] });
const bob = operationActor({ id: "bob", permissions: ["tenant:acme"] });
const requestId = "backend-test";

describe("socket.io redis backend conformance (memory redis)", () => {
  realtimeBackendConformance({
    test: it,
    createBackend: async (channels, options) => {
      const backend = createSocketIoRealtimeBackend({
        redis: createMemoryRedisHub().transport(),
        channels,
        tenantScopes: options.tenantScopes,
        heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
      });
      await backend.start();
      return backend;
    },
  });
});

describe("createSocketIoRealtimeBackend across gateways", () => {
  it("delivers publications from one process to subscribers on another and dedupes presence", async () => {
    const hub = createMemoryRedisHub();
    const channels = [conformanceChannels.feed, conformanceChannels.room];
    const one = createSocketIoRealtimeBackend({
      redis: hub.transport(),
      channels,
      tenantScopes: conformanceTenantScopes,
      gatewayId: "g1",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
    });
    const two = createSocketIoRealtimeBackend({
      redis: hub.transport(),
      channels,
      tenantScopes: conformanceTenantScopes,
      gatewayId: "g2",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
    });
    await Promise.all([one.start(), two.start()]);
    const onOne: unknown[] = [];
    const onTwo: unknown[] = [];
    const room = { channelId: "conformance.room", scopeKey: "acme", requestId };
    const first = await one.subscribe({ ...room, actor: alice, connectionId: "a1" }, (event) =>
      onOne.push(event),
    );
    const second = await two.subscribe({ ...room, actor: alice, connectionId: "a2" }, (event) =>
      onTwo.push(event),
    );
    expect(first.ok && second.ok).toBe(true);
    await settle();
    expect(onOne).toEqual([
      expect.objectContaining({ kind: "presence", event: "joined", actorId: "alice", count: 1 }),
    ]);
    expect(onTwo).toEqual([]);
    expect(one.subscriptionCount()).toBe(1);
    expect(one.subscriptionCount("conformance.room")).toBe(1);
    expect(one.subscriptionCount("conformance.feed")).toBe(0);

    const onBob: unknown[] = [];
    await two.subscribe({ ...room, actor: bob, connectionId: "b1" }, (event) => onBob.push(event));
    await settle();
    expect(onOne).toHaveLength(2);
    expect(onOne[1]).toMatchObject({ event: "joined", actorId: "bob", count: 2 });
    expect(onTwo).toEqual([expect.objectContaining({ event: "joined", actorId: "bob", count: 2 })]);
    expect(onBob).toEqual(onTwo);

    await two.publish(conformanceChannels.room, "acme", { n: 1 });
    await settle();
    expect(onOne.at(-1)).toMatchObject({ kind: "message", payload: { n: 1 }, seq: 1 });
    expect(onTwo.at(-1)).toMatchObject({ kind: "message", payload: { n: 1 }, seq: 1 });
    expect(onBob.at(-1)).toMatchObject({ kind: "message", payload: { n: 1 }, seq: 1 });

    expect(await one.presence?.snapshot({ ...room, actor: alice })).toEqual({
      ok: true,
      snapshot: { count: 2, actorIds: ["alice", "bob"] },
    });

    // Simulate gateway two dying without cleanup: its heartbeat expires and gateway one sweeps it.
    hub.expireAll();
    await one.sweep();
    await settle();
    expect(onOne.at(-1)).toMatchObject({
      kind: "presence",
      event: "left",
      actorId: "bob",
      count: 1,
    });
    expect(await one.presence?.snapshot({ ...room, actor: alice })).toEqual({
      ok: true,
      snapshot: { count: 1, actorIds: ["alice"] },
    });
    await one.close();
    await two.close();
    expect(await one.health()).toEqual({ ok: false, adapter: "socket.io-redis", detail: "closed" });
  });

  it("reports health, tolerates malformed envelopes, and surfaces adapter errors", async () => {
    const hub = createMemoryRedisHub();
    const errors: string[] = [];
    const backend = createSocketIoRealtimeBackend({
      redis: hub.transport(),
      channels: [conformanceChannels.feed],
      gatewayId: "g1",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
      onError: (_error, context) => errors.push(context),
    });
    expect(await backend.health()).toMatchObject({ ok: false, detail: "not started" });
    await backend.start();
    await backend.start();
    expect(await backend.health()).toMatchObject({
      ok: true,
      detail: "gateway=g1 subscriptions=0",
    });

    const events: unknown[] = [];
    const sink = vi.fn((event: unknown) => {
      events.push(event);
      if (events.length === 1) throw new Error("sink exploded");
    });
    await backend.subscribe(
      {
        channelId: "conformance.feed",
        scopeKey: "alice",
        actor: alice,
        connectionId: "c",
        requestId,
      },
      sink,
    );
    const producer = hub.transport();
    await producer.publish(realtimeKeys().events, "garbage");
    await producer.publish(
      realtimeKeys().events,
      encodeEnvelope({
        v: 1,
        kind: "message",
        channel: "unknown.channel",
        scopeKey: "alice",
        payload: {},
        publishedAt: new Date().toISOString(),
        origin: "x",
      }),
    );
    await producer.publish(
      realtimeKeys().events,
      encodeEnvelope({
        v: 1,
        kind: "message",
        channel: "conformance.feed",
        scopeKey: "nobody",
        payload: {},
        publishedAt: new Date().toISOString(),
        origin: "x",
      }),
    );
    await backend.publish(conformanceChannels.feed, "alice", { n: 1 });
    await backend.publish(conformanceChannels.feed, "alice", { n: 2 });
    await settle();
    expect(events).toHaveLength(2);
    expect(errors).toEqual(["sink:g1:1"]);
    expect(() =>
      createSocketIoRealtimeBackend({ redis: hub.transport(), channels: [{} as never] }),
    ).toThrowError(expect.objectContaining({ code: "SHIP_REALTIME_CHANNEL_INVALID" }));
    await backend.close();
    await backend.close();
    expect(
      await backend.subscribe(
        {
          channelId: "conformance.feed",
          scopeKey: "alice",
          actor: alice,
          connectionId: "c",
          requestId,
        },
        sink,
      ),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it("exposes per-channel subscriber counts and the last publish through introspection", async () => {
    const hub = createMemoryRedisHub();
    const backend = createSocketIoRealtimeBackend({
      redis: hub.transport(),
      channels: [conformanceChannels.feed, conformanceChannels.room],
      tenantScopes: conformanceTenantScopes,
      gatewayId: "g1",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
    });
    await backend.start();
    expect(await backend.introspection?.channels()).toEqual([
      { channelId: "conformance.feed", subscribers: 0, scopes: 0 },
      { channelId: "conformance.room", subscribers: 0, scopes: 0 },
    ]);
    await backend.subscribe(
      {
        channelId: "conformance.feed",
        scopeKey: "alice",
        actor: alice,
        connectionId: "c1",
        requestId,
      },
      () => undefined,
    );
    await backend.subscribe(
      { channelId: "conformance.feed", scopeKey: "bob", actor: bob, connectionId: "c2", requestId },
      () => undefined,
    );
    await backend.publish(conformanceChannels.feed, "alice", { n: 1 });
    expect(await backend.introspection?.channels()).toMatchObject([
      {
        channelId: "conformance.feed",
        subscribers: 2,
        scopes: 2,
        lastPublishedAt: expect.any(Date),
        lastScopeKey: "alice",
      },
      { channelId: "conformance.room", subscribers: 0, scopes: 0 },
    ]);
    await backend.close();
  });

  it("fails presence operations closed when Redis misbehaves", async () => {
    const hub = createMemoryRedisHub();
    const base = hub.transport();
    let failing = false;
    const redis = {
      ...base,
      hgetall: async (key: string) => {
        if (failing) throw new Error("redis down");
        return base.hgetall(key);
      },
    };
    const errors: string[] = [];
    const backend = createSocketIoRealtimeBackend({
      redis,
      channels: [conformanceChannels.room],
      tenantScopes: conformanceTenantScopes,
      gatewayId: "g1",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
      onError: (_error, context) => errors.push(context),
    });
    await backend.start();
    const room = { channelId: "conformance.room", scopeKey: "acme", requestId };
    failing = true;
    expect(
      await backend.subscribe({ ...room, actor: alice, connectionId: "a1" }, () => undefined),
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await backend.presence?.snapshot({ ...room, actor: alice })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(errors).toEqual(["presence-join:g1:1", "presence-leave:g1:1", "presence-snapshot"]);
    await backend.sweep();
    failing = false;
    await backend.close();
  });

  it("records metrics with stable channel attributes", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const metrics = createRealtimeMetrics(provider.getMeter("test"));
    const feed = defineChannel({
      id: "activity.feed",
      scope: "actor",
      payload: z.object({ n: z.number() }),
    });
    const hub = createMemoryRedisHub();
    const backend = createSocketIoRealtimeBackend({
      redis: hub.transport(),
      channels: [feed],
      meter: provider.getMeter("test"),
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
    });
    await backend.start();
    await backend.subscribe(
      { channelId: "activity.feed", scopeKey: "alice", actor: alice, connectionId: "c", requestId },
      () => undefined,
    );
    await backend.publish(feed, "alice", { n: 1 });
    await settle();
    metrics.connections.add(1);
    await reader.forceFlush();
    const names = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
      .map((metric) => ({
        name: metric.descriptor.name,
        attributes: metric.dataPoints.map((point) => point.attributes),
      }));
    expect(names.map((metric) => metric.name).sort()).toEqual([
      "ship.realtime.connections",
      "ship.realtime.published",
      "ship.realtime.redis.lag",
      "ship.realtime.subscriptions",
    ]);
    const subscriptions = names.find((metric) => metric.name === "ship.realtime.subscriptions");
    expect(subscriptions?.attributes).toEqual([
      { [ATTR_CHANNEL_ID]: "activity.feed", [ATTR_CHANNEL_SCOPE]: "actor" },
    ]);
    expect(createRealtimeMetrics().channelAttributes("a.b", "tenant", { extra: 1 })).toEqual({
      "ship.channel.id": "a.b",
      "ship.channel.scope": "tenant",
      extra: 1,
    });
    await backend.close();
    await provider.shutdown();
  });
});

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
