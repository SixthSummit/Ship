/** @packageDocumentation Structural ShipAPI operation integration for Angular. */

export { createOperationCallScope, type OperationCallScope } from './create-operation-call-scope';
export {
  type CreateOperationMutationOptions,
  createOperationMutation,
  type OperationMutation,
  type OperationMutationConcurrency,
  type OperationMutationStatus,
  type OperationOptimisticPolicy,
} from './create-operation-mutation';
export {
  createOperationRequestPolicy,
  type OperationRequestAttempt,
  type OperationRequestPolicy,
  type OperationRequestPolicyCall,
  type OperationRequestPolicyConfig,
} from './create-operation-request-policy';
export {
  type CreateOperationResourceOptions,
  createOperationResource,
  type OperationResource,
} from './create-operation-resource';
export {
  createPolicyClient,
  createPolicyClientFromPolicy,
  type OperationPolicyClientConfig,
  type OperationPolicyClientRuntimeOptions,
} from './create-policy-client';
export {
  type AnonymousCredentialCapability,
  type BearerCredentialCapability,
  type CookieCredentialCapability,
  type CredentialCapability,
  type CredentialRequest,
} from './credential-capability';
export { OperationAbortedError } from './operation-aborted-error';
export { OperationApiError } from './operation-api-error';
export {
  type OperationCallOptions,
  type OperationClient,
  type OperationExecutionOptions,
  type OperationExecutor,
} from './operation-client';
export {
  type DeclaredResultOf,
  type DownloadOperationId,
  type ErrorCodeOf,
  type FrameworkOperationErrorCode,
  type HttpOperationId,
  type InputOf,
  type OperationDefinition,
  type OperationId,
  type OperationIdForTransport,
  type OperationMapOf,
  type OperationOf,
  type OperationTransport,
  type OperationTypeContract,
  type OperationTypeDefinition,
  type RemoteOperationId,
  type SocketOperationId,
  type StreamOperationId,
  type SuccessMapOf,
  type TransportOf,
  type UploadOperationId,
} from './operation-contract';
export { OperationMutationBusyError } from './operation-mutation-busy-error';
export { OperationMutationRollbackError } from './operation-mutation-rollback-error';
export {
  type OperationAuthentication,
  type OperationExecutionPolicy,
  type OperationIdempotency,
  type OperationPolicyMap,
  type OperationRetryPolicy,
  type OperationSafety,
} from './operation-policy';
export { OperationPolicyError, type OperationPolicyFailureReason } from './operation-policy-error';
export {
  type OperationDataOf,
  type OperationDataSuccessOf,
  type OperationFailure,
  type OperationFailureOf,
  type OperationNotModified,
  type OperationResult,
  type OperationResultOf,
  type OperationSuccess,
  type OperationSuccessOf,
  type OperationSuccessStatusOf,
} from './operation-result';
export {
  abortableOperationDelay,
  type OperationRetryTiming,
  operationRetryDelay,
  shouldRetryOperationResponse,
} from './operation-retry';
export { OperationTimeoutError } from './operation-timeout-error';
export {
  ProtocolError,
  type ProtocolErrorOptions,
  type ProtocolFailureReason,
} from './protocol-error';
export { provideShipClient, type ShipClientFactory } from './provide-ship-client';
export {
  EMPTY_RESPONSE_METADATA,
  parseRetryAfterMs,
  type ResponseMetadata,
  type ResponseMetadataHeaderNames,
  responseMetadataFromHeaders,
} from './response-metadata';
export {
  createShipClientContext,
  type ShipClientContext,
  type ShipClientContextConfig,
  type ShipClientForwardingRules,
} from './ship-client-context';
export { createShipClientToken, injectShipClient } from './ship-client-token';
export { type DeclaredShipError, type ShipError, type UnknownShipError } from './ship-error';
export {
  provideShipOperationBoundary,
  type ShipOperationBoundary,
  type ShipOperationBoundaryConfig,
  type ShipOperationBoundaryFactory,
} from './ship-operation-boundary';
export {
  TransportError,
  type TransportErrorOptions,
  type TransportFailureReason,
} from './transport-error';
export {
  failureFromErrorEnvelope,
  failureFromResponse,
  isWireErrorEnvelope,
  type WireErrorEnvelope,
} from './wire-error-envelope';
