/**
 * Realtime lane: publishes the consumer's actor-scoped `reports.delivered`
 * channel through the kernel channel publisher bound to the Redis publisher
 * backend (exactly as an operation handler would) at the ADR-0017 rate, while
 * one subscriber on each gateway process counts what it receives.
 */
import { createChannelPublisher } from "@sixthsummit/ship-core";
import { CLIENT_EVENTS, SERVER_EVENTS, SHIP_NAMESPACE } from "@sixthsummit/ship-realtime-socketio";
import { io, type Socket } from "socket.io-client";
import { notificationDelivered } from "../../consumer/application.js";
import { withTimeout } from "../children.js";
import type { ComposedApplication } from "../compose.js";
import type { CapacityConfig } from "../config.js";
import { SUBSCRIBER_ACTOR, SUBSCRIBER_TOKEN } from "../sessions.js";
import { type Distribution, distribution, paced, sleep } from "../stats.js";

export const CHANNEL_ID = notificationDelivered.id;

export interface SubscriberWindow {
  readonly gateway: string;
  readonly received: number;
  readonly late: number;
  /** Batches the gateway reported dropping for this connection (slow-subscriber policy). */
  readonly droppedReports: number;
  readonly droppedMessages: number;
  readonly latencyMs: Distribution;
}

export interface RealtimeWindow {
  readonly published: number;
  readonly publisherDropped: number;
  readonly subscribers: readonly SubscriberWindow[];
}

export interface SubscriberSummary extends SubscriberWindow {
  readonly missing: number;
}

export interface RealtimeLaneSummary {
  readonly published: number;
  readonly publisherDropped: number;
  readonly achievedRatePerSecond: number;
  readonly publishCallLatencyMs: Distribution;
  readonly subscribers: readonly SubscriberSummary[];
  readonly drainedMs: number;
}

interface SubscriberState {
  readonly gateway: string;
  readonly socket: Socket;
  received: number;
  late: number;
  droppedReports: number;
  droppedMessages: number;
  latencies: number[];
  windowLatencies: number[];
  windowStart: { received: number; late: number; droppedReports: number; droppedMessages: number };
}

interface EventMessage {
  readonly payload: { readonly subject: string };
}

export async function createRealtimeLane(
  composed: ComposedApplication,
  config: CapacityConfig,
  gateways: readonly { readonly id: string; readonly port: number }[],
) {
  const publisher = createChannelPublisher(notificationDelivered, composed.publisher);
  const subscribers: SubscriberState[] = [];
  for (const gateway of gateways) {
    const socket = io(`http://127.0.0.1:${gateway.port}${SHIP_NAMESPACE}`, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { credential: SUBSCRIBER_TOKEN },
    });
    await withTimeout(
      new Promise<void>((resolvePromise, rejectPromise) => {
        socket.once("connect", () => resolvePromise());
        socket.once("connect_error", (error) => rejectPromise(error));
      }),
      10_000,
      `connection to ${gateway.id}`,
    );
    const state: SubscriberState = {
      gateway: gateway.id,
      socket,
      received: 0,
      late: 0,
      droppedReports: 0,
      droppedMessages: 0,
      latencies: [],
      windowLatencies: [],
      windowStart: { received: 0, late: 0, droppedReports: 0, droppedMessages: 0 },
    };
    socket.on(SERVER_EVENTS.event, (event: EventMessage) => {
      const sentAt = Number(event.payload.subject.split(":")[1]);
      const latency = Math.max(0, Date.now() - sentAt);
      state.received += 1;
      state.latencies.push(latency);
      state.windowLatencies.push(latency);
      if (latency > config.realtimeLateMs) state.late += 1;
    });
    socket.on(SERVER_EVENTS.dropped, (message: { readonly dropped: number }) => {
      state.droppedReports += 1;
      state.droppedMessages += message.dropped;
    });
    const ack = (await socket.emitWithAck(CLIENT_EVENTS.subscribe, {
      channel: CHANNEL_ID,
      scopeKey: SUBSCRIBER_ACTOR,
    })) as { readonly ok: boolean; readonly code?: string };
    if (!ack.ok) throw new Error(`subscribe on ${gateway.id} failed: ${ack.code}`);
    subscribers.push(state);
  }

  const totals = { published: 0, elapsedMs: 0, drainedMs: 0 };
  let windowPublished = 0;
  let windowPublisherDropped = 0;
  let publisherDroppedAtReset = 0;
  const publishLatencies: number[] = [];

  return {
    run: async (stopAt: number) => {
      const result = await paced(config.realtimeRatePerSecond, stopAt, async (index) => {
        const started = performance.now();
        await publisher.publish(SUBSCRIBER_ACTOR, {
          tenantId: "capacity",
          recipient: "subscriber@example.test",
          subject: `${index}:${Date.now()}`,
          adapter: "capacity-noop",
        });
        publishLatencies.push(performance.now() - started);
        totals.published += 1;
      });
      totals.elapsedMs = result.elapsedMs;
      await composed.publisher.flush();
    },
    /** Forgets everything counted so far (end of warm-up); subscriptions stay open. */
    reset: () => {
      totals.published = 0;
      totals.elapsedMs = 0;
      totals.drainedMs = 0;
      windowPublished = 0;
      windowPublisherDropped = composed.counters.publisherDropped;
      publisherDroppedAtReset = composed.counters.publisherDropped;
      publishLatencies.length = 0;
      for (const state of subscribers) {
        state.received = 0;
        state.late = 0;
        state.droppedReports = 0;
        state.droppedMessages = 0;
        state.latencies = [];
        state.windowLatencies = [];
        state.windowStart = { received: 0, late: 0, droppedReports: 0, droppedMessages: 0 };
      }
    },
    /** Waits for every subscriber to catch up with what was published, bounded by `timeoutMs`. */
    drain: async (timeoutMs: number) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (
          subscribers.every((state) => state.received + state.droppedMessages >= totals.published)
        )
          break;
        await sleep(50);
      }
      totals.drainedMs = Date.now() - started;
    },
    window: (): RealtimeWindow => {
      const window: RealtimeWindow = {
        published: totals.published - windowPublished,
        publisherDropped: composed.counters.publisherDropped - windowPublisherDropped,
        subscribers: subscribers.map((state) => {
          const item: SubscriberWindow = {
            gateway: state.gateway,
            received: state.received - state.windowStart.received,
            late: state.late - state.windowStart.late,
            droppedReports: state.droppedReports - state.windowStart.droppedReports,
            droppedMessages: state.droppedMessages - state.windowStart.droppedMessages,
            latencyMs: distribution(state.windowLatencies),
          };
          state.windowStart = {
            received: state.received,
            late: state.late,
            droppedReports: state.droppedReports,
            droppedMessages: state.droppedMessages,
          };
          state.windowLatencies = [];
          return item;
        }),
      };
      windowPublished = totals.published;
      windowPublisherDropped = composed.counters.publisherDropped;
      return window;
    },
    summary: (): RealtimeLaneSummary => ({
      published: totals.published,
      publisherDropped: composed.counters.publisherDropped - publisherDroppedAtReset,
      achievedRatePerSecond:
        totals.elapsedMs > 0 ? Math.round((totals.published / totals.elapsedMs) * 1_000) : 0,
      publishCallLatencyMs: distribution(publishLatencies),
      subscribers: subscribers.map((state) => ({
        gateway: state.gateway,
        received: state.received,
        missing: Math.max(0, totals.published - state.received),
        late: state.late,
        droppedReports: state.droppedReports,
        droppedMessages: state.droppedMessages,
        latencyMs: distribution(state.latencies),
      })),
      drainedMs: totals.drainedMs,
    }),
    close: async () => {
      for (const state of subscribers) state.socket.disconnect();
    },
  };
}

export type RealtimeLane = Awaited<ReturnType<typeof createRealtimeLane>>;
