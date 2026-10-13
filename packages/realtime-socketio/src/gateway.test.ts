import {
  createTenantScopeAuthority,
  defineActorResolver,
  defineApp,
  defineChannel,
  defineModule,
  operationActor,
  publicAccess,
} from "@sixthsummit/ship-core";
import { defineHonoCredentialAdapter } from "@sixthsummit/ship-hono";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRealtimeGateway, type RealtimeGateway } from "./gateway.js";
import { CLIENT_EVENTS, SERVER_EVENTS, SHIP_NAMESPACE } from "./protocol.js";
import { createMemoryRedisHub } from "./redis.js";

const payload = z.object({ n: z.number() });
const feed = defineChannel({ id: "activity.feed", scope: "actor", payload });
const room = defineChannel({ id: "tenant.room", scope: "tenant", payload, presence: true });
const board = defineChannel({
  id: "board.updates",
  scope: "resource",
  payload,
  authorizeSubscription: (actor, ref) => actor.permissions?.has(`board:${ref}`) ?? false,
});
const ticker = defineChannel({
  id: "board.ticker",
  scope: "actor",
  payload: z.object({ id: z.string(), n: z.number() }),
  coalesce: { windowMs: 30, key: (value) => value.id },
});
const channels = [feed, room, board, ticker];

const credentials = defineHonoCredentialAdapter<string>({
  id: "test.bearer",
  extract: (request) => request.headers.get("authorization")?.replace(/^Bearer /u, ""),
});
const actors = defineActorResolver<string>({
  id: "test.actors",
  resolve: ({ credential }) => {
    if (credential === undefined || credential === "nope")
      return { ok: false, reason: "invalid-credential" };
    if (credential === "forbidden") return { ok: false, reason: "forbidden" };
    if (credential === "down") return { ok: false, reason: "unavailable" };
    if (credential === "boom") throw new Error("resolver exploded");
    return {
      ok: true,
      actor: operationActor({
        id: credential,
        permissions: credential === "alice" ? ["tenant:acme", "board:shared"] : ["tenant:acme"],
      }),
    };
  },
});
const tenantScopes = createTenantScopeAuthority({
  id: "test.tenants",
  authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
});

const hub = createMemoryRedisHub();
const unexpected = vi.fn();
let freshSubscriptionGrant: (actorId: string | undefined) => boolean = () => true;
let one: RealtimeGateway;
let two: RealtimeGateway;
let urlOne = "";
let urlTwo = "";
const clients: Socket[] = [];

function connect(
  url: string,
  credential?: string,
  extraHeaders?: Record<string, string>,
): Promise<Socket> {
  const socket = io(`${url}${SHIP_NAMESPACE}`, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    ...(credential !== undefined ? { auth: { credential } } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
  });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => reject(error));
  });
}

async function connectError(url: string, credential?: string): Promise<unknown> {
  try {
    await connect(url, credential);
  } catch (error) {
    return (error as { data?: unknown }).data;
  }
  throw new Error("expected the handshake to fail");
}

function waitFor<TValue>(socket: Socket, event: string, count = 1): Promise<TValue[]> {
  return new Promise((resolve) => {
    const received: TValue[] = [];
    const handler = (value: TValue) => {
      received.push(value);
      if (received.length >= count) {
        socket.off(event, handler);
        resolve(received);
      }
    };
    socket.on(event, handler);
  });
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const application = defineApp({
    id: "gateway-fixture",
    modules: [
      defineModule({
        id: "activity",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        channels,
      }),
    ],
  });
  one = createRealtimeGateway({
    channels: application,
    auth: { credentials, actors },
    redis: hub.transport(),
    tenantScopes,
    gatewayId: "g1",
    heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
    limits: { controlBurst: 6, controlMessagesPerSecond: 1, maxSubscriptionsPerConnection: 3 },
    onUnexpectedError: unexpected,
    authorizeSubscription: ({ actor }) => freshSubscriptionGrant(actor?.id),
  });
  two = createRealtimeGateway({
    channels,
    auth: { credentials, actors, authorizationScheme: "Bearer" },
    redis: hub.transport(),
    tenantScopes,
    gatewayId: "g2",
    heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
  });
  const [a, b] = await Promise.all([one.listen(), two.listen()]);
  urlOne = `http://127.0.0.1:${a.port}`;
  urlTwo = `http://127.0.0.1:${b.port}`;
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await Promise.all([one.close(), two.close()]);
});

describe("createRealtimeGateway handshake", () => {
  it("resolves the credential through the application's resolver", async () => {
    const socket = await connect(urlOne, "alice");
    expect(socket.connected).toBe(true);
    expect(one.connections).toBe(1);
    socket.disconnect();
    await settle();
    expect(one.connections).toBe(0);
    const viaHeader = await connect(urlOne, undefined, { authorization: "Bearer bob" });
    expect(viaHeader.connected).toBe(true);
    viaHeader.disconnect();
  });

  it("rejects with the canonical connect_error codes", async () => {
    expect(await connectError(urlOne)).toEqual({
      code: "AUTHENTICATION_ERROR",
      message: "Authentication failed",
    });
    expect(await connectError(urlOne, "nope")).toMatchObject({ code: "AUTHENTICATION_ERROR" });
    expect(await connectError(urlOne, "forbidden")).toMatchObject({ code: "AUTHORIZATION_ERROR" });
    expect(await connectError(urlOne, "down")).toMatchObject({
      code: "AUTHENTICATION_UNAVAILABLE",
    });
    expect(await connectError(urlOne, "boom")).toMatchObject({
      code: "AUTHENTICATION_UNAVAILABLE",
    });
    expect(unexpected).toHaveBeenCalledWith(expect.any(Error), {
      gatewayId: "g1",
      connectionId: expect.any(String),
      phase: "handshake",
    });
  });
});

describe("createRealtimeGateway subscriptions", () => {
  it("denies new subscriptions on an already-open socket after its grant changes", async () => {
    const socket = await connect(urlOne, "alice");
    try {
      freshSubscriptionGrant = (actorId) => actorId !== "alice";
      expect(
        await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
          channel: "activity.feed",
          scopeKey: "alice",
        }),
      ).toMatchObject({ ok: false, code: "SUBSCRIPTION_FORBIDDEN" });
      expect(one.backend.subscriptionCount()).toBe(0);
      freshSubscriptionGrant = () => {
        throw new Error("grant source unavailable");
      };
      expect(
        await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
          channel: "activity.feed",
          scopeKey: "alice",
        }),
      ).toMatchObject({ ok: false, code: "SUBSCRIPTION_FORBIDDEN" });
      expect(one.backend.subscriptionCount()).toBe(0);
      expect(unexpected).toHaveBeenCalledWith(expect.any(Error), {
        gatewayId: "g1",
        connectionId: expect.any(String),
        phase: "subscription-authorization",
      });
    } finally {
      freshSubscriptionGrant = () => true;
      socket.disconnect();
    }
  });

  it("subscribes, delivers events with seq and publishedAt, and unsubscribes", async () => {
    const socket = await connect(urlOne, "alice");
    const ack = await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
      channel: "activity.feed",
      scopeKey: "alice",
    });
    expect(ack).toEqual({ ok: true, subscriptionId: expect.stringMatching(/^g1:\d+$/u) });
    const again = await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
      channel: "activity.feed",
      scopeKey: "alice",
    });
    expect(again).toEqual(ack);

    const events = waitFor<Record<string, unknown>>(socket, SERVER_EVENTS.event, 2);
    // Publishing from the other gateway proves the Redis hop, not a local shortcut.
    await two.backend.publish(feed, "alice", { n: 1 });
    await two.backend.publish(feed, "alice", { n: 2 });
    const [first, second] = await events;
    expect(first).toEqual({
      channel: "activity.feed",
      scopeKey: "alice",
      seq: 1,
      publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      payload: { n: 1 },
    });
    expect(second).toMatchObject({ seq: 2, payload: { n: 2 } });

    expect(
      await socket.emitWithAck(CLIENT_EVENTS.unsubscribe, { subscriptionId: "g1:999" }),
    ).toEqual({
      ok: false,
      code: "UNKNOWN_SUBSCRIPTION",
      message: expect.any(String),
    });
    expect(
      await socket.emitWithAck(CLIENT_EVENTS.unsubscribe, {
        subscriptionId: (ack as { subscriptionId: string }).subscriptionId,
      }),
    ).toEqual({ ok: true });
    const stray = vi.fn();
    socket.on(SERVER_EVENTS.event, stray);
    await two.backend.publish(feed, "alice", { n: 3 });
    await settle();
    expect(stray).not.toHaveBeenCalled();
    socket.disconnect();
  });

  it("answers subscribe failures with the canonical codes", async () => {
    const socket = await connect(urlTwo, "bob");
    const attempt = (message: unknown) => socket.emitWithAck(CLIENT_EVENTS.subscribe, message);
    expect(await attempt({ channel: "missing.channel", scopeKey: "bob" })).toMatchObject({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });
    expect(await attempt({ channel: "Nope", scopeKey: "bob" })).toMatchObject({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });
    expect(await attempt({ channel: "activity.feed", scopeKey: "alice" })).toMatchObject({
      ok: false,
      code: "INVALID_SCOPE",
    });
    expect(await attempt({ channel: "activity.feed", scopeKey: "bad key" })).toMatchObject({
      ok: false,
      code: "INVALID_SCOPE",
    });
    expect(await attempt({ channel: "tenant.room", scopeKey: "other" })).toMatchObject({
      ok: false,
      code: "SUBSCRIPTION_FORBIDDEN",
    });
    expect(await attempt({ channel: "board.updates", scopeKey: "shared" })).toMatchObject({
      ok: false,
      code: "SUBSCRIPTION_FORBIDDEN",
    });
    expect(await attempt(null)).toMatchObject({ ok: false, code: "CHANNEL_NOT_FOUND" });
    socket.emit(CLIENT_EVENTS.subscribe, { channel: "activity.feed", scopeKey: "bob" });
    await settle();
    socket.disconnect();
  });

  it("rate-limits control messages and caps subscriptions per connection", async () => {
    const socket = await connect(urlOne, "alice");
    const acks = [];
    for (const scopeKey of ["alice", "alice", "alice"]) {
      acks.push(
        await socket.emitWithAck(CLIENT_EVENTS.subscribe, { channel: "board.ticker", scopeKey }),
      );
    }
    expect(acks.every((ack) => (ack as { ok: boolean }).ok)).toBe(true);
    expect(
      await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
        channel: "activity.feed",
        scopeKey: "alice",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
        channel: "tenant.room",
        scopeKey: "acme",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
        channel: "board.updates",
        scopeKey: "shared",
      }),
    ).toEqual({
      ok: false,
      code: "RATE_LIMITED",
      message: "Subscription limit reached",
    });
    expect(await socket.emitWithAck(CLIENT_EVENTS.unsubscribe, { subscriptionId: "x" })).toEqual({
      ok: false,
      code: "UNKNOWN_SUBSCRIPTION",
      message: "Too many control messages",
    });
    expect(
      await socket.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "tenant.room",
        scopeKey: "acme",
      }),
    ).toMatchObject({
      ok: false,
      code: "SUBSCRIPTION_FORBIDDEN",
      message: "Too many control messages",
    });
    socket.disconnect();
    await settle();
    expect(one.backend.subscriptionCount()).toBe(0);
  });

  it("coalesces bursts inside the declared window", async () => {
    const socket = await connect(urlTwo, "alice");
    await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
      channel: "board.ticker",
      scopeKey: "alice",
    });
    const events = waitFor<Record<string, unknown>>(socket, SERVER_EVENTS.event, 2);
    await one.backend.publish(ticker, "alice", { id: "x", n: 1 });
    await one.backend.publish(ticker, "alice", { id: "x", n: 2 });
    await one.backend.publish(ticker, "alice", { id: "y", n: 3 });
    await one.backend.publish(ticker, "alice", { id: "x", n: 4 });
    const received = await events;
    await settle(60);
    expect(received.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        { id: "x", n: 4 },
        { id: "y", n: 3 },
      ]),
    );
    socket.disconnect();
  });
});

describe("createRealtimeGateway presence", () => {
  it("tracks presence per actor across gateways and serves snapshots", async () => {
    const aliceOne = await connect(urlOne, "alice");
    const aliceTwo = await connect(urlTwo, "alice");
    const bobTwo = await connect(urlTwo, "bob");
    const joined = waitFor<Record<string, unknown>>(aliceOne, SERVER_EVENTS.presence, 1);
    await aliceOne.emitWithAck(CLIENT_EVENTS.subscribe, {
      channel: "tenant.room",
      scopeKey: "acme",
    });
    expect(await joined).toEqual([
      { channel: "tenant.room", scopeKey: "acme", kind: "joined", actorId: "alice", count: 1 },
    ]);
    await aliceTwo.emitWithAck(CLIENT_EVENTS.subscribe, {
      channel: "tenant.room",
      scopeKey: "acme",
    });
    await settle();
    const bobJoined = waitFor<Record<string, unknown>>(aliceTwo, SERVER_EVENTS.presence, 1);
    await bobTwo.emitWithAck(CLIENT_EVENTS.subscribe, { channel: "tenant.room", scopeKey: "acme" });
    expect(await bobJoined).toEqual([
      { channel: "tenant.room", scopeKey: "acme", kind: "joined", actorId: "bob", count: 2 },
    ]);

    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "tenant.room",
        scopeKey: "acme",
      }),
    ).toEqual({
      ok: true,
      count: 2,
      members: ["alice", "bob"],
    });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "activity.feed",
        scopeKey: "bob",
      }),
    ).toMatchObject({ ok: false, code: "PRESENCE_DISABLED" });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "tenant.room",
        scopeKey: "other",
      }),
    ).toMatchObject({ ok: false, code: "SUBSCRIPTION_FORBIDDEN" });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "missing.channel",
        scopeKey: "x",
      }),
    ).toMatchObject({ ok: false, code: "CHANNEL_NOT_FOUND" });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "tenant.room",
        scopeKey: "bad key",
      }),
    ).toMatchObject({ ok: false, code: "SUBSCRIPTION_FORBIDDEN" });
    expect(await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, 42)).toMatchObject({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });
    // Paging: one member per page, cursor carried back, whole count on every page.
    const pageOne = (await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
      channel: "tenant.room",
      scopeKey: "acme",
      limit: 1,
    })) as { ok: true; count: number; members: string[]; nextCursor?: string };
    expect(pageOne).toEqual({ ok: true, count: 2, members: ["alice"], nextCursor: "alice" });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "tenant.room",
        scopeKey: "acme",
        limit: 1,
        cursor: pageOne.nextCursor,
      }),
    ).toEqual({ ok: true, count: 2, members: ["bob"] });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "tenant.room",
        scopeKey: "acme",
        limit: 0,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_PAGE" });
    // Cluster-wide online query: alice is connected through gateway one only.
    const online = (actorId: string) =>
      bobTwo.emitWithAck(CLIENT_EVENTS.presenceOnline, {
        channel: "tenant.room",
        scopeKey: "acme",
        actorId,
      });
    expect(await online("alice")).toEqual({ ok: true, online: true });
    expect(await online("nobody")).toEqual({ ok: true, online: false });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceOnline, {
        channel: "tenant.room",
        scopeKey: "other",
        actorId: "alice",
      }),
    ).toMatchObject({ ok: false, code: "SUBSCRIPTION_FORBIDDEN" });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceOnline, {
        channel: "activity.feed",
        scopeKey: "bob",
        actorId: "bob",
      }),
    ).toMatchObject({ ok: false, code: "PRESENCE_DISABLED" });
    expect(
      await bobTwo.emitWithAck(CLIENT_EVENTS.presenceOnline, {
        channel: "tenant.room",
        scopeKey: "acme",
      }),
    ).toMatchObject({ ok: false, code: "SUBSCRIPTION_FORBIDDEN" });
    expect(await bobTwo.emitWithAck(CLIENT_EVENTS.presenceOnline, 42)).toMatchObject({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });

    const presence = vi.fn();
    bobTwo.on(SERVER_EVENTS.presence, presence);
    aliceOne.disconnect();
    await settle();
    expect(presence).not.toHaveBeenCalled();
    const left = waitFor<Record<string, unknown>>(bobTwo, SERVER_EVENTS.presence, 1);
    aliceTwo.disconnect();
    expect(await left).toEqual([
      { channel: "tenant.room", scopeKey: "acme", kind: "left", actorId: "alice", count: 1 },
    ]);
    bobTwo.disconnect();
  });
});

describe("createRealtimeGateway lifecycle", () => {
  it("reports health and validates options", async () => {
    expect(await one.health()).toMatchObject({ ok: true, adapter: "socket.io-redis" });
    expect(one.gatewayId).toBe("g1");
    expect(one.io).toBeDefined();
    expect(() =>
      createRealtimeGateway({
        channels,
        auth: { credentials: {} as never, actors },
        redis: hub.transport(),
      }),
    ).toThrowError(expect.objectContaining({ code: "SHIP_REALTIME_BACKEND_INVALID" }));
    expect(() =>
      createRealtimeGateway({
        channels: {} as never,
        auth: { credentials, actors },
        redis: hub.transport(),
      }),
    ).toThrowError(expect.objectContaining({ code: "SHIP_REALTIME_CHANNEL_INVALID" }));
  });

  it("disconnects clients when closed and reuses a provided server", async () => {
    const { createServer } = await import("node:http");
    const server = createServer();
    const gateway = createRealtimeGateway({
      channels,
      auth: { credentials, actors, handshakeAccess: publicAccess() },
      redis: hub.transport(),
      server,
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
      generateRequestId: () => "fixed",
    });
    const address = await gateway.listen();
    const socket = await connect(`http://127.0.0.1:${address.port}`, "carol");
    const disconnected = new Promise<string>((resolve) => socket.once("disconnect", resolve));
    await gateway.close();
    expect(await disconnected).toBe("io server disconnect");
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
