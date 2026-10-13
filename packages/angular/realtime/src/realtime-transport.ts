/**
 * Transport adapter boundary for declared realtime publication.
 *
 * Nothing in this module names a concrete transport. The Socket.IO adapter is one
 * implementation of {@link ShipRealtimeTransport}; a raw-WebSocket adapter can be added
 * later without changing the public subscription API.
 */

/** Ack failure codes the gateway may return for `subscribe`. */
export type RealtimeSubscribeErrorCode =
  | 'CHANNEL_NOT_FOUND'
  | 'SUBSCRIPTION_FORBIDDEN'
  | 'INVALID_SCOPE'
  | 'RATE_LIMITED';

/** Ack failure code the gateway may return for `unsubscribe`. */
export type RealtimeUnsubscribeErrorCode = 'UNKNOWN_SUBSCRIPTION';

/** Ack failure codes the gateway may return for a presence snapshot. */
export type RealtimePresenceSnapshotErrorCode =
  | 'SUBSCRIPTION_FORBIDDEN'
  | 'CHANNEL_NOT_FOUND'
  | 'PRESENCE_DISABLED';

/** Reasons a connection attempt can fail before any subscription exists. */
export type RealtimeConnectErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'AUTHENTICATION_UNAVAILABLE'
  | 'TRANSPORT_ERROR';

/** A published event as it arrives from the gateway. */
export interface RealtimeEventFrame {
  readonly channel: string;
  readonly scopeKey: string;
  /**
   * Per `(channel, scopeKey)` sequence number, monotonic within one gateway process.
   * Gaps (coalesced or dropped batches) and resets (gateway restart) are expected.
   */
  readonly seq: number;
  readonly publishedAt: string;
  readonly payload: unknown;
}

/** A presence transition as it arrives from the gateway. */
export interface RealtimePresenceFrame {
  readonly channel: string;
  readonly scopeKey: string;
  readonly kind: 'joined' | 'left';
  readonly actorId: string;
  readonly count: number;
}

/** A drop notice emitted once per dropped batch. */
export interface RealtimeDroppedFrame {
  readonly channel: string;
  readonly scopeKey: string;
  readonly dropped: number;
}

export type RealtimeSubscribeAck =
  | { readonly ok: true; readonly subscriptionId: string }
  | { readonly ok: false; readonly code: RealtimeSubscribeErrorCode; readonly message: string };

export type RealtimeUnsubscribeAck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RealtimeUnsubscribeErrorCode; readonly message: string };

export type RealtimePresenceSnapshotAck =
  | { readonly ok: true; readonly count: number; readonly members: readonly string[] }
  | {
      readonly ok: false;
      readonly code: RealtimePresenceSnapshotErrorCode;
      readonly message: string;
    };

/** Frames and lifecycle notices a transport pushes back into the client. */
export interface ShipRealtimeTransportHandlers {
  readonly onEvent: (frame: RealtimeEventFrame) => void;
  readonly onPresence: (frame: RealtimePresenceFrame) => void;
  readonly onDropped: (frame: RealtimeDroppedFrame) => void;
  /** Called once per connection when the link drops for any reason. */
  readonly onDisconnect: (reason: string) => void;
}

/** One live link to the gateway. The client owns reconnect, not the transport. */
export interface ShipRealtimeConnection {
  subscribe(request: {
    readonly channel: string;
    readonly scopeKey: string;
  }): Promise<RealtimeSubscribeAck>;
  unsubscribe(request: { readonly subscriptionId: string }): Promise<RealtimeUnsubscribeAck>;
  presenceSnapshot(request: {
    readonly channel: string;
    readonly scopeKey: string;
  }): Promise<RealtimePresenceSnapshotAck>;
  close(): void;
}

export interface ShipRealtimeConnectRequest {
  readonly url: string;
  /** Credential resolved for this attempt; a reconnect resolves a fresh one. */
  readonly credential: string;
  readonly ackTimeoutMs: number;
  readonly handlers: ShipRealtimeTransportHandlers;
}

/** Opens one link. Rejects with {@link RealtimeConnectError} when the link is refused. */
export type ShipRealtimeTransport = (
  request: ShipRealtimeConnectRequest
) => Promise<ShipRealtimeConnection>;

/** A refused or failed connection attempt, classified by the gateway's code. */
export class RealtimeConnectError extends Error {
  readonly code: RealtimeConnectErrorCode;

  constructor(message: string, code: RealtimeConnectErrorCode) {
    super(message);
    this.name = 'RealtimeConnectError';
    this.code = code;
  }
}

/** True when a refusal will keep failing until the credential itself changes. */
export function isTerminalConnectError(code: RealtimeConnectErrorCode): boolean {
  return code === 'AUTHORIZATION_ERROR';
}
