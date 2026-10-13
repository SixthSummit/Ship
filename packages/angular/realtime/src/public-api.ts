/** @packageDocumentation Declared realtime publication over a transport adapter. */

export {
  createShipRealtime,
  type RealtimeReconnectPolicy,
  type ShipRealtimeOptions,
} from './create-ship-realtime';
export {
  injectRealtime,
  provideShipRealtime,
  SHIP_REALTIME,
} from './provide-ship-realtime';
export {
  channelsPublishedBy,
  type RealtimeChannelContract,
  type RealtimeChannelDeclaration,
  type RealtimeChannelId,
  type RealtimeChannelScope,
  type RealtimeChannelTypeDefinition,
  type RealtimeManifest,
  type RealtimeOperationDeclaration,
  type RealtimeOperationDeclarations,
  type RealtimePayloadOf,
  type RealtimePresenceChannelId,
} from './realtime-contract';
export {
  type RealtimeEvent,
  type RealtimePresenceState,
  type RealtimePresenceSubscriptionHandle,
  type RealtimeStatus,
  type RealtimeSubscription,
  type RealtimeSubscriptionErrorCode,
  type RealtimeSubscriptionHandle,
  type RealtimeSubscriptionStatus,
  type ShipRealtime,
} from './realtime-subscription';
export {
  RealtimeConnectError,
  type RealtimeConnectErrorCode,
  type RealtimeDroppedFrame,
  type RealtimeEventFrame,
  type RealtimePresenceFrame,
  type RealtimePresenceSnapshotAck,
  type RealtimePresenceSnapshotErrorCode,
  type RealtimeSubscribeAck,
  type RealtimeSubscribeErrorCode,
  type RealtimeUnsubscribeAck,
  type RealtimeUnsubscribeErrorCode,
  type ShipRealtimeConnection,
  type ShipRealtimeConnectRequest,
  type ShipRealtimeTransport,
  type ShipRealtimeTransportHandlers,
} from './realtime-transport';
export { createSocketIoTransport, type SocketIoLoader } from './socket-io-transport';
