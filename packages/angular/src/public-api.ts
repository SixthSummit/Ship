/**
 * @sixthsummit/ship-angular
 *
 * ShipAngular Framework - Build modern Angular applications with
 * Firebase authentication and a powerful CLI.
 *
 * @packageDocumentation
 */

// API
export { default as ApiClient } from './api/client/ApiClient';
export {
  ApiError,
  ApiErrorCode,
  type ApiErrorCodeName,
  type ApiErrorEnvelope,
  parseRetryAfter,
  RateLimitError,
} from './api/errors/ApiError';
export { HttpRequestError } from './api/errors/HttpRequestError';
export { API_ORIGINS, authInterceptor } from './api/interceptors/auth-interceptor';
export {
  CSRF_CONFIG,
  type CsrfConfig,
  csrfTokenInterceptor,
  provideCsrf,
  withCsrf,
} from './api/interceptors/csrf-interceptor';
export {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_GENERATOR,
  idempotencyInterceptor,
  SKIP_IDEMPOTENCY_HEADER,
  withIdempotency,
} from './api/interceptors/idempotency-interceptor';
export {
  provideRateLimit,
  RATE_LIMIT_CONFIG,
  type RateLimitConfig,
  rateLimitInterceptor,
  withRateLimit,
} from './api/interceptors/rate-limit-interceptor';
export {
  REQUEST_ID_GENERATOR,
  REQUEST_ID_HEADER,
  requestIdInterceptor,
  withRequestId,
} from './api/interceptors/request-id-interceptor';
export * from './api/interfaces/index';
export {
  type CreateResourceOptions,
  createResource,
  type ShipResource,
} from './api/resource/createResource';
export {
  injectShipApiClient,
  provideShipApiClient,
  SHIP_API_CLIENT,
  type ShipApiClientFactory,
} from './api/shipapi/provideShipApiClient';
export {
  type CreateSocketOptions,
  createSocket,
  type ShipSocket,
  type ShipSocketStatus,
} from './api/socket/createSocket';
export {
  type CreateStreamOptions,
  createStream,
  type ShipStream,
  type ShipStreamStatus,
  type StreamDecoder,
} from './api/stream/createStream';
export { parseSseFrames, type SseFrame } from './api/stream/sse-parser';
export {
  type CreateSignedUploadOptions,
  createSignedUpload,
  type ShipSignedUpload,
  type SignedUrlResponse,
} from './api/upload/createSignedUpload';
export {
  type CreateUploadOptions,
  createUpload,
  type ShipUpload,
  type ShipUploadStatus,
} from './api/upload/createUpload';
export type {
  AuthAdapter,
  AuthAdapterCapabilities,
  AuthCapabilityName,
  AuthState,
  AuthStateIssue,
  AuthUser,
  BearerTokenAuthCapability,
  EmailLinkAuthCapability,
  PasswordAuthCapability,
  PopupAuthCapability,
  SignInLinkSettings,
  SignOutAuthCapability,
} from './auth/adapters/AuthAdapter';
export { authGuard, noAuthGuard } from './auth/guards/auth-guards';
export { AuthCapabilityUnavailableError } from './auth/services/AuthCapabilityUnavailableError';
// Auth
export { AuthService } from './auth/services/AuthService';
// Env
export { defineEnv } from './env/defineEnv';
// Forms — schema-driven primitive
export {
  createSchemaForm,
  type SchemaFormGroup,
  type ZodObjectLike,
  zodValidator,
} from './forms/createSchemaForm';
// Logger
export { Logger } from './logger/Logger';

// Online / health
export { type OnlinePollConfig, OnlineService } from './online/OnlineService';
// Pipes
export { SafePipe } from './pipes/SafePipe';
export { TruncatePipe } from './pipes/TruncatePipe';
// Types
export * from './types/index';
// Version (auto-synced from package.json by scripts/sync-version.js)
export { VERSION } from './version';
