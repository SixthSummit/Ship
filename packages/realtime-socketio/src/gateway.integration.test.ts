/**
 * Multi-process integration: one API process and two gateway processes over
 * a disposable Redis. Proves cross-process delivery, presence dedupe with a
 * gateway crash, slow-subscriber isolation with flat API publish latency,
 * and a 60 s load run at a declared rate (numbers recorded in ADR-0017).
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  createServer,
  type Server as NetServer,
  type Socket as NetSocket,
  connect as netConnect,
} from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { io, type Socket } from "socket.io-client";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors, channels, credentials, percentile, tenantScopes } from "./__fixtures__/shared.js";
import { createRealtimeGateway } from "./gateway.js";
import { CLIENT_EVENTS, SERVER_EVENTS, SHIP_NAMESPACE } from "./protocol.js";
import { createIoredisTransport } from "./redis.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
/** Direct Node children (not the tsx CLI wrapper) so SIGKILL really kills the gateway. */
const nodeArguments = ["--import", "tsx"];
const LOAD_RATE_PER_SECOND = 500;
const LOAD_DURATION_MS = 60_000;

interface Managed {
  readonly process: ChildProcess;
  readonly port: number;
  readonly stderr: string[];
}

let redis: StartedTestContainer;
let redisUrl = "";
let api: Managed;
let gatewayA: Managed;
let gatewayB: Managed;
const sockets: Socket[] = [];
const servers: NetServer[] = [];

function spawnFixture(script: string, env: Record<string, string>): Promise<Managed> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [...nodeArguments, resolve(here, "__fixtures__", script)],
      {
        cwd: packageRoot,
        env: { ...process.env, ...env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n").find((candidate) => candidate.includes('"ready":true'));
      if (line) resolvePromise({ process: child, port: JSON.parse(line).port, stderr });
    });
    child.once("exit", (code) =>
      reject(new Error(`${script} exited early with ${code}: ${stderr.join("")}`)),
    );
  });
}

async function stop(
  managed: Managed | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (!managed || managed.process.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    managed.process.once("exit", () => resolvePromise());
    managed.process.kill(signal);
  });
}

async function control(command: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${api.port}/publish`, {
    method: "POST",
    body: JSON.stringify(command),
  });
  return (await response.json()) as Record<string, any>;
}

function connect(port: number, actorId: string): Promise<Socket> {
  const socket = io(`http://127.0.0.1:${port}${SHIP_NAMESPACE}`, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    auth: { credential: actorId },
  });
  sockets.push(socket);
  return new Promise((resolvePromise, reject) => {
    socket.once("connect", () => resolvePromise(socket));
    socket.once("connect_error", reject);
  });
}

function subscribe(
  socket: Socket,
  channel: string,
  scopeKey: string,
): Promise<{ ok: boolean; subscriptionId?: string }> {
  return socket.emitWithAck(CLIENT_EVENTS.subscribe, { channel, scopeKey });
}

function collect<TValue>(socket: Socket, event: string): TValue[] {
  const received: TValue[] = [];
  socket.on(event, (value: TValue) => received.push(value));
  return received;
}

function until(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolvePromise();
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const settle = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** A TCP proxy whose upstream reads can be paused to create real backpressure. */
function createPausableProxy(
  targetPort: number,
): Promise<{ port: number; pause(): void; resume(): void }> {
  const links: { client: NetSocket; upstream: NetSocket }[] = [];
  const server = createServer((client) => {
    const upstream = netConnect(targetPort, "127.0.0.1");
    links.push({ client, upstream });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  servers.push(server);
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({
        port: typeof address === "object" && address ? address.port : 0,
        pause: () => {
          for (const link of links) link.upstream.pause();
        },
        resume: () => {
          for (const link of links) link.upstream.resume();
        },
      });
    });
  });
}

beforeAll(async () => {
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  const common = {
    REDIS_URL: redisUrl,
    HEARTBEAT_MS: "300",
    HEARTBEAT_TTL_MS: "1000",
    SEND_BUFFER: "200",
  };
  [api, gatewayA, gatewayB] = await Promise.all([
    spawnFixture("api-process.ts", { REDIS_URL: redisUrl }),
    spawnFixture("gateway-process.ts", { ...common, GATEWAY_ID: "gateway-a" }),
    spawnFixture("gateway-process.ts", { ...common, GATEWAY_ID: "gateway-b" }),
  ]);
}, 120_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  for (const server of servers) server.close();
  await Promise.all([stop(api), stop(gatewayA), stop(gatewayB)]);
  await redis?.stop();
}, 60_000);

describe("realtime gateway processes over Redis", () => {
  it("checks fresh grants on two gateway processes before post-revocation delivery", async () => {
    const one = await spawnFixture("gateway-process.ts", {
      REDIS_URL: redisUrl,
      GATEWAY_ID: "revocation-one",
      AUTHORIZE_DELIVERY: "true",
    });
    const two = await spawnFixture("gateway-process.ts", {
      REDIS_URL: redisUrl,
      GATEWAY_ID: "revocation-two",
      AUTHORIZE_DELIVERY: "true",
    });
    const grants = new Redis(redisUrl);
    try {
      const aliceOne = await connect(one.port, "alice");
      const aliceTwo = await connect(two.port, "alice");
      const bob = await connect(two.port, "bob");
      const eventsOne = collect(aliceOne, SERVER_EVENTS.event);
      const eventsTwo = collect(aliceTwo, SERVER_EVENTS.event);
      const bobEvents = collect(bob, SERVER_EVENTS.event);
      expect(await subscribe(aliceOne, "fixture.feed", "alice")).toMatchObject({ ok: true });
      expect(await subscribe(aliceTwo, "fixture.feed", "alice")).toMatchObject({ ok: true });
      expect(await subscribe(bob, "fixture.feed", "bob")).toMatchObject({ ok: true });
      await control({ channel: "feed", scopeKey: "alice" });
      await until(
        () => eventsOne.length === 1 && eventsTwo.length === 1,
        5_000,
        "baseline delivery",
      );

      await grants.set("realtime:revoked:alice", "1");
      const goneOne = new Promise<void>((resolvePromise) =>
        aliceOne.once("disconnect", () => resolvePromise()),
      );
      const goneTwo = new Promise<void>((resolvePromise) =>
        aliceTwo.once("disconnect", () => resolvePromise()),
      );
      await control({ channel: "feed", scopeKey: "alice" });
      await Promise.all([goneOne, goneTwo]);
      expect(eventsOne).toHaveLength(1);
      expect(eventsTwo).toHaveLength(1);
      await control({ channel: "feed", scopeKey: "bob" });
      await until(() => bobEvents.length === 1, 5_000, "unaffected actor delivery");
      expect(bob.connected).toBe(true);
    } finally {
      await grants.del("realtime:revoked:alice");
      grants.disconnect();
      await Promise.all([stop(one), stop(two)]);
    }
  }, 60_000);

  it("holds queued delivery behind a shared grant fence on both gateways", async () => {
    const firstId = "fenced-one";
    const secondId = "fenced-two";
    const one = await spawnFixture("gateway-process.ts", {
      REDIS_URL: redisUrl,
      GATEWAY_ID: firstId,
      FENCED_DELIVERY: "true",
    });
    const two = await spawnFixture("gateway-process.ts", {
      REDIS_URL: redisUrl,
      GATEWAY_ID: secondId,
      FENCED_DELIVERY: "true",
    });
    const grants = new Redis(redisUrl);
    const keys = [firstId, secondId].map((id) => `realtime:queued:alice:${id}`);
    const checked = [firstId, secondId].map((id) => `realtime:checked:alice:${id}`);
    const lockKey = "realtime:grant-lock:alice";
    const lockToken = crypto.randomUUID();
    try {
      const aliceOne = await connect(one.port, "alice");
      const aliceTwo = await connect(two.port, "alice");
      const bob = await connect(two.port, "bob");
      const aliceOneEvents = collect(aliceOne, SERVER_EVENTS.event);
      const aliceTwoEvents = collect(aliceTwo, SERVER_EVENTS.event);
      const bobEvents = collect(bob, SERVER_EVENTS.event);
      expect(await subscribe(aliceOne, "fixture.feed", "alice")).toMatchObject({ ok: true });
      expect(await subscribe(aliceTwo, "fixture.feed", "alice")).toMatchObject({ ok: true });
      expect(await subscribe(bob, "fixture.feed", "bob")).toMatchObject({ ok: true });
      await control({ channel: "feed", scopeKey: "alice" });
      await until(
        () => aliceOneEvents.length === 1 && aliceTwoEvents.length === 1,
        5_000,
        "fenced baseline delivery",
      );

      await grants.del(...keys, ...checked);
      await grants.set("realtime:pause:alice", "1");
      await control({ channel: "feed", scopeKey: "alice" });
      const deadline = Date.now() + 2_000;
      while ((await grants.mget(...keys)).some((value) => value !== "1") && Date.now() < deadline) {
        await settle(10);
      }
      expect(await grants.mget(...keys)).toEqual(["1", "1"]);
      // The application grant writer takes the same lock as both delivery
      // callbacks, commits revocation, then allows the queued callbacks to run.
      expect(await grants.set(lockKey, lockToken, "PX", 5_000, "NX")).toBe("OK");
      await grants.set("realtime:revoked:alice", "1");
      await grants.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        lockKey,
        lockToken,
      );
      await grants.del("realtime:pause:alice");
      const disconnected = () => !aliceOne.connected && !aliceTwo.connected;
      await until(disconnected, 5_000, "revoked sockets to disconnect");
      expect(await grants.mget(...checked)).toEqual(["revoked", "revoked"]);
      expect(aliceOneEvents).toHaveLength(1);
      expect(aliceTwoEvents).toHaveLength(1);

      const reopened = await connect(one.port, "alice");
      expect(await subscribe(reopened, "fixture.feed", "alice")).toMatchObject({
        ok: false,
        code: "SUBSCRIPTION_FORBIDDEN",
      });
      await control({ channel: "feed", scopeKey: "bob" });
      await until(() => bobEvents.length === 1, 5_000, "unaffected actor delivery");
      expect(bob.connected).toBe(true);
    } finally {
      await grants.del(
        "realtime:pause:alice",
        "realtime:revoked:alice",
        lockKey,
        ...keys,
        ...checked,
      );
      grants.disconnect();
      await Promise.all([stop(one), stop(two)]);
    }
  }, 60_000);

  it("suppresses a queued revoked event and reports a pub/sub interruption", async () => {
    const commands = new Redis(redisUrl, { enableOfflineQueue: false, lazyConnect: true });
    const subscriber = new Redis(redisUrl, { enableOfflineQueue: false, lazyConnect: true });
    const writer = new Redis(redisUrl);
    await Promise.all([commands.connect(), subscriber.connect()]);
    let entered!: () => void;
    let release!: () => void;
    const atFence = new Promise<void>((resolvePromise) => {
      entered = resolvePromise;
    });
    const held = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const gateway = createRealtimeGateway({
      channels,
      auth: { credentials, actors },
      tenantScopes,
      redis: createIoredisTransport({ clients: { commands, subscriber } }),
      gatewayId: "pubsub-interruption",
      heartbeat: { intervalMs: 60_000, ttlMs: 120_000 },
      authorizeSubscription: async ({ actor }) =>
        Boolean(actor && (await commands.get(`realtime:revoked:${actor.id}`)) !== "1"),
      withAuthorizedDelivery: async ({ actor }, deliver) => {
        if (!actor) throw new Error("missing actor");
        entered();
        await held;
        if ((await commands.get(`realtime:revoked:${actor.id}`)) !== "1") deliver();
      },
    });
    try {
      const address = await gateway.listen(0, "127.0.0.1");
      const alice = await connect(address.port, "alice");
      const events = collect(alice, SERVER_EVENTS.event);
      expect(await subscribe(alice, "fixture.feed", "alice")).toMatchObject({ ok: true });
      expect((await gateway.health()).ok).toBe(true);
      await control({ channel: "feed", scopeKey: "alice" });
      await atFence;
      await writer.set("realtime:revoked:alice", "1");
      subscriber.disconnect();
      release();
      await until(() => !alice.connected, 5_000, "revoked queued socket to disconnect");
      expect(events).toHaveLength(0);
      expect(await gateway.health()).toMatchObject({ ok: false, adapter: "socket.io-redis" });
    } finally {
      release();
      await gateway.close().catch(() => undefined);
      await writer.del("realtime:revoked:alice");
      await Promise.allSettled([commands.quit(), writer.quit()]);
      subscriber.disconnect();
    }
  }, 30_000);

  it("delivers API publications to subscribers on both gateway processes", async () => {
    const onA = await connect(gatewayA.port, "alice");
    const onB = await connect(gatewayB.port, "alice");
    const eventsA = collect<Record<string, unknown>>(onA, SERVER_EVENTS.event);
    const eventsB = collect<Record<string, unknown>>(onB, SERVER_EVENTS.event);
    expect(await subscribe(onA, "fixture.feed", "alice")).toMatchObject({ ok: true });
    expect(await subscribe(onB, "fixture.feed", "alice")).toMatchObject({ ok: true });

    const result = await control({ channel: "feed", scopeKey: "alice", count: 3 });
    expect(result.published).toBe(3);
    await until(
      () => eventsA.length === 3 && eventsB.length === 3,
      5_000,
      "cross-process delivery",
    );
    expect(eventsA.map((event) => (event.payload as { n: number }).n)).toEqual([1, 2, 3]);
    expect(eventsB.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(eventsA[0]).toMatchObject({
      channel: "fixture.feed",
      scopeKey: "alice",
      publishedAt: expect.any(String),
    });
    const health = await (await fetch(`http://127.0.0.1:${api.port}/health`)).json();
    expect(health).toMatchObject({ ok: true, adapter: "socket.io-redis" });
    onA.disconnect();
    onB.disconnect();
  });

  it("dedupes presence for a two-connection actor and survives a gateway crash", async () => {
    const aliceA = await connect(gatewayA.port, "alice");
    const aliceB = await connect(gatewayB.port, "alice");
    const bobA = await connect(gatewayA.port, "bob");
    const seenByBob = collect<Record<string, unknown>>(bobA, SERVER_EVENTS.presence);
    expect(await subscribe(bobA, "fixture.room", "acme")).toMatchObject({ ok: true });
    await until(() => seenByBob.length === 1, 5_000, "bob joined");
    expect(await subscribe(aliceA, "fixture.room", "acme")).toMatchObject({ ok: true });
    await until(() => seenByBob.length === 2, 5_000, "alice joined");
    expect(seenByBob[1]).toEqual({
      channel: "fixture.room",
      scopeKey: "acme",
      kind: "joined",
      actorId: "alice",
      count: 2,
    });
    expect(await subscribe(aliceB, "fixture.room", "acme")).toMatchObject({ ok: true });
    await settle(300);
    expect(seenByBob).toHaveLength(2);
    expect(
      await bobA.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "fixture.room",
        scopeKey: "acme",
      }),
    ).toEqual({
      ok: true,
      count: 2,
      members: ["alice", "bob"],
    });

    // Crash gateway B without cleanup. Alice keeps her connection on A, so she stays present.
    await stop(gatewayB, "SIGKILL");
    await settle(2_500);
    expect(seenByBob).toHaveLength(2);
    expect(
      await bobA.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "fixture.room",
        scopeKey: "acme",
      }),
    ).toEqual({
      ok: true,
      count: 2,
      members: ["alice", "bob"],
    });

    // Restart B: membership recorded in Redis is still visible from the new process.
    gatewayB = await spawnFixture("gateway-process.ts", {
      REDIS_URL: redisUrl,
      HEARTBEAT_MS: "300",
      HEARTBEAT_TTL_MS: "1000",
      SEND_BUFFER: "200",
      GATEWAY_ID: "gateway-b",
    });
    const carolB = await connect(gatewayB.port, "carol");
    expect(
      await carolB.emitWithAck(CLIENT_EVENTS.presenceSnapshot, {
        channel: "fixture.room",
        scopeKey: "acme",
      }),
    ).toEqual({
      ok: true,
      count: 2,
      members: ["alice", "bob"],
    });

    aliceA.disconnect();
    await until(() => seenByBob.length === 3, 5_000, "alice left");
    expect(seenByBob[2]).toEqual({
      channel: "fixture.room",
      scopeKey: "acme",
      kind: "left",
      actorId: "alice",
      count: 1,
    });
    bobA.disconnect();
    carolB.disconnect();
  }, 30_000);

  it("isolates a slow subscriber and keeps API publish latency flat", async () => {
    const proxy = await createPausableProxy(gatewayA.port);
    const slow = await connect(proxy.port, "alice");
    const fast = await connect(gatewayA.port, "alice");
    const fastEvents = collect<Record<string, unknown>>(fast, SERVER_EVENTS.event);
    const slowEvents = collect<Record<string, unknown>>(slow, SERVER_EVENTS.event);
    const dropped = collect<Record<string, unknown>>(slow, SERVER_EVENTS.dropped);
    expect(await subscribe(slow, "fixture.feed", "alice")).toMatchObject({ ok: true });
    expect(await subscribe(fast, "fixture.feed", "alice")).toMatchObject({ ok: true });

    const baseline = await control({
      channel: "feed",
      scopeKey: "alice",
      count: 500,
      paddingBytes: 2_048,
    });
    await until(
      () => fastEvents.length === 500 && slowEvents.length === 500,
      10_000,
      "warm-up delivery",
    );

    proxy.pause();
    const stalled = await control({
      channel: "feed",
      scopeKey: "alice",
      count: 4_000,
      paddingBytes: 2_048,
    });
    await until(() => fastEvents.length === 4_500, 15_000, "fast subscriber receives everything");
    expect(slowEvents.length).toBeLessThan(4_500);
    // publish() hands off to a local queue; a stalled peer on the gateway must not show up here.
    expect(stalled.publishLatencyMs.p95).toBeLessThan(
      Math.max(5, baseline.publishLatencyMs.p95 * 5),
    );
    expect(stalled.publishLatencyMs.p99).toBeLessThan(25);

    proxy.resume();
    await until(() => dropped.length > 0, 10_000, "drop report after the peer catches up");
    expect(dropped[0]).toMatchObject({
      channel: "fixture.feed",
      scopeKey: "alice",
      dropped: expect.any(Number),
    });
    expect(slowEvents.length + (dropped[0] as { dropped: number }).dropped).toBeLessThanOrEqual(
      4_500,
    );
    process.stdout.write(
      `slow-subscriber: baseline p95=${baseline.publishLatencyMs.p95}ms stalled p95=${stalled.publishLatencyMs.p95}ms p99=${stalled.publishLatencyMs.p99}ms dropped=${(dropped[0] as { dropped: number }).dropped}\n`,
    );
    slow.disconnect();
    fast.disconnect();
  }, 60_000);

  it("disconnects a slow subscriber of a disconnect-policy channel", async () => {
    const proxy = await createPausableProxy(gatewayA.port);
    const slow = await connect(proxy.port, "alice");
    const disconnected = new Promise<string>((resolvePromise) =>
      slow.once("disconnect", resolvePromise),
    );
    expect(await subscribe(slow, "fixture.strict", "alice")).toMatchObject({ ok: true });
    proxy.pause();
    await control({ channel: "strict", scopeKey: "alice", count: 3_000, paddingBytes: 2_048 });
    proxy.resume();
    expect(await disconnected).toMatch(/io server disconnect|transport close/u);
  }, 60_000);

  it(`sustains ${LOAD_RATE_PER_SECOND}/s for ${LOAD_DURATION_MS / 1_000}s across two gateway processes`, async () => {
    const onA = await connect(gatewayA.port, "load");
    const onB = await connect(gatewayB.port, "load");
    const latenciesA: number[] = [];
    const latenciesB: number[] = [];
    let countA = 0;
    let countB = 0;
    onA.on(SERVER_EVENTS.event, (event: { payload: { sentAt: number } }) => {
      countA += 1;
      latenciesA.push(Date.now() - event.payload.sentAt);
    });
    onB.on(SERVER_EVENTS.event, (event: { payload: { sentAt: number } }) => {
      countB += 1;
      latenciesB.push(Date.now() - event.payload.sentAt);
    });
    expect(await subscribe(onA, "fixture.feed", "load")).toMatchObject({ ok: true });
    expect(await subscribe(onB, "fixture.feed", "load")).toMatchObject({ ok: true });

    const count = (LOAD_RATE_PER_SECOND * LOAD_DURATION_MS) / 1_000;
    const result = await control({
      channel: "feed",
      scopeKey: "load",
      count,
      ratePerSecond: LOAD_RATE_PER_SECOND,
    });
    await until(() => countA >= count && countB >= count, 15_000, "every load event delivered");
    const summary = {
      rate: LOAD_RATE_PER_SECOND,
      durationMs: result.elapsedMs,
      achievedRate: result.achievedRate,
      published: result.published,
      deliveredA: countA,
      deliveredB: countB,
      publishLatencyMs: result.publishLatencyMs,
      endToEndMs: {
        a: {
          p50: percentile(latenciesA, 0.5),
          p95: percentile(latenciesA, 0.95),
          p99: percentile(latenciesA, 0.99),
        },
        b: {
          p50: percentile(latenciesB, 0.5),
          p95: percentile(latenciesB, 0.95),
          p99: percentile(latenciesB, 0.99),
        },
      },
      gatewayStderr: [...gatewayA.stderr, ...gatewayB.stderr].length,
    };
    process.stdout.write(`load-test: ${JSON.stringify(summary)}\n`);
    expect(countA).toBe(count);
    expect(countB).toBe(count);
    expect(result.achievedRate).toBeGreaterThan(LOAD_RATE_PER_SECOND * 0.9);
    expect(result.publishLatencyMs.p95).toBeLessThan(5);
    onA.disconnect();
    onB.disconnect();
  }, 150_000);
});
