import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Meter } from "@opentelemetry/api";
import type {
  ActorResolver,
  AnyChannel,
  AnyModule,
  CompiledApplication,
  OperationAccess,
  OperationActor,
  RealtimeBackendHealth,
  RealtimeEvent,
  TenantScopeAuthority,
} from "@sixthsummit/ship-core";
import {
  isActorResolver,
  normalizeActorResolution,
  operationActor,
  RealtimeError,
  realtimeHandshakeOperation,
} from "@sixthsummit/ship-core";
import { type HonoCredentialAdapter, isHonoCredentialAdapter } from "@sixthsummit/ship-hono";
import { Server, type ServerOptions, type Socket } from "socket.io";
import { createSocketIoRealtimeBackend, type SocketIoRealtimeBackend } from "./backend.js";
import { type ConnectionQueue, createConnectionQueue } from "./connection.js";
import { ATTR_DROP_REASON, createRealtimeMetrics } from "./metrics.js";
import {
  CLIENT_EVENTS,
  handshakeErrorFor,
  type PresenceOnlineAck,
  type PresenceSnapshotAck,
  parsePresenceOnlineMessage,
  parsePresenceSnapshotMessage,
  parseSubscribeMessage,
  parseUnsubscribeMessage,
  presenceErrorFor,
  SERVER_EVENTS,
  SHIP_NAMESPACE,
  type SubscribeAck,
  subscribeErrorFor,
  type UnsubscribeAck,
} from "./protocol.js";
import { withTimeout } from "./publisher.js";
import { createTokenBucket } from "./rate-limit.js";
import type { RealtimeRedis } from "./redis.js";

const DEFAULT_MAX_SUBSCRIPTIONS = 100;
const DEFAULT_CONTROL_MESSAGES_PER_SECOND = 20;
const DEFAULT_CONTROL_BURST = 40;
const DEFAULT_SEND_BUFFER_HIGH_WATER_MARK = 1_000;
const DEFAULT_AUTHORIZATION_SCHEME = "Bearer";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface RealtimeGatewayAuth<TCredential = unknown> {
  /** The same credential adapter the HTTP adapter uses (ADR-0004). */
  readonly credentials: HonoCredentialAdapter<TCredential>;
  /** The same actor resolver the HTTP adapter uses. There is no second auth path. */
  readonly actors: ActorResolver<TCredential>;
  /** Access the resolver sees for the synthetic realtime.connect operation. Defaults to authenticated. */
  readonly handshakeAccess?: OperationAccess;
  /** Scheme prepended to `auth.credential` when materializing the Authorization header. */
  readonly authorizationScheme?: string;
}

export interface RealtimeGatewayLimits {
  readonly maxSubscriptionsPerConnection?: number;
  readonly controlMessagesPerSecond?: number;
  readonly controlBurst?: number;
  /** Events buffered per connection before the channel's slowSubscriber policy applies. */
  readonly sendBufferHighWaterMark?: number;
}

export interface CreateRealtimeGatewayOptions<TCredential = unknown> {
  /** A compiled application (channels are read from its modules) or an explicit channel list. */
  readonly channels: readonly AnyChannel[] | CompiledApplication<string, readonly AnyModule[]>;
  readonly auth: RealtimeGatewayAuth<TCredential>;
  readonly redis: RealtimeRedis | { readonly url: string };
  readonly tenantScopes?: TenantScopeAuthority;
  /** Attach to an existing HTTP server; otherwise the gateway owns one. */
  readonly server?: HttpServer;
  readonly socketIo?: Partial<ServerOptions>;
  readonly limits?: RealtimeGatewayLimits;
  readonly gatewayId?: string;
  readonly keyPrefix?: string;
  readonly heartbeat?: { readonly intervalMs?: number; readonly ttlMs?: number };
  readonly meter?: Meter;
  readonly generateRequestId?: () => string;
  readonly onUnexpectedError?: (error: unknown, context: RealtimeGatewayErrorContext) => void;
  /**
   * Optional fresh authorization before every outbound event (including events
   * waiting in a slow connection's queue). False or an error closes the socket.
   * The application must read its current grant source; the handshake actor is
   * only an identity hint and may have stale permissions or tenant scopes.
   */
  readonly authorizeDelivery?: (input: {
    readonly actor: OperationActor | undefined;
    readonly channelId: string;
    readonly scopeKey: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean> | boolean;
  /**
   * Optional fresh grant check before accepting each subscription request.
   * The handshake actor is an identity hint, not proof that its old grants still
   * apply. False, an error, or a timeout denies the request.
   */
  readonly authorizeSubscription?: (input: {
    readonly actor: OperationActor | undefined;
    readonly channelId: string;
    readonly scopeKey: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean> | boolean;
  /** Transactional grant fence: authorize, then call deliver before releasing the writer-conflicting lock. */
  readonly withAuthorizedDelivery?: (
    input: {
      readonly actor: OperationActor | undefined;
      readonly channelId: string;
      readonly scopeKey: string;
      readonly signal: AbortSignal;
    },
    deliver: () => void,
  ) => Promise<void> | void;
}

export interface RealtimeGatewayErrorContext {
  readonly gatewayId: string;
  readonly connectionId?: string;
  readonly phase: string;
}

export interface RealtimeGateway {
  readonly io: Server;
  readonly server: HttpServer;
  readonly backend: SocketIoRealtimeBackend;
  readonly gatewayId: string;
  readonly connections: number;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  health(): Promise<RealtimeBackendHealth>;
  close(): Promise<void>;
}

/**
 * Mounts the Socket.IO gateway for declared channels. Runs in its own
 * process (consuming publications from the API through Redis) or inside the
 * API process; either way the same backend and wire protocol apply.
 */
export function createRealtimeGateway<TCredential = unknown>(
  options: CreateRealtimeGatewayOptions<TCredential>,
): RealtimeGateway {
  assertGatewayOptions(options);
  const channels = Array.isArray(options.channels)
    ? (options.channels as readonly AnyChannel[])
    : (options.channels as CompiledApplication<string, readonly AnyModule[]>).modules.flatMap(
        (module) => module.channels,
      );
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const backend = createSocketIoRealtimeBackend({
    redis: options.redis,
    channels,
    tenantScopes: options.tenantScopes,
    gatewayId: options.gatewayId,
    keyPrefix: options.keyPrefix,
    heartbeat: options.heartbeat,
    meter: options.meter,
    onError: (error, phase) =>
      options.onUnexpectedError?.(error, { gatewayId: backend.gatewayId, phase }),
  });
  const metrics = createRealtimeMetrics(options.meter);
  const limits = {
    maxSubscriptions: options.limits?.maxSubscriptionsPerConnection ?? DEFAULT_MAX_SUBSCRIPTIONS,
    perSecond: options.limits?.controlMessagesPerSecond ?? DEFAULT_CONTROL_MESSAGES_PER_SECOND,
    burst: options.limits?.controlBurst ?? DEFAULT_CONTROL_BURST,
    highWaterMark: options.limits?.sendBufferHighWaterMark ?? DEFAULT_SEND_BUFFER_HIGH_WATER_MARK,
  };
  const ownsServer = options.server === undefined;
  const server = options.server ?? createServer();
  const io = new Server(server, { serveClient: false, ...options.socketIo });
  const namespace = io.of(SHIP_NAMESPACE);
  const generateRequestId = options.generateRequestId ?? (() => crypto.randomUUID());
  let connections = 0;

  const report = (error: unknown, context: Omit<RealtimeGatewayErrorContext, "gatewayId">): void =>
    options.onUnexpectedError?.(error, { gatewayId: backend.gatewayId, ...context });

  namespace.use(async (socket, next) => {
    const requestId = readRequestId(socket, generateRequestId);
    try {
      const request = handshakeRequest(socket, options.auth.authorizationScheme);
      const credential = await options.auth.credentials.extract(request);
      // Normalise before validating so a kind-less (ship-core 1.0) actor is human.
      const resolution = normalizeActorResolution(
        await options.auth.actors.resolve({
          credential,
          operation: realtimeHandshakeOperation(options.auth.handshakeAccess),
          requestId,
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (!resolution) {
        throw new TypeError(
          `actor resolver ${JSON.stringify(options.auth.actors.id)} returned an invalid result`,
        );
      }
      if (!resolution.ok) return next(handshakeError(handshakeErrorFor(resolution.reason)));
      socket.data.actor = resolution.actor ? operationActor(resolution.actor) : undefined;
      socket.data.requestId = requestId;
      return next();
    } catch (error) {
      report(error, { connectionId: socket.id, phase: "handshake" });
      return next(handshakeError(handshakeErrorFor("unavailable")));
    }
  });

  namespace.on("connection", (socket) => {
    connections += 1;
    metrics.connections.add(1);
    const actor = socket.data.actor as OperationActor | undefined;
    const bucket = createTokenBucket({ capacity: limits.burst, refillPerSecond: limits.perSecond });
    const owned = new Map<string, { channelId: string; scopeKey: string }>();
    const queue: ConnectionQueue = createConnectionQueue({
      socket: {
        emit: (event, payload) => {
          socket.emit(event, payload);
        },
        bufferedCount: () => engineWriteBufferLength(socket),
        onDrain: (handler) => {
          socket.conn.on("drain", handler);
          return () => socket.conn.off("drain", handler);
        },
        disconnect: () => socket.disconnect(true),
      },
      highWaterMark: limits.highWaterMark,
      droppedEvent: SERVER_EVENTS.dropped,
      onDropped: (channelId, scopeKey, dropped) =>
        metrics.dropped.add(
          dropped,
          metrics.channelAttributes(channelId, channelById.get(channelId)?.scope ?? "unknown", {
            [ATTR_DROP_REASON]: "slow-subscriber",
          }),
        ),
      onDelivered: (item) => {
        const scope = channelById.get(item.channelId)?.scope ?? "unknown";
        metrics.delivered.add(1, metrics.channelAttributes(item.channelId, scope));
        if (item.publishedAt) {
          const latency = Date.now() - Date.parse(item.publishedAt);
          if (Number.isFinite(latency)) {
            metrics.deliverLatency.record(
              Math.max(0, latency),
              metrics.channelAttributes(item.channelId, scope),
            );
          }
        }
      },
      onDisconnect: (channelId) =>
        metrics.dropped.add(
          1,
          metrics.channelAttributes(channelId, channelById.get(channelId)?.scope ?? "unknown", {
            [ATTR_DROP_REASON]: "slow-subscriber-disconnect",
          }),
        ),
      ...(options.authorizeDelivery
        ? {
            authorizeDelivery: (item) =>
              withTimeout(
                Promise.resolve(
                  options.authorizeDelivery!({
                    actor,
                    channelId: item.channelId,
                    scopeKey: item.scopeKey,
                    signal: AbortSignal.timeout(3_000),
                  }),
                ),
                3_000,
              ),
            onAuthorizationError: (error: unknown) =>
              report(error, { connectionId: socket.id, phase: "delivery-authorization" }),
          }
        : {}),
      ...(options.withAuthorizedDelivery
        ? {
            withAuthorizedDelivery: (item, deliver) =>
              withTimeout(
                Promise.resolve(
                  options.withAuthorizedDelivery!(
                    {
                      actor,
                      channelId: item.channelId,
                      scopeKey: item.scopeKey,
                      signal: AbortSignal.timeout(3_000),
                    },
                    deliver,
                  ),
                ),
                3_000,
              ),
            onAuthorizationError: (error: unknown) =>
              report(error, { connectionId: socket.id, phase: "delivery-authorization" }),
          }
        : {}),
    });

    const sink = (event: RealtimeEvent): void => {
      const policy = channelById.get(event.channelId)?.slowSubscriber ?? "drop-oldest";
      if (event.kind === "message") {
        queue.push({
          event: SERVER_EVENTS.event,
          payload: {
            channel: event.channelId,
            scopeKey: event.scopeKey,
            seq: event.seq,
            publishedAt: event.publishedAt,
            payload: event.payload,
          },
          channelId: event.channelId,
          scopeKey: event.scopeKey,
          policy,
          publishedAt: event.publishedAt,
        });
        return;
      }
      queue.push({
        event: SERVER_EVENTS.presence,
        payload: {
          channel: event.channelId,
          scopeKey: event.scopeKey,
          kind: event.event,
          actorId: event.actorId,
          count: event.count,
        },
        channelId: event.channelId,
        scopeKey: event.scopeKey,
        policy,
      });
    };

    const guard = <
      TAck extends { readonly ok: false; readonly code: string; readonly message: string },
    >(
      ack: unknown,
      limited: TAck,
      run: () => Promise<unknown>,
    ): void => {
      const reply = typeof ack === "function" ? (ack as (value: unknown) => void) : () => undefined;
      if (!bucket.take()) {
        reply(limited);
        return;
      }
      run().then(reply, (error) => {
        report(error, { connectionId: socket.id, phase: "control" });
        reply(limited);
      });
    };

    socket.on(CLIENT_EVENTS.subscribe, (raw: unknown, ack: unknown) => {
      guard<SubscribeAck & { ok: false }>(
        ack,
        { ok: false, code: "RATE_LIMITED", message: "Too many control messages" },
        async (): Promise<SubscribeAck> => {
          const parsed = parseSubscribeMessage(raw);
          if (!parsed.ok) {
            return parsed.code === "CHANNEL_NOT_FOUND"
              ? { ok: false, code: "CHANNEL_NOT_FOUND", message: "Channel is not declared" }
              : { ok: false, code: "INVALID_SCOPE", message: "Scope key is malformed" };
          }
          const duplicate = [...owned.entries()].find(
            ([, item]) =>
              item.channelId === parsed.message.channel &&
              item.scopeKey === parsed.message.scopeKey,
          );
          if (!duplicate && owned.size >= limits.maxSubscriptions) {
            return { ok: false, code: "RATE_LIMITED", message: "Subscription limit reached" };
          }
          if (options.authorizeSubscription) {
            try {
              const allowed = await withTimeout(
                Promise.resolve(
                  options.authorizeSubscription({
                    actor,
                    channelId: parsed.message.channel,
                    scopeKey: parsed.message.scopeKey,
                    signal: AbortSignal.timeout(3_000),
                  }),
                ),
                3_000,
              );
              if (!allowed) {
                return { ok: false, ...subscribeErrorFor("forbidden") };
              }
            } catch (error) {
              report(error, { connectionId: socket.id, phase: "subscription-authorization" });
              return { ok: false, ...subscribeErrorFor("unavailable") };
            }
          }
          const result = await backend.subscribe(
            {
              channelId: parsed.message.channel,
              scopeKey: parsed.message.scopeKey,
              actor,
              connectionId: socket.id,
              requestId: generateRequestId(),
            },
            sink,
          );
          if (!result.ok) return { ok: false, ...subscribeErrorFor(result.reason) };
          owned.set(result.subscriptionId, {
            channelId: parsed.message.channel,
            scopeKey: parsed.message.scopeKey,
          });
          return { ok: true, subscriptionId: result.subscriptionId };
        },
      );
    });

    socket.on(CLIENT_EVENTS.unsubscribe, (raw: unknown, ack: unknown) => {
      guard<UnsubscribeAck & { ok: false }>(
        ack,
        { ok: false, code: "UNKNOWN_SUBSCRIPTION", message: "Too many control messages" },
        async (): Promise<UnsubscribeAck> => {
          const parsed = parseUnsubscribeMessage(raw);
          if (!parsed || !owned.has(parsed.subscriptionId)) {
            return {
              ok: false,
              code: "UNKNOWN_SUBSCRIPTION",
              message: "Subscription is not owned by this connection",
            };
          }
          owned.delete(parsed.subscriptionId);
          await backend.unsubscribe(parsed.subscriptionId);
          return { ok: true };
        },
      );
    });

    socket.on(CLIENT_EVENTS.presenceSnapshot, (raw: unknown, ack: unknown) => {
      guard<PresenceSnapshotAck & { ok: false }>(
        ack,
        { ok: false, code: "SUBSCRIPTION_FORBIDDEN", message: "Too many control messages" },
        async (): Promise<PresenceSnapshotAck> => {
          const parsed = parsePresenceSnapshotMessage(raw);
          if (!parsed.ok) {
            if (parsed.code === "CHANNEL_NOT_FOUND")
              return { ok: false, code: "CHANNEL_NOT_FOUND", message: "Channel is not declared" };
            if (parsed.code === "INVALID_PAGE")
              return { ok: false, ...presenceErrorFor("page-invalid") };
            return { ok: false, code: "SUBSCRIPTION_FORBIDDEN", message: "Scope key is malformed" };
          }
          if (!backend.presence)
            return { ok: false, code: "PRESENCE_DISABLED", message: "Presence unavailable" };
          const result = await backend.presence.snapshot({
            channelId: parsed.message.channel,
            scopeKey: parsed.message.scopeKey,
            actor,
            requestId: generateRequestId(),
            ...(parsed.message.cursor !== undefined ? { cursor: parsed.message.cursor } : {}),
            ...(parsed.message.limit !== undefined ? { limit: parsed.message.limit } : {}),
          });
          if (!result.ok) return { ok: false, ...presenceErrorFor(result.reason) };
          return {
            ok: true,
            count: result.snapshot.count,
            members: result.snapshot.actorIds,
            ...(result.snapshot.nextCursor !== undefined
              ? { nextCursor: result.snapshot.nextCursor }
              : {}),
          };
        },
      );
    });

    socket.on(CLIENT_EVENTS.presenceOnline, (raw: unknown, ack: unknown) => {
      guard<PresenceOnlineAck & { ok: false }>(
        ack,
        { ok: false, code: "SUBSCRIPTION_FORBIDDEN", message: "Too many control messages" },
        async (): Promise<PresenceOnlineAck> => {
          const parsed = parsePresenceOnlineMessage(raw);
          if (!parsed.ok) {
            return parsed.code === "CHANNEL_NOT_FOUND"
              ? { ok: false, code: "CHANNEL_NOT_FOUND", message: "Channel is not declared" }
              : { ok: false, code: "SUBSCRIPTION_FORBIDDEN", message: "Scope key is malformed" };
          }
          if (!backend.presence)
            return { ok: false, code: "PRESENCE_DISABLED", message: "Presence unavailable" };
          const result = await backend.presence.actorOnline({
            channelId: parsed.message.channel,
            scopeKey: parsed.message.scopeKey,
            actorId: parsed.message.actorId,
            actor,
            requestId: generateRequestId(),
          });
          if (!result.ok) return { ok: false, ...presenceErrorFor(result.reason) };
          return { ok: true, online: result.online };
        },
      );
    });

    socket.on("disconnect", () => {
      connections -= 1;
      metrics.connections.add(-1);
      queue.close();
      owned.clear();
      backend
        .disconnect(socket.id)
        .catch((error) => report(error, { connectionId: socket.id, phase: "disconnect" }));
    });
  });

  const gateway: RealtimeGateway = {
    io,
    server,
    backend,
    gatewayId: backend.gatewayId,
    get connections() {
      return connections;
    },
    listen: async (port = 0, host) => {
      await backend.start();
      if (!server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
          });
        });
      }
      return server.address() as AddressInfo;
    },
    health: () => backend.health(),
    close: async () => {
      namespace.disconnectSockets(true);
      await backend.close();
      if (ownsServer) {
        // Socket.IO closes the HTTP server it is attached to; that is only ours to close when we created it.
        await new Promise<void>((resolve) => io.close(() => resolve()));
      } else {
        io.engine.close();
      }
    },
  };
  return gateway;
}

function assertGatewayOptions(options: CreateRealtimeGatewayOptions<unknown>): void {
  if (
    typeof options.auth !== "object" ||
    options.auth === null ||
    !isHonoCredentialAdapter(options.auth.credentials) ||
    !isActorResolver(options.auth.actors)
  ) {
    throw new RealtimeError(
      "SHIP_REALTIME_BACKEND_INVALID",
      "realtime gateway auth must provide the application's credential adapter and actor resolver",
    );
  }
  if (
    !Array.isArray(options.channels) &&
    Reflect.get(options.channels, "kind") !== "ship.application"
  ) {
    throw new RealtimeError(
      "SHIP_REALTIME_CHANNEL_INVALID",
      "realtime gateway channels must be a compiled application or a channel list",
    );
  }
}

function handshakeRequest(socket: Socket, scheme = DEFAULT_AUTHORIZATION_SCHEME): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(socket.handshake.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const credential = Reflect.get(socket.handshake.auth ?? {}, "credential");
  if (typeof credential === "string" && credential.length > 0) {
    headers.set("authorization", `${scheme} ${credential}`);
  }
  const host = socket.handshake.headers.host ?? "localhost";
  return new Request(`http://${host}${socket.handshake.url}`, { headers });
}

function handshakeError(error: {
  readonly code: string;
  readonly message: string;
}): Error & { data: unknown } {
  return Object.assign(new Error(error.message), {
    data: { code: error.code, message: error.message },
  });
}

/** engine.io keeps its pending packets on a private array; it is the only backpressure signal available. */
function engineWriteBufferLength(socket: Socket): number {
  const buffer = Reflect.get(socket.conn, "writeBuffer");
  return Array.isArray(buffer) ? buffer.length : 0;
}

function readRequestId(socket: Socket, generate: () => string): string {
  const incoming = socket.handshake.headers["x-request-id"];
  return typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming : generate();
}
