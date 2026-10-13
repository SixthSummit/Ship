import type { Signal } from '@angular/core';
import type {
  RealtimeChannelContract,
  RealtimeChannelId,
  RealtimePayloadOf,
} from './realtime-contract';
import type { RealtimeSubscribeErrorCode } from './realtime-transport';

/** Connection state of a realtime client. */
export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** Lifecycle of one declared subscription. */
export type RealtimeSubscriptionStatus = 'pending' | 'active' | 'forbidden' | 'closed';

/**
 * Why a subscription stopped.
 *
 * The first four codes are the gateway's ack codes. `ACK_TIMEOUT` and `CONNECTION_REFUSED`
 * are client-side classifications with no wire representation.
 */
export type RealtimeSubscriptionErrorCode =
  | RealtimeSubscribeErrorCode
  | 'ACK_TIMEOUT'
  | 'CONNECTION_REFUSED';

/** One published event delivered to a subscription. */
export interface RealtimeEvent<TPayload> {
  readonly seq: number;
  readonly publishedAt: string;
  readonly payload: TPayload;
}

/** Presence membership of one `(channel, scopeKey)` pair. */
export interface RealtimePresenceState {
  readonly count: number;
  readonly members: readonly string[];
}

/** A subscription to a channel the contract declares without presence. */
export interface RealtimeSubscriptionHandle<TPayload> {
  /** Most recently delivered payload, or `undefined` before the first event. */
  readonly latest: Signal<TPayload | undefined>;
  /** Number of events the gateway reported dropping for this subscription. */
  readonly dropped: Signal<number>;
  readonly status: Signal<RealtimeSubscriptionStatus>;
  /** Set once the subscription stops for a reason other than `unsubscribe()`. */
  readonly error: Signal<RealtimeSubscriptionErrorCode | undefined>;
  /** Register an event handler. Returns a function that removes it. */
  events(handler: (event: RealtimeEvent<TPayload>) => void): () => void;
  unsubscribe(): void;
}

/** A subscription to a channel the contract declares with `presence: true`. */
export interface RealtimePresenceSubscriptionHandle<TPayload>
  extends RealtimeSubscriptionHandle<TPayload> {
  /** Membership, or `undefined` until the first snapshot or presence frame arrives. */
  readonly presence: Signal<RealtimePresenceState | undefined>;
}

/**
 * Subscription returned by `subscribe()`. `presence` exists only on channels the
 * contract declares with `presence: true`.
 */
export type RealtimeSubscription<
  TContract extends RealtimeChannelContract,
  TChannel extends RealtimeChannelId<TContract>,
> = TContract['channels'][TChannel]['presence'] extends true
  ? RealtimePresenceSubscriptionHandle<RealtimePayloadOf<TContract, TChannel>>
  : RealtimeSubscriptionHandle<RealtimePayloadOf<TContract, TChannel>>;

/** Application-typed realtime client. */
export interface ShipRealtime<TContract extends RealtimeChannelContract> {
  readonly status: Signal<RealtimeStatus>;
  subscribe<TChannel extends RealtimeChannelId<TContract>>(
    channel: TChannel,
    scopeKey: string
  ): RealtimeSubscription<TContract, TChannel>;
  /** Close the link and every live subscription. Idempotent. */
  close(): void;
}
