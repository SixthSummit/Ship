import type { OperationAccess } from "./access.js";
import {
  type AttachmentGraphNode,
  checkOperationAttachments,
  collectAttachmentOwners,
  isAttachmentDependencyToken,
  projectAttachments,
} from "./attachment.js";
import type { CacheScope } from "./cache.js";
import { cacheControlHeader, isCacheBackendDependencyToken } from "./cache.js";
import { cacheInvalidationOutbox } from "./cache-invalidation.js";
import {
  type DependencyBindings,
  type DependencyToken,
  isEffectDependencyToken,
  isUnitOfWorkDependencyToken,
} from "./dependency.js";
import { isIdempotencyStoreDependencyToken } from "./idempotency.js";
import type { AnyJob, JobDeclaration, JobTrigger, JobWorkerMode } from "./job.js";
import {
  describeJobOperation,
  isJob,
  isJobDependencyToken,
  isJobEnqueueDependencyToken,
  JOB_BACKEND_ID,
  JOB_LOCK_PROVIDER_ID,
} from "./job.js";
import type { AnyModule } from "./module.js";
import { isShipModule } from "./module.js";
import type {
  AnyOperation,
  OperationStreamResponse,
  OperationTransportMetadata,
} from "./operation.js";
import type { AnyOutbox } from "./outbox.js";
import { describeOutboxOperation, isOutboxDependencyToken } from "./outbox.js";
import type { AnyProvider } from "./provider.js";
import {
  type ChannelGraphNode,
  checkOperationPublications,
  collectChannelOwners,
  isChannelPublicationToken,
  projectChannels,
} from "./realtime.js";
import {
  checkRealtimePublicationDispatch,
  type PublicationDelivery,
  publicationDelivery,
} from "./realtime-publication.js";

const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const WORKER_MODES = new Set<JobWorkerMode>(["api", "worker", "all"]);

export type ApplicationDiagnosticCode =
  | "SHIP_APP_DEFINITION_INVALID"
  | "SHIP_APP_ID_INVALID"
  | "SHIP_APP_MODULE_INVALID"
  | "SHIP_MODULE_ID_DUPLICATE"
  | "SHIP_MODULE_IMPORT_MISSING"
  | "SHIP_MODULE_IMPORT_CYCLE"
  | "SHIP_MODULE_OPERATION_ID_MISMATCH"
  | "SHIP_OPERATION_ID_DUPLICATE"
  | "SHIP_PROVIDER_ID_DUPLICATE"
  | "SHIP_MODULE_EXPORT_NOT_OWNED"
  | "SHIP_PROVIDER_MISSING"
  | "SHIP_MODULE_IMPORT_REQUIRED"
  | "SHIP_PROVIDER_NOT_EXPORTED"
  | "SHIP_PROVIDER_DEPENDENCY_CYCLE"
  | "SHIP_PROVIDER_LIFETIME_INVALID"
  | "SHIP_OPERATION_UNIT_OF_WORK_REQUIRED"
  | "SHIP_OPERATION_UNIT_OF_WORK_FORBIDDEN"
  | "SHIP_OPERATION_UNIT_OF_WORK_MULTIPLE"
  | "SHIP_PROVIDER_UNIT_OF_WORK_FORBIDDEN"
  | "SHIP_OPERATION_EFFECT_UNDECLARED"
  | "SHIP_OPERATION_EFFECT_UNBOUND"
  | "SHIP_OPERATION_EFFECT_TRANSACTION_FORBIDDEN"
  | "SHIP_PROVIDER_EFFECT_FORBIDDEN"
  | "SHIP_UNIT_OF_WORK_PROVIDER_LIFETIME_INVALID"
  | "SHIP_TRANSPORT_BINDING_DUPLICATE"
  | "SHIP_OUTBOX_WRITER_TRANSACTION_INVALID"
  | "SHIP_OUTBOX_DISPATCHER_MISSING"
  | "SHIP_OUTBOX_INTENT_UNDISPATCHED"
  | "SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE"
  | "SHIP_OUTBOX_PROVIDER_LIFETIME_INVALID"
  | "SHIP_PROVIDER_OUTBOX_FORBIDDEN"
  | "SHIP_IDEMPOTENCY_PROVIDER_LIFETIME_INVALID"
  | "SHIP_OPERATION_STREAM_TRANSACTION_FORBIDDEN"
  | "SHIP_OPERATION_STREAM_LIMIT_MISSING"
  | "SHIP_OPERATION_STREAM_OUTPUT_INVALID"
  | "SHIP_OPERATION_STREAM_IDEMPOTENCY_FORBIDDEN"
  | "SHIP_OPERATION_STREAM_CACHE_FORBIDDEN"
  | "SHIP_CACHE_TRANSACTION_FORBIDDEN"
  | "SHIP_CACHE_BACKEND_UNBOUND"
  | "SHIP_CACHE_SCOPE_ACTOR_INVALID"
  | "SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID"
  | "SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING"
  | "SHIP_CACHE_PROVIDER_LIFETIME_INVALID"
  | "SHIP_CACHE_TAG_UNKNOWN"
  | "SHIP_CACHE_TAG_SCOPE_UNMATCHED"
  | "SHIP_CACHE_INVALIDATES_ACTOR_INVALID"
  | "SHIP_CACHE_PUBLIC_SCOPE_PROTECTED"
  | "SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN"
  | "SHIP_CACHE_VARY_SUBJECT_PUBLIC"
  | "SHIP_CHANNEL_ID_DUPLICATE"
  | "SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE"
  | "SHIP_CHANNEL_UNDECLARED"
  | "SHIP_CHANNEL_IMPORT_REQUIRED"
  | "SHIP_OPERATION_PUBLISH_UNBOUND"
  | "SHIP_OPERATION_PUBLISH_UNDECLARED"
  | "SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN"
  | "SHIP_APP_RUNTIME_INVALID"
  | "SHIP_JOB_ID_DUPLICATE"
  | "SHIP_JOB_LOCK_PROVIDER_MISSING"
  | "SHIP_JOB_LOCK_PROVIDER_LIFETIME_INVALID"
  | "SHIP_JOB_BACKEND_PROVIDER_LIFETIME_INVALID"
  | "SHIP_JOB_BACKEND_BINDING_FORBIDDEN"
  | "SHIP_JOB_DEPENDENCY_MISSING"
  | "SHIP_JOB_HTTP_TRIGGER_UNBOUND"
  | "SHIP_JOB_SINGLE_RUNNER_UNKEYED"
  | "SHIP_PROVIDER_JOB_FORBIDDEN"
  | "SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING"
  | "SHIP_ATTACHMENT_ID_DUPLICATE"
  | "SHIP_ATTACHMENT_MODULE_ID_MISMATCH"
  | "SHIP_ATTACHMENT_STORAGE_MODULE_MISSING"
  | "SHIP_ATTACHMENT_UNDECLARED"
  | "SHIP_ATTACHMENT_IMPORT_REQUIRED"
  | "SHIP_ATTACHMENT_PROVIDER_LIFETIME_INVALID"
  | "SHIP_OPERATION_ATTACHMENT_UNBOUND"
  | "SHIP_OPERATION_ATTACHMENT_UNDECLARED";

export type ApplicationDiagnosticSeverity = "error" | "warning";

export interface ApplicationDiagnostic {
  readonly code: ApplicationDiagnosticCode;
  /** Errors fail compilation; warnings are retained on the compiled application. */
  readonly severity: ApplicationDiagnosticSeverity;
  readonly message: string;
  readonly hint: string;
  readonly appId?: string;
  readonly moduleId?: string;
  readonly operationId?: string;
  readonly providerId?: string;
  readonly path?: string;
}

export class ApplicationCompilationError extends Error {
  readonly diagnostics: readonly ApplicationDiagnostic[];

  constructor(diagnostics: readonly ApplicationDiagnostic[]) {
    super(
      `Ship application compilation failed with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`,
    );
    this.name = "ApplicationCompilationError";
    this.diagnostics = Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic)));
  }
}

export interface ApplicationWorkerRuntimeOptions {
  /** Which role this process plays for declared jobs; `api` starts no workers. */
  readonly mode: JobWorkerMode;
  /** Process-wide in-flight cap across every job; adapters default when absent. */
  readonly budget?: number;
}

export interface ApplicationRuntimeOptions {
  readonly workers?: ApplicationWorkerRuntimeOptions;
}

export interface ApplicationDefinition<TId extends string, TModules extends readonly AnyModule[]> {
  readonly id: TId;
  readonly modules: TModules;
  /** Deployment-shaped runtime declarations read by `startJobRuntime`. */
  readonly runtime?: ApplicationRuntimeOptions;
}

type ModuleUnion<TModules extends readonly AnyModule[]> = TModules[number];
type OperationUnion<TModules extends readonly AnyModule[]> =
  ModuleUnion<TModules>["operations"][number];
type ProviderUnion<TModules extends readonly AnyModule[]> =
  ModuleUnion<TModules>["providers"][number];

export type ApplicationModuleMap<TModules extends readonly AnyModule[]> = Readonly<{
  [TModule in ModuleUnion<TModules> as TModule["id"]]: TModule;
}>;

export type ApplicationOperationMap<TModules extends readonly AnyModule[]> = Readonly<{
  [TOperation in OperationUnion<TModules> as TOperation["id"]]: TOperation;
}>;

export type ApplicationProviderMap<TModules extends readonly AnyModule[]> = Readonly<{
  [TProvider in ProviderUnion<TModules> as TProvider["token"]["id"]]: TProvider;
}>;

export interface CompiledApplication<TId extends string, TModules extends readonly AnyModule[]> {
  readonly kind: "ship.application";
  readonly id: TId;
  readonly modules: TModules;
  readonly moduleById: ApplicationModuleMap<TModules>;
  readonly operationById: ApplicationOperationMap<TModules>;
  readonly providerById: ApplicationProviderMap<TModules>;
  readonly graph: ApplicationGraph;
  /** Non-fatal diagnostics (warnings) retained from compilation. */
  readonly diagnostics: readonly ApplicationDiagnostic[];
  readonly runtime: ApplicationRuntimeOptions;
}

export interface ApplicationGraph {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly modules: readonly ModuleGraphNode[];
  readonly operations: readonly OperationGraphNode[];
  readonly providers: readonly ProviderGraphNode[];
  readonly outboxes: readonly OutboxGraphNode[];
  /** Non-fatal compilation findings, such as an invalidated tag no read declares. */
  readonly diagnostics?: readonly ApplicationDiagnostic[];
  readonly channels: readonly ChannelGraphNode[];
  readonly jobs: readonly JobGraphNode[];
  /** Declared managed attachments; absent provider detail by design. */
  readonly attachments: readonly AttachmentGraphNode[];
}

export interface JobGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly trigger: JobTrigger;
  readonly concurrency: JobDeclaration["concurrency"];
  readonly retry: JobDeclaration["retry"];
  readonly retention?: JobDeclaration["retention"];
  readonly transaction: JobDeclaration["transaction"];
  readonly effects: readonly string[];
  /** Jobs this job declares it enqueues through `jobDependency()`. */
  readonly enqueues: readonly string[];
  readonly operations: {
    /** Transport-projected trigger operations bound to this job. */
    readonly triggers: readonly string[];
    /** Operations and jobs that enqueue this job. */
    readonly enqueuedBy: readonly string[];
  };
}

export interface OperationJobGraphNode {
  readonly role: "job" | "trigger" | "cleanup" | "management" | "enqueue" | "backend" | "lock";
  readonly jobId?: string;
  readonly action?: string;
}

export interface OutboxIntentGraphNode {
  readonly id: string;
  /** The effect provider id this intent performs when dispatched. */
  readonly effectId: string;
  readonly payloadVendor: string;
}

export interface OutboxGraphNode {
  readonly id: string;
  /** The provider id that binds the outbox backend. */
  readonly providerId: string;
  readonly intents: readonly OutboxIntentGraphNode[];
  readonly retention?: { readonly completedMs: number; readonly deadLetteredMs: number };
  /** Declared sustained write rate, when the outbox states one. */
  readonly expectedRatePerSecond?: number;
  /**
   * Declared dispatch capacity per process, the dispatcher's
   * `batchSize x roundsPerSecond`; present only when it declares
   * `roundsPerSecond`.
   */
  readonly dispatchCapacityPerSecond?: number;
  readonly operations: {
    readonly writers: readonly string[];
    readonly dispatchers: readonly string[];
    readonly cleanups: readonly string[];
    readonly management: readonly string[];
  };
}

export interface OperationOutboxGraphNode {
  readonly id: string;
  readonly role: "writer" | "backend" | "dispatcher" | "cleanup" | "management";
  /** Intents handled by a dispatcher operation. */
  readonly intents?: readonly string[];
}

export interface OperationCacheGraphNode {
  readonly ttlMs: number;
  readonly scope: CacheScope;
  readonly tags: readonly string[];
  /** True when the operation narrows its key with a vary(input) function. */
  readonly varies: boolean;
  readonly backendId: string;
  /** The Cache-Control value HTTP adapters project for this policy. */
  readonly cacheControl: string;
}

export interface OperationInvalidationGraphNode {
  readonly tag: string;
  readonly scope: "actor" | "tenant";
}

export interface OperationIdempotencyGraphNode {
  readonly windowMs: number;
  readonly storeId: string;
}

export interface ModuleGraphNode {
  readonly id: string;
  readonly imports: readonly string[];
  readonly operations: readonly string[];
  readonly providers: readonly string[];
  readonly exports: readonly string[];
  readonly channels: readonly string[];
  readonly attachments: readonly string[];
}

export interface OperationGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly input: readonly SchemaGraphNode[];
  readonly output: readonly OutputSchemaGraphNode[];
  readonly successStatus: number;
  readonly errors: readonly OperationErrorGraphNode[];
  readonly access: AccessGraphNode;
  readonly transaction: "none" | "read" | "write";
  readonly dependencies: readonly DependencyGraphNode[];
  readonly effects: readonly EffectGraphNode[];
  readonly transport?: TransportGraphNode;
  readonly outbox?: readonly OperationOutboxGraphNode[];
  readonly idempotency?: OperationIdempotencyGraphNode;
  readonly cache?: OperationCacheGraphNode;
  /** Cache tags this write operation purges through the cache-invalidation outbox. */
  readonly invalidates?: readonly string[];
  /** The subset of `invalidates` purged for the write's own actor or authentic tenant only. */
  readonly invalidatesScoped?: readonly OperationInvalidationGraphNode[];
  readonly publishes: readonly string[];
  readonly job?: readonly OperationJobGraphNode[];
  /** Present when the operation publishes: immediate on `none`, through the outbox on `write`. */
  readonly publicationDelivery?: PublicationDelivery;
  /** Managed attachment ids this operation binds. */
  readonly attachments?: readonly string[];
}

export interface EffectGraphNode {
  readonly id: string;
  readonly delivery: "immediate";
}

export interface ProviderGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly lifetime: "singleton" | "operation";
  readonly dependencies: readonly DependencyGraphNode[];
  readonly scope?:
    | "unit-of-work"
    | "effect"
    | "outbox"
    | "idempotency"
    | "cache"
    | "job"
    | "attachment";
  readonly delivery?: "immediate";
}

export interface DependencyGraphNode {
  readonly name: string;
  readonly providerId: string;
  readonly scope?:
    | "unit-of-work"
    | "effect"
    | "outbox"
    | "idempotency"
    | "cache"
    | "job"
    | "attachment";
  readonly role?: "writer" | "backend" | "enqueue" | "lock";
  /** For job enqueue bindings: the job that will be enqueued. */
  readonly jobId?: string;
}

export interface SchemaGraphNode {
  readonly name: string;
  readonly vendor: string;
}

export interface OutputSchemaGraphNode {
  readonly status: number;
  readonly vendor: string;
}

export interface OperationErrorGraphNode {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly detailsVendor?: string;
}

export type AccessGraphNode =
  | { readonly kind: "public" }
  | { readonly kind: "optional-identity" }
  | { readonly kind: "authenticated" }
  | { readonly kind: "system" }
  | { readonly kind: "provider"; readonly provider: string }
  | {
      readonly kind: "permissions";
      readonly mode: "all" | "any";
      readonly permissions: readonly string[];
    };

export interface TransportGraphNode {
  readonly kind: string;
  readonly binding?: string;
  readonly metadata?: OperationTransportMetadata;
  readonly response?: StreamResponseGraphNode;
}

export interface StreamResponseGraphNode {
  readonly mode: "stream";
  readonly framing: string;
  readonly frame: { readonly vendor: string };
  readonly heartbeatMs: number;
  readonly maxDurationMs: number;
  readonly maxFrames: number;
}

export function defineApp<const TId extends string, const TModules extends readonly AnyModule[]>(
  definition: ApplicationDefinition<TId, TModules>,
): CompiledApplication<TId, TModules> {
  return compileApp(definition);
}

export function compileApp<const TId extends string, const TModules extends readonly AnyModule[]>(
  definition: ApplicationDefinition<TId, TModules>,
): CompiledApplication<TId, TModules> {
  assertApplicationDefinition(definition);

  const diagnostics = compileDiagnostics(definition.id, definition.modules);
  const errors = diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) throw new ApplicationCompilationError(errors);
  const warnings = Object.freeze(
    diagnostics.filter((item) => item.severity === "warning").map((item) => Object.freeze(item)),
  );

  const moduleById = Object.create(null) as Record<string, AnyModule>;
  const operationById = Object.create(null) as Record<string, AnyOperation>;
  const providerById = Object.create(null) as Record<string, AnyProvider>;

  for (const module of definition.modules) {
    moduleById[module.id] = module;
    for (const operation of module.operations) operationById[operation.id] = operation;
    for (const provider of module.providers) providerById[provider.token.id] = provider;
  }

  return Object.freeze({
    kind: "ship.application" as const,
    id: definition.id,
    modules: Object.freeze([...definition.modules]) as unknown as TModules,
    moduleById: Object.freeze(moduleById) as ApplicationModuleMap<TModules>,
    operationById: Object.freeze(operationById) as ApplicationOperationMap<TModules>,
    providerById: Object.freeze(providerById) as ApplicationProviderMap<TModules>,
    graph: projectGraph(definition.id, definition.modules, warnings),
    diagnostics: warnings,
    runtime: projectRuntime(definition.runtime),
  });
}

function projectRuntime(runtime: ApplicationRuntimeOptions | undefined): ApplicationRuntimeOptions {
  return Object.freeze({
    ...(runtime?.workers
      ? {
          workers: Object.freeze({
            mode: runtime.workers.mode,
            ...(runtime.workers.budget !== undefined ? { budget: runtime.workers.budget } : {}),
          }),
        }
      : {}),
  });
}

function assertApplicationDefinition(
  definition: unknown,
): asserts definition is ApplicationDefinition<string, readonly AnyModule[]> {
  if (typeof definition !== "object" || definition === null) {
    throw new ApplicationCompilationError([
      diagnostic(
        "SHIP_APP_DEFINITION_INVALID",
        "application definition must be an object",
        "Pass { id, modules } to defineApp().",
      ),
    ]);
  }

  const id = Reflect.get(definition, "id");
  if (typeof id !== "string" || !APPLICATION_ID_PATTERN.test(id)) {
    throw new ApplicationCompilationError([
      diagnostic(
        "SHIP_APP_ID_INVALID",
        "application id must be a lowercase dot-separated identifier",
        "Use a stable id such as billing-api or platform.billing.",
        { appId: typeof id === "string" ? id : undefined, path: "id" },
      ),
    ]);
  }

  const modules = Reflect.get(definition, "modules");
  if (!Array.isArray(modules) || !modules.every(isShipModule)) {
    throw new ApplicationCompilationError([
      diagnostic(
        "SHIP_APP_MODULE_INVALID",
        "application modules must contain only defineModule() results",
        "Construct every module with defineModule() before composing the application.",
        { appId: id, path: "modules" },
      ),
    ]);
  }

  const runtime = Reflect.get(definition, "runtime");
  if (runtime !== undefined) {
    const workers =
      typeof runtime === "object" && runtime !== null && Reflect.get(runtime, "workers");
    const mode = typeof workers === "object" && workers !== null && Reflect.get(workers, "mode");
    const budget =
      typeof workers === "object" && workers !== null && Reflect.get(workers, "budget");
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      (workers !== undefined &&
        (typeof workers !== "object" ||
          workers === null ||
          !WORKER_MODES.has(mode as JobWorkerMode) ||
          (budget !== undefined && !(Number.isInteger(budget) && (budget as number) > 0))))
    ) {
      throw new ApplicationCompilationError([
        diagnostic(
          "SHIP_APP_RUNTIME_INVALID",
          "application runtime.workers must declare mode api, worker, or all with an optional positive integer budget",
          'Pass runtime: { workers: { mode: "worker", budget: 8 } } or omit runtime.',
          { appId: id, path: "runtime.workers" },
        ),
      ]);
    }
  }
}

function compileDiagnostics(
  appId: string,
  modules: readonly AnyModule[],
): readonly ApplicationDiagnostic[] {
  const diagnostics: ApplicationDiagnostic[] = [];
  const sortedModules = [...modules].sort(compareBy((module) => module.id));
  const modulesById = new Map<string, AnyModule>();
  const providerOwners = new Map<string, AnyModule>();
  const operationOwners = new Map<string, AnyModule>();
  const transportOwners = new Map<string, { module: AnyModule; operation: AnyOperation }>();

  for (const module of sortedModules) {
    if (modulesById.has(module.id)) {
      diagnostics.push(
        diagnostic(
          "SHIP_MODULE_ID_DUPLICATE",
          `module id ${JSON.stringify(module.id)} is declared more than once`,
          "Give each module one stable unique id.",
          { appId, moduleId: module.id, path: "modules" },
        ),
      );
    } else {
      modulesById.set(module.id, module);
    }

    for (const operation of [...module.operations].sort(compareBy((item) => item.id))) {
      if (!operation.id.startsWith(`${module.id}.`)) {
        const jobRole = describeJobOperation(operation);
        diagnostics.push(
          diagnostic(
            "SHIP_MODULE_OPERATION_ID_MISMATCH",
            `operation ${JSON.stringify(operation.id)} is not namespaced by module ${JSON.stringify(module.id)}`,
            jobRole?.role === "management"
              ? `defineJobManagement({ prefix }) must use the owning module id: pass prefix ${JSON.stringify(module.id)} or compose the operations into a module with that id.`
              : jobRole?.role === "job"
                ? `Job ids are namespaced by the module that owns them: rename the job so its id starts with ${JSON.stringify(`${module.id}.`)}.`
                : `Rename the operation so its id starts with ${JSON.stringify(`${module.id}.`)}.`,
            { appId, moduleId: module.id, operationId: operation.id, path: "operations" },
          ),
        );
      }

      const previousOwner = operationOwners.get(operation.id);
      if (previousOwner) {
        diagnostics.push(
          diagnostic(
            "SHIP_OPERATION_ID_DUPLICATE",
            `operation id ${JSON.stringify(operation.id)} is owned by both ${JSON.stringify(previousOwner.id)} and ${JSON.stringify(module.id)}`,
            "Give each callable capability one globally unique operation id.",
            { appId, moduleId: module.id, operationId: operation.id, path: "operations" },
          ),
        );
      } else {
        operationOwners.set(operation.id, module);
      }

      const binding = operation.transport?.binding;
      if (binding) {
        const key = `${operation.transport?.kind}:${binding}`;
        const previousTransport = transportOwners.get(key);
        if (previousTransport) {
          diagnostics.push(
            diagnostic(
              "SHIP_TRANSPORT_BINDING_DUPLICATE",
              `transport binding ${JSON.stringify(key)} is shared by ${JSON.stringify(previousTransport.operation.id)} and ${JSON.stringify(operation.id)}`,
              "Change or remove one binding; adapters require one authoritative operation per binding.",
              { appId, moduleId: module.id, operationId: operation.id, path: "transport.binding" },
            ),
          );
        } else {
          transportOwners.set(key, { module, operation });
        }
      }
    }

    for (const provider of [...module.providers].sort(compareBy((item) => item.token.id))) {
      const providerId = provider.token.id;
      const previousOwner = providerOwners.get(providerId);
      if (previousOwner) {
        diagnostics.push(
          diagnostic(
            "SHIP_PROVIDER_ID_DUPLICATE",
            `provider ${JSON.stringify(providerId)} is owned by both ${JSON.stringify(previousOwner.id)} and ${JSON.stringify(module.id)}`,
            "Bind each dependency token in exactly one module.",
            { appId, moduleId: module.id, providerId, path: "providers" },
          ),
        );
      } else {
        providerOwners.set(providerId, module);
      }
    }
  }

  const channelOwners = collectChannelOwners(appId, sortedModules, diagnostics);
  const attachmentOwners = collectAttachmentOwners(appId, sortedModules, diagnostics);

  for (const module of sortedModules) {
    for (const importedId of [...module.imports].sort()) {
      if (!modulesById.has(importedId)) {
        diagnostics.push(
          diagnostic(
            "SHIP_MODULE_IMPORT_MISSING",
            `module ${JSON.stringify(module.id)} imports missing module ${JSON.stringify(importedId)}`,
            "Add the imported module to the application or remove the import.",
            { appId, moduleId: module.id, path: "imports" },
          ),
        );
      }
    }

    const localProviders = new Set(module.providers.map((provider) => provider.token.id));
    for (const token of [...module.exports].sort(compareBy((item) => item.id))) {
      if (!localProviders.has(token.id)) {
        diagnostics.push(
          diagnostic(
            "SHIP_MODULE_EXPORT_NOT_OWNED",
            `module ${JSON.stringify(module.id)} exports provider ${JSON.stringify(token.id)} that it does not own`,
            "Export only tokens provided by this module.",
            { appId, moduleId: module.id, providerId: token.id, path: "exports" },
          ),
        );
      }
    }

    for (const operation of module.operations) {
      checkOperationUnitOfWork(appId, module, operation, diagnostics);
      checkOperationEffects(appId, module, operation, diagnostics);
      checkOperationOutbox(appId, module, operation, diagnostics);
      checkOperationStream(appId, module, operation, diagnostics);
      checkOperationCache(appId, module, operation, diagnostics);
      checkOperationPublications(appId, module, operation, channelOwners, diagnostics);
      checkOperationAttachments(appId, module, operation, attachmentOwners, diagnostics);
      checkOperationJobBindings(appId, module, operation, diagnostics);
      checkDependencies(
        appId,
        module,
        operation.dependencies,
        providerOwners,
        modulesById,
        diagnostics,
        { operationId: operation.id, pathPrefix: "dependencies" },
      );
      if (operation.idempotency) {
        checkDependencies(
          appId,
          module,
          { store: operation.idempotency.store },
          providerOwners,
          modulesById,
          diagnostics,
          { operationId: operation.id, pathPrefix: "idempotency" },
        );
      }
      if (operation.invalidates && operation.invalidates.length > 0) {
        checkDependencies(
          appId,
          module,
          { outbox: cacheInvalidationOutbox.writer },
          providerOwners,
          modulesById,
          diagnostics,
          { operationId: operation.id, pathPrefix: "invalidates" },
        );
      }
    }

    for (const provider of module.providers) {
      if (isUnitOfWorkDependencyToken(provider.token) && provider.lifetime !== "singleton") {
        diagnostics.push(
          diagnostic(
            "SHIP_UNIT_OF_WORK_PROVIDER_LIFETIME_INVALID",
            `unit-of-work provider ${JSON.stringify(provider.token.id)} must use singleton lifetime`,
            "Construct one unit-of-work controller and let it create isolated transaction scopes per run.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.lifetime",
            },
          ),
        );
      }
      if (isOutboxDependencyToken(provider.token) && provider.lifetime !== "singleton") {
        diagnostics.push(
          diagnostic(
            "SHIP_OUTBOX_PROVIDER_LIFETIME_INVALID",
            `outbox provider ${JSON.stringify(provider.token.id)} must use singleton lifetime`,
            "Bind one durable outbox backend and let the executor create per-transaction writers.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.lifetime",
            },
          ),
        );
      }
      if (isIdempotencyStoreDependencyToken(provider.token) && provider.lifetime !== "singleton") {
        diagnostics.push(
          diagnostic(
            "SHIP_IDEMPOTENCY_PROVIDER_LIFETIME_INVALID",
            `idempotency store provider ${JSON.stringify(provider.token.id)} must use singleton lifetime`,
            "A per-operation store cannot observe duplicate or in-flight keys across invocations.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.lifetime",
            },
          ),
        );
      }
      if (isAttachmentDependencyToken(provider.token) && provider.lifetime !== "singleton") {
        diagnostics.push(
          diagnostic(
            "SHIP_ATTACHMENT_PROVIDER_LIFETIME_INVALID",
            `attachment capability provider ${JSON.stringify(provider.token.id)} must use singleton lifetime`,
            "Bind one capability per attachment; the executor scopes it to each run's transaction.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.lifetime",
            },
          ),
        );
      }
      if (isCacheBackendDependencyToken(provider.token) && provider.lifetime !== "singleton") {
        diagnostics.push(
          diagnostic(
            "SHIP_CACHE_PROVIDER_LIFETIME_INVALID",
            `cache backend provider ${JSON.stringify(provider.token.id)} must use singleton lifetime`,
            "A per-operation cache backend cannot share entries or single-flight across invocations.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.lifetime",
            },
          ),
        );
      }
      if (
        (provider.token.id === JOB_BACKEND_ID || provider.token.id === JOB_LOCK_PROVIDER_ID) &&
        provider.lifetime !== "singleton"
      ) {
        const isBackend = provider.token.id === JOB_BACKEND_ID;
        diagnostics.push(
          diagnostic(
            isBackend
              ? "SHIP_JOB_BACKEND_PROVIDER_LIFETIME_INVALID"
              : "SHIP_JOB_LOCK_PROVIDER_LIFETIME_INVALID",
            `${isBackend ? "job backend" : "job lock"} provider ${JSON.stringify(provider.token.id)} must use singleton lifetime`,
            isBackend
              ? "Bind one durable job backend per process; per-operation backends cannot own workers or schedules."
              : "Bind one lock provider per process so single-runner leases are observed across every run.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.lifetime",
            },
          ),
        );
      }
      if (Object.values(provider.dependencies).some(isJobDependencyToken)) {
        diagnostics.push(
          diagnostic(
            "SHIP_PROVIDER_JOB_FORBIDDEN",
            `provider ${JSON.stringify(provider.token.id)} cannot depend on a job token`,
            "Bind job enqueuers and the job backend directly on operations so job-to-job edges stay visible.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.dependencies",
            },
          ),
        );
      }
      if (Object.values(provider.dependencies).some(isOutboxDependencyToken)) {
        diagnostics.push(
          diagnostic(
            "SHIP_PROVIDER_OUTBOX_FORBIDDEN",
            `provider ${JSON.stringify(provider.token.id)} cannot depend on an outbox token`,
            "Bind outbox writers and backends directly on operations so delivery intent stays visible.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.dependencies",
            },
          ),
        );
      }
      if (Object.values(provider.dependencies).some(isEffectDependencyToken)) {
        diagnostics.push(
          diagnostic(
            "SHIP_PROVIDER_EFFECT_FORBIDDEN",
            `provider ${JSON.stringify(provider.token.id)} cannot hide an external effect dependency`,
            "Inject effect dependencies directly into each operation and declare them in effects.",
            {
              appId,
              moduleId: module.id,
              providerId: provider.token.id,
              path: "providers.dependencies",
            },
          ),
        );
      }
      checkDependencies(
        appId,
        module,
        provider.dependencies,
        providerOwners,
        modulesById,
        diagnostics,
        { providerId: provider.token.id, pathPrefix: "providers.dependencies" },
      );
    }
  }

  checkOutboxCoverage(appId, sortedModules, diagnostics);
  checkCacheTags(appId, sortedModules, diagnostics);
  checkJobs(appId, sortedModules, providerOwners, diagnostics);
  checkRealtimePublicationDispatch(appId, sortedModules, diagnostics);

  const moduleEdges = new Map(
    [...modulesById].map(([id, module]) => [
      id,
      module.imports.filter((importedId) => modulesById.has(importedId)),
    ]),
  );
  for (const cycle of findCycles(moduleEdges)) {
    diagnostics.push(
      diagnostic(
        "SHIP_MODULE_IMPORT_CYCLE",
        `module import cycle: ${cycle.join(" -> ")}`,
        "Move shared capabilities into a lower-level module and keep imports acyclic.",
        { appId, moduleId: cycle[0], path: "imports" },
      ),
    );
  }

  const providerEdges = new Map<string, readonly string[]>();
  for (const [providerId, owner] of providerOwners) {
    const provider = owner.providers.find((candidate) => candidate.token.id === providerId);
    if (provider) {
      providerEdges.set(
        providerId,
        Object.values(provider.dependencies)
          .map((token) => token.id)
          .filter((dependencyId) => providerOwners.has(dependencyId)),
      );
    }
  }
  // Reject every captive edge. This also rejects longer singleton dependency chains
  // at the first edge crossing into operation lifetime.
  for (const [providerId, owner] of providerOwners) {
    const provider = owner.providers.find((candidate) => candidate.token.id === providerId);
    if (provider?.lifetime !== "singleton") continue;
    for (const dependencyId of providerEdges.get(providerId) ?? []) {
      const target = providerOwners
        .get(dependencyId)
        ?.providers.find((candidate) => candidate.token.id === dependencyId);
      if (target?.lifetime !== "operation") continue;
      diagnostics.push(
        diagnostic(
          "SHIP_PROVIDER_LIFETIME_INVALID",
          `singleton provider ${JSON.stringify(providerId)} cannot capture operation provider ${JSON.stringify(dependencyId)}`,
          "Use operation lifetime for the consuming provider or remove the scoped dependency.",
          { appId, moduleId: owner.id, providerId, path: "providers.dependencies" },
        ),
      );
    }
  }
  for (const cycle of findCycles(providerEdges)) {
    diagnostics.push(
      diagnostic(
        "SHIP_PROVIDER_DEPENDENCY_CYCLE",
        `provider dependency cycle: ${cycle.join(" -> ")}`,
        "Break the cycle by extracting a lower-level capability or inverting one dependency.",
        { appId, providerId: cycle[0], path: "providers.dependencies" },
      ),
    );
  }

  return Object.freeze(diagnostics.sort(compareDiagnostics));
}

function checkDependencies(
  appId: string,
  consumerModule: AnyModule,
  dependencies: DependencyBindings,
  providerOwners: ReadonlyMap<string, AnyModule>,
  modulesById: ReadonlyMap<string, AnyModule>,
  diagnostics: ApplicationDiagnostic[],
  subject: {
    readonly operationId?: string;
    readonly providerId?: string;
    readonly pathPrefix: string;
  },
): void {
  for (const [name, token] of Object.entries(dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (subject.providerId && isUnitOfWorkDependencyToken(token)) {
      diagnostics.push(
        diagnostic(
          "SHIP_PROVIDER_UNIT_OF_WORK_FORBIDDEN",
          `provider ${JSON.stringify(subject.providerId)} cannot depend on transaction-scoped capability ${JSON.stringify(token.id)}`,
          "Inject transaction-scoped capabilities directly into a transactional operation.",
          {
            appId,
            moduleId: consumerModule.id,
            providerId: subject.providerId,
            path: `${subject.pathPrefix}.${name}`,
          },
        ),
      );
    }
    // A per-job enqueuer resolves through the shared job backend provider.
    const providerId = isJobEnqueueDependencyToken(token) ? JOB_BACKEND_ID : token.id;
    const providerOwner = providerOwners.get(providerId);
    const context = {
      appId,
      moduleId: consumerModule.id,
      operationId: subject.operationId,
      providerId: subject.providerId,
      path: `${subject.pathPrefix}.${name}`,
    };

    if (!providerOwner) {
      diagnostics.push(
        diagnostic(
          "SHIP_PROVIDER_MISSING",
          `${describeSubject(subject)} depends on missing provider ${JSON.stringify(providerId)}`,
          `Add one provider for ${JSON.stringify(providerId)} to the application.`,
          context,
        ),
      );
      continue;
    }

    if (providerOwner.id === consumerModule.id) continue;

    if (!consumerModule.imports.includes(providerOwner.id)) {
      diagnostics.push(
        diagnostic(
          "SHIP_MODULE_IMPORT_REQUIRED",
          `${describeSubject(subject)} uses provider ${JSON.stringify(providerId)} from module ${JSON.stringify(providerOwner.id)} without importing it`,
          `Add ${JSON.stringify(providerOwner.id)} to ${JSON.stringify(consumerModule.id)} imports.`,
          context,
        ),
      );
      continue;
    }

    const declaredOwner = modulesById.get(providerOwner.id);
    if (!declaredOwner?.exports.some((exportedToken) => exportedToken.id === providerId)) {
      diagnostics.push(
        diagnostic(
          "SHIP_PROVIDER_NOT_EXPORTED",
          `${describeSubject(subject)} uses private provider ${JSON.stringify(providerId)} from module ${JSON.stringify(providerOwner.id)}`,
          `Export ${JSON.stringify(providerId)} from ${JSON.stringify(providerOwner.id)} or keep the dependency private.`,
          context,
        ),
      );
    }
  }
}

function checkOperationJobBindings(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  diagnostics: ApplicationDiagnostic[],
): void {
  const role = describeJobOperation(operation);
  if (role?.role !== "job") return;
  for (const [name, token] of Object.entries(operation.dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isJobDependencyToken(token) || token.role !== "backend") continue;
    diagnostics.push(
      diagnostic(
        "SHIP_JOB_BACKEND_BINDING_FORBIDDEN",
        `job ${JSON.stringify(operation.id)} binds the raw job backend ${JSON.stringify(token.id)}`,
        "Declare each job it starts with jobDependency(job) so job-to-job edges are visible in the graph.",
        {
          appId,
          moduleId: module.id,
          operationId: operation.id,
          providerId: token.id,
          path: `dependencies.${name}`,
        },
      ),
    );
  }
}

function checkJobs(
  appId: string,
  modules: readonly AnyModule[],
  providerOwners: ReadonlyMap<string, AnyModule>,
  diagnostics: ApplicationDiagnostic[],
): void {
  const jobs = new Map<string, { module: AnyModule; job: AnyJob }>();
  const triggers = new Set<string>();
  for (const module of modules) {
    for (const operation of [...module.operations].sort(compareBy((item) => item.id))) {
      if (isJob(operation)) {
        const previous = jobs.get(operation.id);
        if (previous && previous.job !== operation) {
          diagnostics.push(
            diagnostic(
              "SHIP_JOB_ID_DUPLICATE",
              `job id ${JSON.stringify(operation.id)} is declared by both ${JSON.stringify(previous.module.id)} and ${JSON.stringify(module.id)}`,
              "Give each job one globally unique id; schedules, locks and dead-letter records are keyed by it.",
              { appId, moduleId: module.id, operationId: operation.id, path: "operations" },
            ),
          );
        } else {
          jobs.set(operation.id, { module, job: operation });
        }
      }
      const role = describeJobOperation(operation);
      if (role?.role === "trigger") triggers.add(role.jobId);
    }
  }

  const lockBound = providerOwners.has(JOB_LOCK_PROVIDER_ID);
  for (const [jobId, { module, job }] of [...jobs].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const context = { appId, moduleId: module.id, operationId: jobId };
    if (job.job.concurrency.mode === "single-runner") {
      if (!lockBound) {
        diagnostics.push(
          diagnostic(
            "SHIP_JOB_LOCK_PROVIDER_MISSING",
            `single-runner job ${JSON.stringify(jobId)} has no lock provider bound`,
            `Bind a LockProvider to ${JSON.stringify(JOB_LOCK_PROVIDER_ID)} (for example advisoryLockProvider() or the adapter's Redis lock) so one runner per (jobId, key) is enforced across processes.`,
            { ...context, providerId: JOB_LOCK_PROVIDER_ID, path: "concurrency" },
          ),
        );
      }
      if (!job.job.concurrency.keyed) {
        diagnostics.push(
          diagnostic(
            "SHIP_JOB_SINGLE_RUNNER_UNKEYED",
            `single-runner job ${JSON.stringify(jobId)} runs on one global lock: ${job.job.concurrency.reason ?? ""}`.trimEnd(),
            "Prefer concurrency.key(input) (for example the tenant) so independent keys run concurrently; keep reason only when one global runner is intended.",
            { ...context, path: "concurrency.key", severity: "warning" },
          ),
        );
      }
    }
    if (job.job.trigger.kind === "http" && !triggers.has(jobId)) {
      diagnostics.push(
        diagnostic(
          "SHIP_JOB_HTTP_TRIGGER_UNBOUND",
          `job ${JSON.stringify(jobId)} declares an http trigger but no trigger operation is composed into the application`,
          "Add the operation from httpJobTrigger(job) (@sixthsummit/ship-hono) to a module or change the trigger kind.",
          { ...context, path: "trigger" },
        ),
      );
    }
  }

  for (const module of modules) {
    for (const operation of module.operations) {
      for (const [name, token] of Object.entries(operation.dependencies).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        if (!isJobEnqueueDependencyToken(token)) continue;
        if (jobs.get(token.job.id)?.job === token.job) continue;
        diagnostics.push(
          diagnostic(
            "SHIP_JOB_DEPENDENCY_MISSING",
            `operation ${JSON.stringify(operation.id)} enqueues job ${JSON.stringify(token.job.id)} that is not composed into the application`,
            `Add the ${JSON.stringify(token.job.id)} job to a module or remove the jobDependency() binding.`,
            {
              appId,
              moduleId: module.id,
              operationId: operation.id,
              path: `dependencies.${name}`,
            },
          ),
        );
      }
    }
  }
}

function checkOperationUnitOfWork(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  diagnostics: ApplicationDiagnostic[],
): void {
  const entries = Object.entries(operation.dependencies).filter(([, token]) =>
    isUnitOfWorkDependencyToken(token),
  );
  const context = {
    appId,
    moduleId: module.id,
    operationId: operation.id,
    path: "transaction",
  };

  if (operation.transaction === "none" && entries.length > 0) {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_UNIT_OF_WORK_FORBIDDEN",
        `non-transactional operation ${JSON.stringify(operation.id)} declares a unit-of-work dependency`,
        "Set transaction to read/write or replace the dependency with a non-transactional capability.",
        context,
      ),
    );
  } else if (operation.transaction !== "none" && entries.length === 0) {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_UNIT_OF_WORK_REQUIRED",
        `transactional operation ${JSON.stringify(operation.id)} has no unit-of-work dependency`,
        "Add exactly one unitOfWorkDependency() binding so the transaction declaration controls execution.",
        context,
      ),
    );
  } else if (entries.length > 1) {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_UNIT_OF_WORK_MULTIPLE",
        `operation ${JSON.stringify(operation.id)} declares multiple unit-of-work dependencies`,
        "Use exactly one atomic database boundary per operation.",
        context,
      ),
    );
  }
}

function checkOperationEffects(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  diagnostics: ApplicationDiagnostic[],
): void {
  const dependencyEffects = Object.entries(operation.dependencies).filter(
    ([, token]) => isEffectDependencyToken(token) && !isChannelPublicationToken(token),
  );
  const declaredIds = new Set(operation.effects.map((effect) => effect.id));
  const dependencyIds = new Set(dependencyEffects.map(([, effect]) => effect.id));

  for (const [name, effect] of dependencyEffects) {
    if (declaredIds.has(effect.id)) continue;
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_EFFECT_UNDECLARED",
        `operation ${JSON.stringify(operation.id)} uses external effect ${JSON.stringify(effect.id)} without declaring it`,
        `Add ${JSON.stringify(effect.id)} to the operation effects list.`,
        {
          appId,
          moduleId: module.id,
          operationId: operation.id,
          providerId: effect.id,
          path: `dependencies.${name}`,
        },
      ),
    );
  }
  for (const effect of operation.effects) {
    if (dependencyIds.has(effect.id)) continue;
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_EFFECT_UNBOUND",
        `operation ${JSON.stringify(operation.id)} declares external effect ${JSON.stringify(effect.id)} without a dependency binding`,
        "Bind the effect token directly in operation dependencies or remove the declaration.",
        {
          appId,
          moduleId: module.id,
          operationId: operation.id,
          providerId: effect.id,
          path: "effects",
        },
      ),
    );
  }
  if (operation.effects.length > 0 && operation.transaction !== "none") {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_EFFECT_TRANSACTION_FORBIDDEN",
        `transactional operation ${JSON.stringify(operation.id)} declares an immediate external effect`,
        "Persist an outbox command in the transaction and dispatch it from a separate non-transactional operation.",
        {
          appId,
          moduleId: module.id,
          operationId: operation.id,
          path: "effects",
        },
      ),
    );
  }
}

function checkOperationOutbox(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  diagnostics: ApplicationDiagnostic[],
): void {
  for (const [name, token] of Object.entries(operation.dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isOutboxDependencyToken(token) || token.role !== "writer") continue;
    if (operation.transaction === "write") continue;
    diagnostics.push(
      diagnostic(
        "SHIP_OUTBOX_WRITER_TRANSACTION_INVALID",
        `operation ${JSON.stringify(operation.id)} binds outbox writer ${JSON.stringify(token.id)} without a write transaction`,
        "Set transaction to write so enqueued intents commit or roll back with the business change.",
        {
          appId,
          moduleId: module.id,
          operationId: operation.id,
          providerId: token.id,
          path: `dependencies.${name}`,
        },
      ),
    );
  }
}

function checkOperationCache(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  diagnostics: ApplicationDiagnostic[],
): void {
  const context = { appId, moduleId: module.id, operationId: operation.id };
  if (operation.cache) {
    if (operation.transaction === "write") {
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_TRANSACTION_FORBIDDEN",
          `write operation ${JSON.stringify(operation.id)} declares a read cache`,
          "Declare cache only on transaction none or read operations; a write result is never replayed.",
          { ...context, path: "cache" },
        ),
      );
    }
    if (!Object.values(operation.dependencies).some(isCacheBackendDependencyToken)) {
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_BACKEND_UNBOUND",
          `operation ${JSON.stringify(operation.id)} declares a cache without binding a cache backend`,
          "Add a cacheBackendDependency() binding to the operation dependencies.",
          { ...context, path: "dependencies" },
        ),
      );
    }
    if (operation.cache.scope === "public" && operation.access.kind === "optional-identity") {
      // Optional identity exists to let a handler answer differently for an
      // anonymous and an identified caller; one shared entry would serve
      // whichever answer landed first to everyone.
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN",
          `operation ${JSON.stringify(operation.id)} caches one shared entry but its optional-identity access declares that its output varies by caller`,
          "Use scope actor for identified callers, or public access when the output is the same for everyone.",
          { ...context, path: "cache.scope" },
        ),
      );
    } else if (operation.cache.scope === "public" && operation.access.kind !== "public") {
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_PUBLIC_SCOPE_PROTECTED",
          `operation ${JSON.stringify(operation.id)} caches one shared entry behind ${operation.access.kind} access: every caller allowed in observes the same stored result`,
          "Confirm the handler output carries no per-caller dimension, or use scope actor or tenant. The HTTP projection stays Cache-Control: private.",
          { ...context, path: "cache.scope", severity: "warning" },
        ),
      );
    }
    if (operation.cache.scope === "public" && (operation.cache.vary?.length ?? 0) >= 2) {
      // Arity is the cheap signal: a vary that names the subject parameter
      // reads it. Keying a shared entry by the actor is actor scope in disguise.
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_VARY_SUBJECT_PUBLIC",
          `operation ${JSON.stringify(operation.id)} caches one shared entry but its vary(input, subject) reads the subject`,
          "A public read whose key depends on the actor is actor-scoped: declare scope actor, or derive vary from input alone.",
          { ...context, path: "cache.vary", severity: "warning" },
        ),
      );
    }
    if (
      operation.cache.scope === "actor" &&
      (operation.access.kind === "public" || operation.access.kind === "optional-identity")
    ) {
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_SCOPE_ACTOR_INVALID",
          `operation ${JSON.stringify(operation.id)} caches per actor but its access does not require one`,
          "Use scope public for anonymous reads, or require an authenticated actor.",
          { ...context, path: "cache.scope" },
        ),
      );
    }
  }
  if (
    operation.invalidates?.some((item) => item.scope === "actor") &&
    (operation.access.kind === "public" || operation.access.kind === "optional-identity")
  ) {
    diagnostics.push(
      diagnostic(
        "SHIP_CACHE_INVALIDATES_ACTOR_INVALID",
        `operation ${JSON.stringify(operation.id)} invalidates per actor but its access does not require one`,
        "Require an authenticated actor on the write, or use the plain tag form to purge every actor's entries.",
        { ...context, path: "invalidates" },
      ),
    );
  }
  if (
    operation.invalidates &&
    operation.invalidates.length > 0 &&
    operation.transaction !== "write"
  ) {
    diagnostics.push(
      diagnostic(
        "SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID",
        `operation ${JSON.stringify(operation.id)} declares invalidates without a write transaction`,
        "Set transaction to write so the purge intent commits or rolls back with the change it describes.",
        { ...context, path: "invalidates" },
      ),
    );
  }
}

function checkCacheTags(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: ApplicationDiagnostic[],
): void {
  const cachedTags = new Set<string>();
  /** `<scope>:<tag>` for every actor- or tenant-scoped read, the only readers a scoped purge reaches. */
  const scopedCachedTags = new Set<string>();
  const invalidators: { module: AnyModule; operation: AnyOperation }[] = [];
  let dispatched = false;
  for (const module of modules) {
    for (const operation of module.operations) {
      for (const tag of operation.cache?.tags ?? []) {
        cachedTags.add(tag);
        if (operation.cache?.scope !== "public") {
          scopedCachedTags.add(`${operation.cache?.scope}:${tag}`);
        }
      }
      if (operation.invalidates && operation.invalidates.length > 0) {
        invalidators.push({ module, operation });
      }
      const role = describeOutboxOperation(operation);
      if (
        role?.role === "dispatcher" &&
        role.outboxId === cacheInvalidationOutbox.id &&
        role.intentIds.length > 0
      ) {
        dispatched = true;
      }
    }
  }
  for (const site of invalidators) {
    if (!dispatched) {
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING",
          `operation ${JSON.stringify(site.operation.id)} invalidates cache tags but no cache-invalidation dispatcher is composed into the application`,
          "Mount defineCacheInvalidationModule() once so recorded purge intents are performed.",
          {
            appId,
            moduleId: site.module.id,
            operationId: site.operation.id,
            providerId: cacheInvalidationOutbox.id,
            path: "invalidates",
          },
        ),
      );
    }
    const invalidations = [...(site.operation.invalidates ?? [])].sort((left, right) =>
      left.tag.localeCompare(right.tag),
    );
    for (const invalidation of invalidations) {
      const tag = invalidation.tag;
      if (cachedTags.has(tag)) {
        if (
          invalidation.scope !== "global" &&
          !scopedCachedTags.has(`${invalidation.scope}:${tag}`)
        ) {
          diagnostics.push(
            diagnostic(
              "SHIP_CACHE_TAG_SCOPE_UNMATCHED",
              `operation ${JSON.stringify(site.operation.id)} invalidates tag ${JSON.stringify(tag)} per ${invalidation.scope} but no ${invalidation.scope}-scoped cached operation declares it`,
              `Only scope ${invalidation.scope} reads store ${invalidation.scope}-qualified tags; use the plain tag form to purge entries stored under another scope.`,
              {
                appId,
                moduleId: site.module.id,
                operationId: site.operation.id,
                path: "invalidates",
                severity: "warning",
              },
            ),
          );
        }
        continue;
      }
      diagnostics.push(
        diagnostic(
          "SHIP_CACHE_TAG_UNKNOWN",
          `operation ${JSON.stringify(site.operation.id)} invalidates tag ${JSON.stringify(tag)} that no cached operation declares`,
          "Tag the read that should be purged, or drop the tag from invalidates.",
          {
            appId,
            moduleId: site.module.id,
            operationId: site.operation.id,
            path: `invalidates.${tag}`,
            severity: "warning",
          },
        ),
      );
    }
  }
}

function checkOutboxCoverage(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: ApplicationDiagnostic[],
): void {
  const outboxes = new Map<string, AnyOutbox>();
  const writers = new Map<string, { module: AnyModule; operation: AnyOperation }[]>();
  const dispatched = new Map<string, Set<string>>();
  const capacity = declaredDispatchCapacity(modules);
  for (const module of modules) {
    for (const operation of module.operations) {
      for (const token of Object.values(operation.dependencies)) {
        if (!isOutboxDependencyToken(token)) continue;
        outboxes.set(token.outbox.id, token.outbox);
        if (token.role === "writer") {
          const list = writers.get(token.outbox.id) ?? [];
          list.push({ module, operation });
          writers.set(token.outbox.id, list);
        }
      }
      const role = describeOutboxOperation(operation);
      if (role?.role === "dispatcher") {
        const covered = dispatched.get(role.outboxId) ?? new Set<string>();
        for (const intentId of role.intentIds) covered.add(intentId);
        dispatched.set(role.outboxId, covered);
      }
    }
  }
  for (const [outboxId, sites] of [...writers].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const covered = dispatched.get(outboxId);
    const site = sites[0]!;
    if (!covered) {
      diagnostics.push(
        diagnostic(
          "SHIP_OUTBOX_DISPATCHER_MISSING",
          `outbox ${JSON.stringify(outboxId)} is written by ${JSON.stringify(site.operation.id)} but no dispatcher operation is composed into the application`,
          "Add the operations from defineOutboxDispatcher() to a module so enqueued intents are delivered.",
          { appId, moduleId: site.module.id, operationId: site.operation.id, providerId: outboxId },
        ),
      );
      continue;
    }
    const outbox = outboxes.get(outboxId)!;
    for (const intentId of Object.keys(outbox.intents).sort()) {
      if (covered.has(intentId)) continue;
      diagnostics.push(
        diagnostic(
          "SHIP_OUTBOX_INTENT_UNDISPATCHED",
          `outbox ${JSON.stringify(outboxId)} intent ${JSON.stringify(intentId)} is not handled by any dispatcher in the application`,
          "Include the intent in a dispatcher's intents list or add a dispatcher that covers it.",
          {
            appId,
            moduleId: site.module.id,
            operationId: site.operation.id,
            providerId: outboxId,
            path: `intents.${intentId}`,
          },
        ),
      );
    }
    const expectedRate = outbox.expectedRatePerSecond;
    const declaredCapacity = capacity.get(outboxId);
    if (
      expectedRate !== undefined &&
      declaredCapacity !== undefined &&
      declaredCapacity < expectedRate
    ) {
      diagnostics.push(
        diagnostic(
          "SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE",
          `outbox ${JSON.stringify(outboxId)} expects ${expectedRate} intents/s but its dispatchers declare ${declaredCapacity} records/s per process (batchSize x roundsPerSecond); the backlog grows without bound unless more processes run`,
          "Raise the dispatcher batchSize or roundsPerSecond (with startOutboxDispatchRunner, a full batch is followed by the next pass at once up to maxPassesPerCycle), run more dispatcher processes, or lower expectedRatePerSecond if the declared rate is stale.",
          {
            appId,
            moduleId: site.module.id,
            operationId: site.operation.id,
            providerId: outboxId,
            path: "expectedRatePerSecond",
            severity: "warning",
          },
        ),
      );
    }
  }
}

/**
 * `batchSize x roundsPerSecond` of each outbox's dispatcher, for dispatchers
 * that declare `roundsPerSecond`; the graph shows it and the compiler compares
 * it with `expectedRatePerSecond`. (An outbox has one dispatcher operation
 * id, so the sum is over the intent partitions of that dispatcher.)
 */
function declaredDispatchCapacity(modules: readonly AnyModule[]): Map<string, number> {
  const totals = new Map<string, number>();
  const undeclared = new Set<string>();
  for (const module of modules) {
    for (const operation of module.operations) {
      const role = describeOutboxOperation(operation);
      if (role?.role !== "dispatcher") continue;
      if (role.roundsPerSecond === undefined) {
        undeclared.add(role.outboxId);
        continue;
      }
      totals.set(
        role.outboxId,
        (totals.get(role.outboxId) ?? 0) + role.batchSize * role.roundsPerSecond,
      );
    }
  }
  for (const outboxId of undeclared) totals.delete(outboxId);
  return totals;
}

function checkOperationStream(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  diagnostics: ApplicationDiagnostic[],
): void {
  const response = operation.transport?.response;
  if (response?.mode !== "stream") return;
  const context = { appId, moduleId: module.id, operationId: operation.id };

  if (operation.transaction !== "none") {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_STREAM_TRANSACTION_FORBIDDEN",
        `streaming operation ${JSON.stringify(operation.id)} declares transaction ${JSON.stringify(operation.transaction)}`,
        'Streams outlive any bounded transaction; declare transaction "none" and open scoped work inside the handler.',
        { ...context, path: "transaction" },
      ),
    );
  }
  for (const limit of ["heartbeatMs", "maxDurationMs", "maxFrames"] as const) {
    if (response[limit] !== undefined) continue;
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_STREAM_LIMIT_MISSING",
        `streaming operation ${JSON.stringify(operation.id)} does not declare ${limit}`,
        `Declare a positive integer ${limit} so the adapter can bound the stream.`,
        { ...context, path: `transport.response.${limit}` },
      ),
    );
  }
  const statuses = Object.keys(operation.output);
  if (statuses.length !== 1 || statuses[0] !== "200" || operation.successStatus !== 200) {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_STREAM_OUTPUT_INVALID",
        `streaming operation ${JSON.stringify(operation.id)} must declare exactly one 200 output for its terminal value`,
        "Declare output { 200: terminalSchema } with successStatus 200; frames use transport.response.frame.",
        { ...context, path: "output" },
      ),
    );
  }
  if (Reflect.get(operation, "idempotency") !== undefined) {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_STREAM_IDEMPOTENCY_FORBIDDEN",
        `streaming operation ${JSON.stringify(operation.id)} declares an idempotency policy`,
        "Streams cannot replay a stored response; remove the idempotency declaration.",
        { ...context, path: "idempotency" },
      ),
    );
  }
  if (operation.cache !== undefined) {
    diagnostics.push(
      diagnostic(
        "SHIP_OPERATION_STREAM_CACHE_FORBIDDEN",
        `streaming operation ${JSON.stringify(operation.id)} declares a read cache`,
        "Streams bypass the read cache: frames are never stored or replayed. Remove the cache declaration.",
        { ...context, path: "cache" },
      ),
    );
  }
}

function describeSubject(subject: {
  readonly operationId?: string;
  readonly providerId?: string;
}): string {
  return subject.operationId
    ? `operation ${JSON.stringify(subject.operationId)}`
    : `provider ${JSON.stringify(subject.providerId)}`;
}

function projectGraph(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: readonly ApplicationDiagnostic[] = [],
): ApplicationGraph {
  const moduleNodes: ModuleGraphNode[] = [];
  const operationNodes: OperationGraphNode[] = [];
  const providerNodes: ProviderGraphNode[] = [];

  for (const module of [...modules].sort(compareBy((item) => item.id))) {
    moduleNodes.push(
      Object.freeze({
        id: module.id,
        imports: Object.freeze([...module.imports].sort()),
        operations: Object.freeze(module.operations.map((item) => item.id).sort()),
        providers: Object.freeze(module.providers.map((item) => item.token.id).sort()),
        exports: Object.freeze(module.exports.map((item) => item.id).sort()),
        channels: Object.freeze(module.channels.map((item) => item.id).sort()),
        attachments: Object.freeze(module.attachments.map((item) => item.id).sort()),
      }),
    );

    for (const operation of module.operations) {
      operationNodes.push(projectOperation(module.id, operation));
    }
    for (const provider of module.providers) {
      providerNodes.push(projectProvider(module.id, provider));
    }
  }

  operationNodes.sort(compareBy((item) => item.id));
  providerNodes.sort(compareBy((item) => item.id));

  return Object.freeze({
    schemaVersion: 1 as const,
    appId,
    modules: Object.freeze(moduleNodes),
    operations: Object.freeze(operationNodes),
    providers: Object.freeze(providerNodes),
    outboxes: projectOutboxes(modules),
    ...(diagnostics.length > 0 ? { diagnostics: Object.freeze([...diagnostics]) } : {}),
    channels: projectChannels(modules),
    jobs: projectJobs(modules),
    attachments: projectAttachments(modules),
  });
}

function projectJobs(modules: readonly AnyModule[]): readonly JobGraphNode[] {
  const jobs: { module: AnyModule; job: AnyJob }[] = [];
  const triggers = new Map<string, string[]>();
  const enqueuedBy = new Map<string, string[]>();
  for (const module of modules) {
    for (const operation of module.operations) {
      if (isJob(operation)) jobs.push({ module, job: operation });
      const role = describeJobOperation(operation);
      if (role?.role === "trigger") {
        triggers.set(role.jobId, [...(triggers.get(role.jobId) ?? []), operation.id]);
      }
      for (const token of Object.values(operation.dependencies)) {
        if (!isJobEnqueueDependencyToken(token)) continue;
        enqueuedBy.set(token.job.id, [...(enqueuedBy.get(token.job.id) ?? []), operation.id]);
      }
    }
  }
  return Object.freeze(
    jobs
      .sort((left, right) => left.job.id.localeCompare(right.job.id))
      .map(({ module, job }) =>
        Object.freeze({
          id: job.id,
          moduleId: module.id,
          trigger: projectTrigger(job.job.trigger),
          concurrency: Object.freeze({ ...job.job.concurrency }),
          retry: Object.freeze({
            attempts: job.job.retry.attempts,
            backoff: Object.freeze({ ...job.job.retry.backoff }),
          }),
          ...(job.job.retention ? { retention: Object.freeze({ ...job.job.retention }) } : {}),
          transaction: job.job.transaction,
          effects: Object.freeze(job.effects.map((effect) => effect.id).sort()),
          enqueues: Object.freeze(
            Object.values(job.dependencies)
              .filter(isJobEnqueueDependencyToken)
              .map((token) => token.job.id)
              .sort(),
          ),
          operations: Object.freeze({
            triggers: Object.freeze([...new Set(triggers.get(job.id) ?? [])].sort()),
            enqueuedBy: Object.freeze([...new Set(enqueuedBy.get(job.id) ?? [])].sort()),
          }),
        }),
      ),
  );
}

function projectTrigger(trigger: JobTrigger): JobTrigger {
  if (trigger.kind === "http") {
    return Object.freeze({
      kind: "http",
      access: projectAccess(trigger.access) as OperationAccess,
    });
  }
  return Object.freeze({ ...trigger });
}

function projectOperationJob(operation: AnyOperation): readonly OperationJobGraphNode[] {
  const nodes: OperationJobGraphNode[] = [];
  const role = describeJobOperation(operation);
  if (role?.role === "management") {
    nodes.push(Object.freeze({ role: "management", action: role.action }));
  } else if (role) {
    nodes.push(Object.freeze({ role: role.role, jobId: role.jobId }));
  }
  for (const token of Object.values(operation.dependencies)) {
    if (!isJobDependencyToken(token)) continue;
    if (token.role === "enqueue") {
      nodes.push(Object.freeze({ role: "enqueue", jobId: token.id }));
    } else if (!(role && (role.role === "cleanup" || role.role === "management"))) {
      nodes.push(Object.freeze({ role: token.role }));
    }
  }
  return Object.freeze(
    nodes.sort(
      (left, right) =>
        left.role.localeCompare(right.role) || (left.jobId ?? "").localeCompare(right.jobId ?? ""),
    ),
  );
}

function projectOutboxes(modules: readonly AnyModule[]): readonly OutboxGraphNode[] {
  const outboxes = new Map<string, AnyOutbox>();
  const operations = new Map<
    string,
    { writers: string[]; dispatchers: string[]; cleanups: string[]; management: string[] }
  >();
  const usage = (outboxId: string) => {
    const existing = operations.get(outboxId);
    if (existing) return existing;
    const created = { writers: [], dispatchers: [], cleanups: [], management: [] };
    operations.set(outboxId, created);
    return created;
  };
  const capacity = declaredDispatchCapacity(modules);
  for (const module of modules) {
    for (const provider of module.providers) {
      if (isOutboxDependencyToken(provider.token)) {
        outboxes.set(provider.token.outbox.id, provider.token.outbox);
      }
    }
    for (const operation of module.operations) {
      for (const node of projectOperationOutbox(operation)) {
        const outbox = Object.values(operation.dependencies).find(
          (token): token is DependencyToken & { readonly outbox: AnyOutbox } =>
            isOutboxDependencyToken(token) && token.outbox.id === node.id,
        )?.outbox;
        if (outbox) outboxes.set(outbox.id, outbox);
        const bucket = usage(node.id);
        if (node.role === "writer") bucket.writers.push(operation.id);
        else if (node.role === "dispatcher") bucket.dispatchers.push(operation.id);
        else if (node.role === "cleanup") bucket.cleanups.push(operation.id);
        else if (node.role === "management") bucket.management.push(operation.id);
      }
    }
  }
  return Object.freeze(
    [...outboxes.values()].sort(compareBy((item) => item.id)).map((outbox) => {
      const bucket = usage(outbox.id);
      return Object.freeze({
        id: outbox.id,
        providerId: outbox.id,
        intents: Object.freeze(
          Object.entries(outbox.intents)
            .map(([id, intent]) =>
              Object.freeze({
                id,
                effectId: intent.effect.id,
                payloadVendor: intent.payload["~standard"].vendor,
              }),
            )
            .sort(compareBy((item) => item.id)),
        ),
        ...(outbox.retention
          ? {
              retention: Object.freeze({
                completedMs: outbox.retention.completedMs,
                deadLetteredMs: outbox.retention.deadLetteredMs,
              }),
            }
          : {}),
        ...(outbox.expectedRatePerSecond !== undefined
          ? { expectedRatePerSecond: outbox.expectedRatePerSecond }
          : {}),
        ...(capacity.has(outbox.id) ? { dispatchCapacityPerSecond: capacity.get(outbox.id) } : {}),
        operations: Object.freeze({
          writers: Object.freeze([...new Set(bucket.writers)].sort()),
          dispatchers: Object.freeze([...new Set(bucket.dispatchers)].sort()),
          cleanups: Object.freeze([...new Set(bucket.cleanups)].sort()),
          management: Object.freeze([...new Set(bucket.management)].sort()),
        }),
      });
    }),
  );
}

function projectOperationOutbox(operation: AnyOperation): readonly OperationOutboxGraphNode[] {
  const role = describeOutboxOperation(operation);
  const jobRole = describeJobOperation(operation);
  const nodes: OperationOutboxGraphNode[] = [];
  if (role?.role === "dispatcher") {
    nodes.push(Object.freeze({ id: role.outboxId, role: "dispatcher", intents: role.intentIds }));
  } else if (role) {
    nodes.push(Object.freeze({ id: role.outboxId, role: role.role }));
  }
  // A declared cleanup job sweeps its outboxes through their backend tokens;
  // it is the outbox's cleanup, not a raw backend consumer.
  const sweptOutboxIds = new Set(jobRole?.role === "cleanup" ? jobRole.outboxIds : []);
  for (const outboxId of sweptOutboxIds) {
    nodes.push(Object.freeze({ id: outboxId, role: "cleanup" }));
  }
  for (const token of Object.values(operation.dependencies)) {
    if (!isOutboxDependencyToken(token)) continue;
    if (role && role.outboxId === token.outbox.id && token.role === "backend") continue;
    if (sweptOutboxIds.has(token.outbox.id) && token.role === "backend") continue;
    nodes.push(Object.freeze({ id: token.outbox.id, role: token.role }));
  }
  return Object.freeze(
    nodes.sort(
      (left, right) => left.id.localeCompare(right.id) || left.role.localeCompare(right.role),
    ),
  );
}

function projectOperation(moduleId: string, operation: AnyOperation): OperationGraphNode {
  const outbox = projectOperationOutbox(operation);
  const job = projectOperationJob(operation);
  const transport = operation.transport
    ? Object.freeze({
        kind: operation.transport.kind,
        ...(operation.transport.binding ? { binding: operation.transport.binding } : {}),
        ...(operation.transport.metadata
          ? {
              metadata: projectTransportMetadata(operation.transport.metadata),
            }
          : {}),
        ...(operation.transport.response
          ? { response: projectStreamResponse(operation.transport.response) }
          : {}),
      })
    : undefined;

  return Object.freeze({
    id: operation.id,
    moduleId,
    input: Object.freeze(
      Object.entries(operation.input)
        .map(([name, schema]) => Object.freeze({ name, vendor: schema["~standard"].vendor }))
        .sort(compareBy((item) => item.name)),
    ),
    output: Object.freeze(
      Object.entries(operation.output)
        .map(([status, schema]) =>
          Object.freeze({ status: Number(status), vendor: schema["~standard"].vendor }),
        )
        .sort((left, right) => left.status - right.status),
    ),
    successStatus: operation.successStatus,
    errors: Object.freeze(
      operation.errors
        .map((error) =>
          Object.freeze({
            code: error.code,
            status: error.status,
            message: error.message,
            ...(error.details ? { detailsVendor: error.details["~standard"].vendor } : {}),
          }),
        )
        .sort(compareBy((error) => error.code)),
    ),
    access: projectAccess(operation.access),
    transaction: operation.transaction,
    dependencies: projectDependencies(operation.dependencies),
    effects: Object.freeze(
      operation.effects
        .map((effect) => Object.freeze({ id: effect.id, delivery: effect.delivery }))
        .sort(compareBy((effect) => effect.id)),
    ),
    ...(transport ? { transport } : {}),
    ...(outbox.length > 0 ? { outbox } : {}),
    ...(job.length > 0 ? { job } : {}),
    ...(operation.idempotency
      ? {
          idempotency: Object.freeze({
            windowMs: operation.idempotency.windowMs,
            storeId: operation.idempotency.store.id,
          }),
        }
      : {}),
    publishes: Object.freeze(operation.publishes.map((channel) => channel.id).sort()),
    ...(operation.publishes.length > 0
      ? { publicationDelivery: publicationDelivery(operation) }
      : {}),
    ...(operation.attachments.length > 0
      ? {
          attachments: Object.freeze(
            operation.attachments.map((attachment) => attachment.id).sort(),
          ),
        }
      : {}),
    ...(operation.cache ? { cache: projectOperationCache(operation) } : {}),
    ...(operation.invalidates && operation.invalidates.length > 0
      ? {
          invalidates: Object.freeze(operation.invalidates.map((item) => item.tag).sort()),
          ...(operation.invalidates.some((item) => item.scope !== "global")
            ? {
                invalidatesScoped: Object.freeze(
                  operation.invalidates
                    .filter((item) => item.scope !== "global")
                    .map((item) =>
                      Object.freeze({ tag: item.tag, scope: item.scope as "actor" | "tenant" }),
                    )
                    .sort((left, right) => left.tag.localeCompare(right.tag)),
                ),
              }
            : {}),
        }
      : {}),
  });
}

function projectOperationCache(operation: AnyOperation): OperationCacheGraphNode {
  const cache = operation.cache as NonNullable<AnyOperation["cache"]>;
  const backend = Object.values(operation.dependencies).find(isCacheBackendDependencyToken);
  return Object.freeze({
    ttlMs: cache.ttlMs,
    scope: cache.scope,
    tags: Object.freeze([...(cache.tags ?? [])].sort()),
    varies: typeof cache.vary === "function",
    backendId: backend?.id ?? "",
    cacheControl: cacheControlHeader(cache, operation.access),
  });
}

function projectProvider(moduleId: string, provider: AnyProvider): ProviderGraphNode {
  return Object.freeze({
    id: provider.token.id,
    moduleId,
    lifetime: provider.lifetime,
    dependencies: projectDependencies(provider.dependencies),
    ...(isUnitOfWorkDependencyToken(provider.token)
      ? { scope: "unit-of-work" as const }
      : isEffectDependencyToken(provider.token)
        ? { scope: "effect" as const, delivery: provider.token.delivery }
        : provider.token.scope === "outbox" ||
            provider.token.scope === "idempotency" ||
            provider.token.scope === "cache" ||
            provider.token.scope === "job" ||
            provider.token.scope === "attachment"
          ? { scope: provider.token.scope }
          : {}),
  });
}

function projectDependencies(dependencies: DependencyBindings): readonly DependencyGraphNode[] {
  return Object.freeze(
    Object.entries(dependencies)
      .map(([name, token]) =>
        Object.freeze({
          name,
          providerId: token.id,
          ...(isUnitOfWorkDependencyToken(token)
            ? { scope: "unit-of-work" as const }
            : isEffectDependencyToken(token)
              ? { scope: "effect" as const }
              : token.scope === "outbox"
                ? { scope: "outbox" as const, role: token.role }
                : token.scope === "idempotency"
                  ? { scope: "idempotency" as const }
                  : token.scope === "cache"
                    ? { scope: "cache" as const }
                    : token.scope === "job"
                      ? {
                          scope: "job" as const,
                          role: token.role,
                          ...(isJobEnqueueDependencyToken(token) ? { jobId: token.job.id } : {}),
                        }
                      : token.scope === "attachment"
                        ? { scope: "attachment" as const }
                        : {}),
        }),
      )
      .sort(compareBy((item) => item.name)),
  );
}

function projectAccess(access: OperationAccess): AccessGraphNode {
  if (access.kind === "provider") {
    return Object.freeze({ kind: access.kind, provider: access.provider });
  }
  if (access.kind !== "permissions") return Object.freeze({ kind: access.kind });
  return Object.freeze({
    kind: access.kind,
    mode: access.mode,
    permissions: Object.freeze([...access.permissions].sort()),
  });
}

function projectStreamResponse(response: OperationStreamResponse): StreamResponseGraphNode {
  return Object.freeze({
    mode: "stream" as const,
    framing: response.framing,
    frame: Object.freeze({ vendor: response.frame["~standard"].vendor }),
    heartbeatMs: response.heartbeatMs as number,
    maxDurationMs: response.maxDurationMs as number,
    maxFrames: response.maxFrames as number,
  });
}

function projectTransportMetadata(
  metadata: OperationTransportMetadata,
): OperationTransportMetadata {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(metadata)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, projectTransportMetadataValue(value)]),
    ),
  );
}

function projectTransportMetadataValue(
  value: OperationTransportMetadata[string],
): OperationTransportMetadata[string] {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => projectTransportMetadataValue(item)));
  }
  if (typeof value === "object" && value !== null) {
    return projectTransportMetadata(value as OperationTransportMetadata);
  }
  return value;
}

function findCycles(edges: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles = new Map<string, readonly string[]>();

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);

    for (const adjacent of [...(edges.get(node) ?? [])].sort()) {
      if (state.get(adjacent) === "visiting") {
        const start = stack.indexOf(adjacent);
        const cycle = normalizeCycle([...stack.slice(start), adjacent]);
        cycles.set(cycle.join(" -> "), cycle);
      } else if (!state.has(adjacent)) {
        visit(adjacent);
      }
    }

    stack.pop();
    state.set(node, "visited");
  };

  for (const node of [...edges.keys()].sort()) {
    if (!state.has(node)) visit(node);
  }

  return Object.freeze(
    [...cycles.values()].sort((left, right) => left.join().localeCompare(right.join())),
  );
}

function normalizeCycle(cycle: readonly string[]): readonly string[] {
  const nodes = cycle.slice(0, -1);
  const smallest = nodes.reduce(
    (best, node, index) => (node.localeCompare(nodes[best]) < 0 ? index : best),
    0,
  );
  const rotated = [...nodes.slice(smallest), ...nodes.slice(0, smallest)];
  return Object.freeze([...rotated, rotated[0]]);
}

function diagnostic(
  code: ApplicationDiagnosticCode,
  message: string,
  hint: string,
  context: Omit<ApplicationDiagnostic, "code" | "severity" | "message" | "hint"> & {
    readonly severity?: ApplicationDiagnosticSeverity;
  } = {},
): ApplicationDiagnostic {
  return { code, severity: "error", message, hint, ...context };
}

function compareDiagnostics(left: ApplicationDiagnostic, right: ApplicationDiagnostic): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.moduleId ?? "").localeCompare(right.moduleId ?? "") ||
    (left.operationId ?? "").localeCompare(right.operationId ?? "") ||
    (left.providerId ?? "").localeCompare(right.providerId ?? "") ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function compareBy<TValue>(
  select: (value: TValue) => string,
): (left: TValue, right: TValue) => number {
  return (left, right) => select(left).localeCompare(select(right));
}
