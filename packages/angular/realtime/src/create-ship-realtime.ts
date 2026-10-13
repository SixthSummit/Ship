import { type Signal, signal, type WritableSignal } from '@angular/core';
import {
  indexRealtimeChannels,
  type RealtimeChannelContract,
  type RealtimeChannelId,
  type RealtimeManifest,
} from './realtime-contract';
import type {
  RealtimeEvent,
  RealtimePresenceState,
  RealtimePresenceSubscriptionHandle,
  RealtimeStatus,
  RealtimeSubscription,
  RealtimeSubscriptionErrorCode,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionStatus,
  ShipRealtime,
} from './realtime-subscription';
import {
  isTerminalConnectError,
  RealtimeConnectError,
  type RealtimeDroppedFrame,
  type RealtimeEventFrame,
  type RealtimePresenceFrame,
  type ShipRealtimeConnection,
  type ShipRealtimeTransport,
} from './realtime-transport';

/** Backoff bounds for reconnect attempts. */
export interface RealtimeReconnectPolicy {
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ShipRealtimeOptions<TContract extends RealtimeChannelContract> {
  /** Gateway origin. The transport appends its own namespace or path. */
  readonly url: string;
  /** Resolved before every connection attempt, so a reconnect carries a fresh token. */
  readonly credential: () => string | Promise<string>;
  /** The ShipAPI manifest's realtime projection. */
  readonly manifest: RealtimeManifest<TContract>;
  /** Defaults to the Socket.IO adapter. */
  readonly transport?: ShipRealtimeTransport;
  /** How long to wait for an ack before treating the request as failed. Default 10s. */
  readonly ackTimeoutMs?: number;
  readonly reconnect?: RealtimeReconnectPolicy;
}

/** Deterministic seams used by the unit suite; not part of the provider surface. */
export interface ShipRealtimeRuntime {
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly random?: () => number;
}

interface SubscriptionRecord {
  readonly channel: string;
  readonly scopeKey: string;
  readonly latest: WritableSignal<unknown>;
  readonly dropped: WritableSignal<number>;
  readonly status: WritableSignal<RealtimeSubscriptionStatus>;
  readonly error: WritableSignal<RealtimeSubscriptionErrorCode | undefined>;
  readonly presence: WritableSignal<RealtimePresenceState | undefined> | undefined;
  readonly handlers: Set<(event: RealtimeEvent<never>) => void>;
  presenceBuffer: RealtimePresenceFrame[] | undefined;
  subscriptionId: string | undefined;
  terminal: boolean;
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT: RealtimeReconnectPolicy = { minDelayMs: 500, maxDelayMs: 10_000 };

/**
 * Build a realtime client over a transport adapter.
 *
 * The client — not the transport — owns reconnect, backoff, credential refresh, and
 * resubscribe-all, so every transport behaves identically from the application's side.
 */
export function createShipRealtime<TContract extends RealtimeChannelContract>(
  options: ShipRealtimeOptions<TContract>,
  transport: ShipRealtimeTransport,
  runtime: ShipRealtimeRuntime = {}
): ShipRealtime<TContract> {
  const declarations = indexRealtimeChannels(options.manifest);
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const backoff = options.reconnect ?? DEFAULT_RECONNECT;
  const setTimer = runtime.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs));
  const clearTimer = runtime.clearTimer ?? (handle => clearTimeout(handle as never));
  const random = runtime.random ?? Math.random;

  const status = signal<RealtimeStatus>('idle');
  const records = new Set<SubscriptionRecord>();

  let connection: ShipRealtimeConnection | undefined;
  let connecting: Promise<void> | undefined;
  let generation = 0;
  let attempt = 0;
  let reconnectHandle: unknown;
  let releaseHandle: unknown;
  let closed = false;

  function liveRecords(): SubscriptionRecord[] {
    return [...records].filter(record => !record.terminal);
  }

  function releaseWhenIdle(): void {
    if (closed || liveRecords().length > 0) return;
    cancelRelease();
    cancelReconnect();
    generation += 1;
    attempt = 0;
    connection?.close();
    connection = undefined;
    connecting = undefined;
    status.set('closed');
  }

  /**
   * Release the idle link once the gateway has acknowledged the final unsubscribe.
   *
   * Closing in the same turn loses it: the request and the disconnect are flushed together
   * and a gateway discards an event that arrives with the disconnect. Bounded by
   * `ackTimeoutMs`, so a silent link still closes.
   */
  function releaseAfterAck(ack: Promise<unknown>): void {
    cancelRelease();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      cancelRelease();
      releaseWhenIdle();
    };
    releaseHandle = setTimer(release, ackTimeoutMs);
    void ack.then(release, release);
  }

  function cancelRelease(): void {
    if (releaseHandle === undefined) return;
    clearTimer(releaseHandle);
    releaseHandle = undefined;
  }

  function cancelReconnect(): void {
    if (reconnectHandle === undefined) return;
    clearTimer(reconnectHandle);
    reconnectHandle = undefined;
  }

  function scheduleReconnect(): void {
    if (closed || reconnectHandle !== undefined) return;
    attempt += 1;
    status.set('reconnecting');
    const capped = Math.min(backoff.maxDelayMs, backoff.minDelayMs * 2 ** Math.max(0, attempt - 1));
    const delayMs = capped / 2 + random() * (capped / 2);
    reconnectHandle = setTimer(() => {
      reconnectHandle = undefined;
      void ensureConnected();
    }, delayMs);
  }

  function routed(channel: string, scopeKey: string): SubscriptionRecord[] {
    return [...records].filter(
      record => !record.terminal && record.channel === channel && record.scopeKey === scopeKey
    );
  }

  function applyPresenceFrame(record: SubscriptionRecord, frame: RealtimePresenceFrame): void {
    const target = record.presence;
    if (target === undefined) return;
    const current = target();
    const members = new Set(current?.members ?? []);
    if (frame.kind === 'joined') members.add(frame.actorId);
    else members.delete(frame.actorId);
    target.set({ count: frame.count, members: [...members] });
  }

  const handlers = {
    onEvent: (frame: RealtimeEventFrame): void => {
      for (const record of routed(frame.channel, frame.scopeKey)) {
        record.latest.set(frame.payload);
        const event = {
          seq: frame.seq,
          publishedAt: frame.publishedAt,
          payload: frame.payload,
        } as RealtimeEvent<never>;
        for (const handler of [...record.handlers]) handler(event);
      }
    },
    onPresence: (frame: RealtimePresenceFrame): void => {
      for (const record of routed(frame.channel, frame.scopeKey)) {
        if (record.presence === undefined) continue;
        if (record.presenceBuffer !== undefined) {
          record.presenceBuffer.push(frame);
          continue;
        }
        applyPresenceFrame(record, frame);
      }
    },
    onDropped: (frame: RealtimeDroppedFrame): void => {
      for (const record of routed(frame.channel, frame.scopeKey)) {
        record.dropped.set(record.dropped() + frame.dropped);
      }
    },
    onDisconnect: (reason: string): void => {
      void reason;
      connection = undefined;
      if (closed) return;
      for (const record of liveRecords()) {
        record.subscriptionId = undefined;
        record.presenceBuffer = undefined;
        record.presence?.set(undefined);
        record.status.set('pending');
      }
      if (liveRecords().length === 0) {
        status.set('closed');
        return;
      }
      scheduleReconnect();
    },
  };

  async function loadPresence(
    record: SubscriptionRecord,
    link: ShipRealtimeConnection
  ): Promise<void> {
    const target = record.presence;
    if (target === undefined) return;
    record.presenceBuffer = [];
    let snapshot;
    try {
      snapshot = await link.presenceSnapshot({
        channel: record.channel,
        scopeKey: record.scopeKey,
      });
    } catch {
      record.presenceBuffer = undefined;
      return;
    }
    const buffered = record.presenceBuffer ?? [];
    record.presenceBuffer = undefined;
    if (connection !== link || record.terminal) return;
    if (snapshot.ok) target.set({ count: snapshot.count, members: [...snapshot.members] });
    for (const frame of buffered) applyPresenceFrame(record, frame);
  }

  async function sendSubscribe(record: SubscriptionRecord): Promise<void> {
    const link = connection;
    if (link === undefined || record.terminal) return;
    record.status.set('pending');
    let ack;
    try {
      ack = await link.subscribe({ channel: record.channel, scopeKey: record.scopeKey });
    } catch {
      // A failed ack on a link that has since dropped is a reconnect, not a rejection.
      if (connection === link && !record.terminal) stop(record, 'closed', 'ACK_TIMEOUT');
      return;
    }
    if (connection !== link || record.terminal) return;
    if (!ack.ok) {
      stop(
        record,
        ack.code === 'SUBSCRIPTION_FORBIDDEN' || ack.code === 'INVALID_SCOPE'
          ? 'forbidden'
          : 'closed',
        ack.code
      );
      return;
    }
    record.subscriptionId = ack.subscriptionId;
    record.status.set('active');
    if (record.presence !== undefined) void loadPresence(record, link);
  }

  function stop(
    record: SubscriptionRecord,
    next: RealtimeSubscriptionStatus,
    code: RealtimeSubscriptionErrorCode
  ): void {
    record.terminal = true;
    record.subscriptionId = undefined;
    record.error.set(code);
    record.status.set(next);
    releaseWhenIdle();
  }

  async function openConnection(): Promise<void> {
    const attempted = ++generation;
    try {
      const credential = await options.credential();
      const link = await transport({
        url: options.url,
        credential,
        ackTimeoutMs,
        handlers,
      });
      if (closed || attempted !== generation) {
        link.close();
        return;
      }
      connection = link;
      connecting = undefined;
      attempt = 0;
      status.set('open');
      await Promise.all(liveRecords().map(record => sendSubscribe(record)));
    } catch (error: unknown) {
      connecting = undefined;
      if (closed || attempted !== generation) return;
      const code =
        error instanceof RealtimeConnectError ? error.code : ('TRANSPORT_ERROR' as const);
      if (isTerminalConnectError(code)) {
        for (const record of liveRecords()) stop(record, 'forbidden', 'CONNECTION_REFUSED');
        status.set('error');
        return;
      }
      scheduleReconnect();
    }
  }

  function ensureConnected(): Promise<void> {
    if (closed || connection !== undefined || connecting !== undefined) return Promise.resolve();
    status.set(attempt === 0 ? 'connecting' : 'reconnecting');
    connecting = openConnection();
    return connecting;
  }

  function unsubscribe(record: SubscriptionRecord): void {
    records.delete(record);
    record.handlers.clear();
    const subscriptionId = record.subscriptionId;
    const link = connection;
    record.terminal = true;
    record.subscriptionId = undefined;
    record.status.set('closed');
    if (subscriptionId === undefined || link === undefined) {
      releaseWhenIdle();
      return;
    }
    const ack = link.unsubscribe({ subscriptionId }).catch(() => undefined);
    if (closed || liveRecords().length > 0) return;
    releaseAfterAck(ack);
  }

  function subscribe<TChannel extends RealtimeChannelId<TContract>>(
    channel: TChannel,
    scopeKey: string
  ): RealtimeSubscription<TContract, TChannel> {
    const declaration = declarations.get(channel);
    const record: SubscriptionRecord = {
      channel,
      scopeKey,
      latest: signal<unknown>(undefined),
      dropped: signal(0),
      status: signal<RealtimeSubscriptionStatus>('pending'),
      error: signal<RealtimeSubscriptionErrorCode | undefined>(undefined),
      presence:
        declaration?.presence === true
          ? signal<RealtimePresenceState | undefined>(undefined)
          : undefined,
      handlers: new Set(),
      presenceBuffer: undefined,
      subscriptionId: undefined,
      terminal: false,
    };
    const handle = toHandle(record, () => unsubscribe(record)) as unknown as RealtimeSubscription<
      TContract,
      TChannel
    >;
    if (declaration === undefined) {
      // The manifest is the contract. An undeclared channel never reaches the wire.
      record.terminal = true;
      record.error.set('CHANNEL_NOT_FOUND');
      record.status.set('closed');
      return handle;
    }
    records.add(record);
    cancelRelease();
    if (closed) {
      record.terminal = true;
      record.status.set('closed');
      return handle;
    }
    if (connection !== undefined) void sendSubscribe(record);
    else void ensureConnected();
    return handle;
  }

  function toHandle(
    record: SubscriptionRecord,
    stopSubscription: () => void
  ): RealtimeSubscriptionHandle<never> | RealtimePresenceSubscriptionHandle<never> {
    const base = {
      latest: record.latest.asReadonly() as Signal<never>,
      dropped: record.dropped.asReadonly(),
      status: record.status.asReadonly(),
      error: record.error.asReadonly(),
      events: (handler: (event: RealtimeEvent<never>) => void): (() => void) => {
        record.handlers.add(handler);
        return () => {
          record.handlers.delete(handler);
        };
      },
      unsubscribe: stopSubscription,
    };
    if (record.presence === undefined) return base;
    return { ...base, presence: record.presence.asReadonly() };
  }

  return {
    status: status.asReadonly(),
    subscribe,
    close: (): void => {
      if (closed) return;
      closed = true;
      cancelRelease();
      cancelReconnect();
      generation += 1;
      for (const record of [...records]) {
        records.delete(record);
        record.handlers.clear();
        record.terminal = true;
        record.status.set('closed');
      }
      connection?.close();
      connection = undefined;
      connecting = undefined;
      status.set('closed');
    },
  };
}

/** SSR client: never opens a link and hands back closed subscriptions. */
export function createClosedShipRealtime<
  TContract extends RealtimeChannelContract,
>(): ShipRealtime<TContract> {
  const status = signal<RealtimeStatus>('closed');
  return {
    status: status.asReadonly(),
    subscribe: <TChannel extends RealtimeChannelId<TContract>>() => {
      const closedHandle = {
        latest: signal(undefined).asReadonly() as Signal<never>,
        dropped: signal(0).asReadonly(),
        status: signal<RealtimeSubscriptionStatus>('closed').asReadonly(),
        error: signal<RealtimeSubscriptionErrorCode | undefined>(undefined).asReadonly(),
        presence: signal<RealtimePresenceState | undefined>(undefined).asReadonly(),
        events: () => () => undefined,
        unsubscribe: () => undefined,
      };
      return closedHandle as unknown as RealtimeSubscription<TContract, TChannel>;
    },
    close: () => undefined,
  };
}
