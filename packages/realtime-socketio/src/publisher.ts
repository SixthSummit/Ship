import type { Meter } from "@opentelemetry/api";
import type {
  AnyChannel,
  RealtimeBackendHealth,
  RealtimePublishBackend,
} from "@sixthsummit/ship-core";
import { RealtimeError } from "@sixthsummit/ship-core";
import { encodeEnvelope, type RealtimeEnvelope } from "./envelope.js";
import { ATTR_DROP_REASON, createRealtimeMetrics, type RealtimeMetrics } from "./metrics.js";
import {
  createIoredisTransport,
  isRealtimeRedis,
  type RealtimeRedis,
  realtimeKeys,
} from "./redis.js";

const DEFAULT_MAX_PENDING = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;

export interface CreateRealtimePublisherOptions {
  /** A transport or a Redis URL. The API process needs only this; no Socket.IO server runs here. */
  readonly redis: RealtimeRedis | { readonly url: string };
  /** Channels this process may publish. Unknown channels are rejected before enqueue. */
  readonly channels?: readonly AnyChannel[];
  readonly id?: string;
  readonly keyPrefix?: string;
  /** Bounded hand-off queue between publish() and Redis. Defaults to 10,000 envelopes. */
  readonly maxPending?: number;
  readonly meter?: Meter;
  /** Observes envelopes dropped because Redis is behind or unavailable. */
  readonly onDropped?: (
    envelope: RealtimeEnvelope,
    reason: "queue-full" | "redis-error",
    cause?: unknown,
  ) => void;
}

export interface RealtimePublisher extends RealtimePublishBackend {
  readonly adapter: "socket.io-redis";
  /** Envelopes accepted but not yet written to Redis. */
  readonly pending: number;
  /** Resolves once every accepted envelope has been written or dropped. */
  flush(): Promise<void>;
  /** Publishes an already-formed envelope; used by gateways for presence events. */
  send(envelope: RealtimeEnvelope): boolean;
}

/**
 * Publish-only backend for the API process. `publish()` enqueues and
 * returns; a single pump writes envelopes to Redis in order. Acceptance means
 * the envelope is queued locally, never that Redis or a subscriber has it.
 */
export function createRealtimePublisher(
  options: CreateRealtimePublisherOptions,
): RealtimePublisher {
  const redis = isRealtimeRedis(options.redis)
    ? options.redis
    : createIoredisTransport({ url: options.redis.url });
  const ownsRedis = !isRealtimeRedis(options.redis);
  const keys = realtimeKeys(options.keyPrefix);
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const metrics: RealtimeMetrics = createRealtimeMetrics(options.meter);
  const known = options.channels
    ? new Map(options.channels.map((channel) => [channel.id, channel]))
    : undefined;
  const id = options.id ?? `publisher-${Math.random().toString(36).slice(2, 10)}`;
  const queue: RealtimeEnvelope[] = [];
  let pumping: Promise<void> | undefined;
  let closed = false;

  const scopeOf = (channelId: string): string => known?.get(channelId)?.scope ?? "unknown";

  const pump = async (): Promise<void> => {
    while (queue.length > 0) {
      const envelope = queue[0] as RealtimeEnvelope;
      try {
        await redis.publish(keys.events, encodeEnvelope(envelope));
      } catch (cause) {
        metrics.dropped.add(
          1,
          metrics.channelAttributes(envelope.channel, scopeOf(envelope.channel), {
            [ATTR_DROP_REASON]: "redis-error",
          }),
        );
        options.onDropped?.(envelope, "redis-error", cause);
      }
      queue.shift();
    }
    pumping = undefined;
  };

  const send = (envelope: RealtimeEnvelope): boolean => {
    if (closed) return false;
    if (queue.length >= maxPending) {
      metrics.dropped.add(
        1,
        metrics.channelAttributes(envelope.channel, scopeOf(envelope.channel), {
          [ATTR_DROP_REASON]: "queue-full",
        }),
      );
      options.onDropped?.(envelope, "queue-full");
      return false;
    }
    queue.push(envelope);
    if (!pumping) pumping = pump();
    return true;
  };

  const publisher: RealtimePublisher = {
    kind: "ship.realtime-backend",
    id,
    adapter: "socket.io-redis",
    get pending() {
      return queue.length;
    },
    send,
    publish: async (channel, scopeKey, payload) => {
      if (closed) {
        throw new RealtimeError(
          "SHIP_REALTIME_BACKEND_UNAVAILABLE",
          "realtime publisher is closed",
        );
      }
      if (known && !known.has(channel.id)) {
        throw new RealtimeError(
          "SHIP_REALTIME_CHANNEL_INVALID",
          `channel ${JSON.stringify(channel.id)} is not registered with this publisher`,
          { channelId: channel.id },
        );
      }
      metrics.published.add(1, metrics.channelAttributes(channel.id, channel.scope));
      send({
        v: 1,
        kind: "message",
        channel: channel.id,
        scopeKey,
        payload,
        publishedAt: new Date().toISOString(),
        origin: id,
      });
    },
    flush: async () => {
      while (pumping) await pumping;
    },
    health: async (): Promise<RealtimeBackendHealth> => {
      if (closed) return { ok: false, adapter: "socket.io-redis", detail: "closed" };
      try {
        await withTimeout(redis.ping(), DEFAULT_HEALTH_TIMEOUT_MS);
        return {
          ok: true,
          adapter: "socket.io-redis",
          detail: `pending=${queue.length}`,
        };
      } catch (error) {
        return {
          ok: false,
          adapter: "socket.io-redis",
          detail: error instanceof Error ? error.message : "redis unavailable",
        };
      }
    },
    close: async () => {
      closed = true;
      await publisher.flush();
      if (ownsRedis) await redis.close();
    },
  };
  return publisher;
}

export function withTimeout<TValue>(promise: Promise<TValue>, ms: number): Promise<TValue> {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
