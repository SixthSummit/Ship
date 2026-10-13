/** @packageDocumentation Typed ShipAPI streaming capabilities and SSE parsing. */

export { buildStreamRequest, type ShipStreamRequest } from './build-stream-request';
export {
  type CreateOperationStreamOptions,
  createOperationStream,
  type OperationStream,
  type OperationStreamBinding,
  type OperationStreamReconnectPolicy,
  type OperationStreamReconnectReason,
  type OperationStreamRequest,
  type OperationStreamStatus,
  type OperationStreamTerminal,
} from './create-operation-stream';
export {
  type CreateStreamOptions,
  createStream,
  type ShipStreamHandle,
  type ShipStreamOperationRef,
  type ShipStreamSourceRequest,
  type ShipStreamStatus,
} from './create-stream';
export { parseSseFrames, type SseFrame } from './parse-sse-frames';
export { type ShipStreamPlatform } from './resolve-stream-platform';
export { type StreamFrameOf, type StreamTerminalOf } from './ship-stream-contract';
export {
  isShipStreamError,
  type ShipStreamError,
  type ShipStreamLocalErrorCode,
  STREAM_INTERRUPTED,
  STREAM_PROTOCOL_VIOLATION,
  STREAM_TRANSPORT_FAILED,
} from './ship-stream-error';
export {
  resolveShipStreamOperation,
  type ShipStreamLimits,
  type ShipStreamManifest,
  type ShipStreamManifestEntry,
  type ShipStreamManifestOperation,
  type ShipStreamMethod,
  type ShipStreamResponseDeclaration,
} from './ship-stream-manifest';
