/**
 * `@sixthsummit/ship-api` — public API barrel for ShipAPI v4.
 *
 * This is the canonical entry point for consumer apps. The framework
 * exports a curated, semver-stable surface here; deep-path imports
 * (`@sixthsummit/ship-api/http/middleware/...`) are still available
 * but NOT covered by semver — they're for internal cross-module use
 * and advanced consumers who need primitives the barrel doesn't yet
 * surface.
 *
 * The `@sixthsummit/ship-api/client` subpath remains a separate
 * lightweight bundle for typed-client consumers (web / mobile) that
 * shouldn't pull in the framework's runtime deps. Import from there:
 *
 *   import { hc } from "@sixthsummit/ship-api/client";
 *   import type { ShipApiClient } from "@my-org/api";
 */

// ─── Agent-native application kernel (additive redesign) ─────────

export type {
  AccessGraphNode,
  ActorResolution,
  ActorResolutionFailure,
  ActorResolutionFailureReason,
  ActorResolutionRequest,
  ActorResolutionResult,
  ActorResolver,
  ActorResolverDefinition,
  AnyModule,
  AnyOperation,
  AnyProvider,
  ApplicationDefinition,
  ApplicationDiagnostic,
  ApplicationDiagnosticCode,
  ApplicationExecutor,
  ApplicationGraph,
  ApplicationModuleMap,
  ApplicationOperationMap,
  ApplicationProviderMap,
  AuthenticatedAccess,
  CompiledApplication,
  DependencyBindings,
  DependencyGraphNode,
  DependencyProviderValue,
  DependencyToken,
  EffectDependencyToken,
  EffectGraphNode,
  ExplicitOperationResponse,
  FrameworkOperationFailure,
  InferOperationInput,
  InferOperationOutputs,
  InferOperationRawInput,
  InferSchemaInput,
  InferSchemaOutput,
  LegacyOperationActor,
  ModuleDefinition,
  ModuleDiagnosticCode,
  ModuleGraphNode,
  NormalizedActorResolution,
  Operation,
  OperationAccess,
  OperationActor,
  OperationActorInput,
  OperationContext,
  OperationContextForAccess,
  OperationDefinition,
  OperationDefinitionDiagnosticCode,
  OperationErrorDefinition,
  OperationErrorDetails,
  OperationErrorDetailsInput,
  OperationErrorGraphNode,
  OperationErrorPayload,
  OperationExecutionDiagnosticCode,
  OperationExecutionResult,
  OperationFailureOptions,
  OperationFailureResult,
  OperationGraphNode,
  OperationHandler,
  OperationHandlerArguments,
  OperationHandlerResult,
  OperationId,
  OperationIdentity,
  OperationInputSchemas,
  OperationOutputSchemas,
  OperationOutputStatus,
  OperationRawInput,
  OperationResponse,
  OperationRunOptions,
  OperationSuccessResult,
  OperationTransactionMode,
  OperationTransport,
  OperationTransportMetadata,
  OperationTransportMetadataPrimitive,
  OperationTransportMetadataValue,
  OptionalIdentityAccess,
  OutputSchemaGraphNode,
  PermissionAccess,
  Provider,
  ProviderDefinition,
  ProviderDiagnosticCode,
  ProviderFactoryArguments,
  ProviderGraphNode,
  ProviderLifetime,
  PublicAccess,
  ResolveDependencyBindings,
  RuntimeSchema,
  SchemaGraphNode,
  SchemaIssue,
  SchemaResult,
  ShipModule,
  TenantBypass,
  TenantBypassAuditEvent,
  TenantBypassAuditSink,
  TenantBypassAuthority,
  TenantBypassRequest,
  TenantCapabilityErrorCode,
  TenantIdentifier,
  TenantScope,
  TenantScopeAuthority,
  TenantScopeRequest,
  TransportGraphNode,
  UnitOfWork,
  UnitOfWorkDependencyToken,
  ValidationIssue,
} from "./kernel/index.js";
export {
  ApplicationCompilationError,
  anyPermission,
  authenticatedAccess,
  checkOperationAccess,
  compileApp,
  createExecutor,
  createTenantBypassAuthority,
  createTenantScopeAuthority,
  defineActorResolver,
  defineApp,
  defineModule,
  defineOperation,
  defineProvider,
  dependency,
  effectDependency,
  InvalidModuleDefinitionError,
  InvalidOperationDefinitionError,
  InvalidProviderDefinitionError,
  isActorResolution,
  isActorResolver,
  isEffectDependencyToken,
  isExplicitOperationResponse,
  isOperationActor,
  isOperationIdentity,
  isTenantBypass,
  isTenantScope,
  isUnitOfWork,
  isUnitOfWorkDependencyToken,
  normalizeActorResolution,
  normalizeOperationActor,
  OperationExecutionError,
  OperationFailure,
  operationActor,
  operationError,
  operationFailure,
  operationIdentity,
  optionalIdentityAccess,
  permission,
  permissionSnapshot,
  publicAccess,
  respond,
  TenantCapabilityError,
  unitOfWorkDependency,
  valueProvider,
} from "./kernel/index.js";

// ─── HTTP layer ────────────────────────────────────────────────────

export type { PermissionDefinition } from "./app/auth/permissionDefinition.js";
export type {
  CreateHonoAdapterOptions,
  HeaderCredential,
  HonoAdapterDiagnosticCode,
  HonoAuthenticationOptions,
  HonoCredentialAdapter,
  HonoUnexpectedErrorContext,
  HttpJsonBodyPolicy,
  HttpMethod,
  HttpMultipartBodyOptions,
  HttpMultipartBodyPolicy,
  HttpRawBodyOptions,
  HttpRawBodyPolicy,
  HttpRequestBodyPolicy,
  HttpResponseMode,
  HttpTransport,
  HttpTransportOptions,
  ShipHttpErrorEnvelope,
} from "./hono/index.js";
export {
  createHonoAdapter,
  defineHonoCredentialAdapter,
  HonoAdapterError,
  honoAuthProvider,
  http,
  InvalidHttpTransportError,
  isHonoCredentialAdapter,
  isHttpTransport,
  requestHeadersCredential,
} from "./hono/index.js";
export type {
  AppEnv,
  AppEnvVariables,
  CorsOptions,
  CreateAppOptions,
  CreateModuleAppOptions,
} from "./http/app/createApp.js";
export { createApp, createModuleApp } from "./http/app/createApp.js";
export type { ErrorResponseShape, RegisterErrorHandlersOptions } from "./http/app/errors.js";
export { registerErrorHandlers } from "./http/app/errors.js";
export type { ApiKeyOptions } from "./http/middleware/apiKey.js";
export { apiKey } from "./http/middleware/apiKey.js";
export type { CsrfOptions } from "./http/middleware/csrf.js";
export { csrf } from "./http/middleware/csrf.js";
export type { HttpLoggerOptions } from "./http/middleware/httpLogger.js";
export { httpLogger } from "./http/middleware/httpLogger.js";
export type { IdempotencyOptions } from "./http/middleware/idempotency.js";
export { idempotency } from "./http/middleware/idempotency.js";
export type { RateLimitOptions } from "./http/middleware/rateLimit.js";
export { rateLimit } from "./http/middleware/rateLimit.js";
export type { RequireAuthOptions } from "./http/middleware/requireAuth.js";
export { AUTH_CONTEXT_KEYS, requireAuth } from "./http/middleware/requireAuth.js";
export { requirePermission } from "./http/middleware/requirePermission.js";
export type { ResolveTenantOptions } from "./http/middleware/resolveTenant.js";
export { resolveTenant } from "./http/middleware/resolveTenant.js";
export type { StreamSSEOptions } from "./http/streaming/sse.js";
export { streamSSE } from "./http/streaming/sse.js";
export { streamLLM } from "./http/streaming/streamLLM.js";
export { parseUpload } from "./http/utils/uploads.js";
export { validate } from "./http/utils/validate.js";
export { parseWebhook } from "./http/utils/webhooks.js";

// ─── Error taxonomy ────────────────────────────────────────────────

export {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "./http/errors/index.js";

// ─── Auth (pluggable AuthProvider interface + Firebase adapter) ────

export type {
  AccountResolver,
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthVerifyResult,
} from "./app/auth/AuthProvider.js";
export { FirebaseAuthProvider, firebaseAuth } from "./app/auth/adapters/firebase.js";

// ─── Database / ORM (Drizzle layer) ────────────────────────────────

export type { RequestContext } from "./app/context/RequestContext.js";
export { getRequestContext } from "./app/context/RequestContext.js";
export type { BaseFields } from "./app/db/baseFields.js";
export { baseFields, baseFieldsTimestampsOnly } from "./app/db/baseFields.js";
export type {
  ColumnFilter,
  OrderClause,
  QueryOperator,
  QueryOptions,
} from "./app/db/QueryOptions.js";
// `DslQueryFilter` (the DSL filter shape) lives in app/db/QueryOptions.js and
// is intentionally NOT re-exported here — it's the ORM-translation detail, not
// the common surface. Consumers driving the DSL directly import it from the
// subpath:
//   import type { DslQueryFilter } from "@sixthsummit/ship-api/app/db/QueryOptions";
// The barrel re-exports the lifecycle-hook `QueryFilter` below (the common one).
export { isQueryOperator, QUERY_OPERATORS } from "./app/db/QueryOptions.js";
export type { TenantScoped } from "./app/db/tenantScoped.js";
export { tenantScoped } from "./app/db/tenantScoped.js";
export type { ShipTx, WithTransactionOptions } from "./app/db/transaction.js";
export { RollbackError, withTransaction } from "./app/db/transaction.js";
export { DrizzleEntityService } from "./app/services/DrizzleEntityService.js";

// ─── Lifecycle hooks ───────────────────────────────────────────────

export type {
  LifecycleHookContext,
  LifecycleHooks,
  QueryFilter,
} from "./app/services/hooks/LifecycleHooks.js";
export { composeHooks } from "./app/services/hooks/LifecycleHooks.js";

// ─── Cache ─────────────────────────────────────────────────────────

export type { Cache, CacheSetOptions, InMemoryCacheOptions } from "./app/services/cache/index.js";
export { cached, InMemoryCache, RedisCache } from "./app/services/cache/index.js";

// ─── Redis provider ────────────────────────────────────────────────

export { RedisProvider } from "./app/services/RedisProvider.js";

// ─── Background jobs (BullMQ) ──────────────────────────────────────

export type {
  JobDefinition,
  JobDefinitionOptions,
  JobHandler,
  JobHandlerContext,
  JobsManagerOptions,
  WorkerMode,
} from "./app/services/jobs/index.js";
export { defineJob, JobRegistry, JobsManager, jobRegistry } from "./app/services/jobs/index.js";

// ─── Cron (schema-driven) ──────────────────────────────────────────

export type { DefineCronArgs } from "./app/services/cron/index.js";
export { CRON_QUEUE, defineCron } from "./app/services/cron/index.js";

// ─── Health checks ─────────────────────────────────────────────────

export type {
  AddHealthCheckOptions,
  HealthCheck,
  HealthCheckFailure,
  HealthCheckResult,
  RunAllOptions,
  RunAllResult,
} from "./app/health/HealthCheck.js";
export { HealthCheckRegistry, healthCheckRegistry } from "./app/health/HealthCheck.js";
export { redisHealthCheck } from "./app/health/redisHealthCheck.js";
export type {
  ReadyzBody,
  ReadyzCheck,
  RegisterHealthRoutesOptions,
} from "./http/app/health.js";
export { hasHealthRoutes, registerHealthRoutes } from "./http/app/health.js";

// ─── Route registry (introspectable; consumed by MCP tools + agents) ──

export type { RouteEntry } from "./app/registry/routes.js";
export { routeRegistry } from "./app/registry/routes.js";

// ─── Env validation ────────────────────────────────────────────────

export type {
  DefineEnvOptions,
  EnvSafeParseResult,
  EnvSchema,
  EnvSchemaError,
  EnvSchemaIssue,
} from "./app/utils/defineEnv.js";
export { defineEnv } from "./app/utils/defineEnv.js";
