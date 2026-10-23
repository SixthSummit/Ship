import {
  type AnyAttachment,
  type AnyProvider,
  type AttachmentLedger,
  attachmentAcceptsContentType,
  authenticatedAccess,
  type CacheBackend,
  createJobEnqueuer,
  type DependencyToken,
  defineJob,
  defineModule,
  defineOperation,
  defineOutboxCleanup,
  defineOutboxDispatcher,
  integerSchema,
  isAttachment,
  isAttachmentLedger,
  isStorageAdapter,
  type JobBackend,
  type JobIntervalTrigger,
  type JobScheduleTrigger,
  type OperationAccess,
  type OperationTransport,
  type OutboxBackend,
  type OutboxBackoff,
  type OutboxRetention,
  objectSchema,
  operationError,
  operationFailure,
  optionalSchema,
  recordSchema,
  STORAGE_MODULE_ID,
  type StorageAdapter,
  stringSchema,
  valueProvider,
} from "@sixthsummit/ship-core";
import { createAttachmentCapability } from "./capability.js";
import { type ImageProcessor, isImageProcessor, variantExtension } from "./image.js";
import {
  createStoragePurger,
  DEFAULT_PURGE_RETENTION,
  defineStoragePurgeOutbox,
  STORAGE_COMPLETE_OPERATION_ID,
  STORAGE_CREATE_INTENT_OPERATION_ID,
  STORAGE_SWEEP_JOB_ID,
  STORAGE_VARIANT_JOB_ID,
  storageAdapterEffect,
  storageImageProcessorEffect,
  storageLedgerDependency,
  storagePurgeEffect,
} from "./tokens.js";

export type StorageModuleErrorCode = "SHIP_STORAGE_MODULE_OPTIONS_INVALID";

export class StorageModuleError extends TypeError {
  readonly code: StorageModuleErrorCode;

  constructor(code: StorageModuleErrorCode, message: string) {
    super(message);
    this.name = "StorageModuleError";
    this.code = code;
  }
}

export interface StorageModuleTransports<
  TCreateIntent extends OperationTransport | undefined = OperationTransport | undefined,
  TComplete extends OperationTransport | undefined = OperationTransport | undefined,
> {
  /** Transport for `ship-storage.create-intent`; `storageHttpTransports()` from `./hono` builds the HTTP one. */
  readonly createIntent?: TCreateIntent;
  /** Transport for `ship-storage.complete`; its path must carry an `intentId` parameter. */
  readonly complete?: TComplete;
}

export interface StorageSweepOptions {
  /** Defaults to every five minutes. */
  readonly trigger?: JobScheduleTrigger | JobIntervalTrigger;
  /** Rows claimed per pass; defaults to 100. */
  readonly batchSize?: number;
  /** How long a completed upload may stay unattached before the sweep purges it; defaults to 24 hours. */
  readonly unattachedGraceMs?: number;
}

export interface StorageVariantOptions {
  readonly processor: ImageProcessor;
  /** The job backend `ship-storage.generate-variant` is enqueued through. */
  readonly jobs: JobBackend;
  /** Remembers rendered variants so hot reads skip the ledger. */
  readonly cache?: CacheBackend;
  /** Defaults to one hour. */
  readonly cacheTtlMs?: number;
  /** Per-process concurrent renders; defaults to 2. */
  readonly concurrency?: number;
}

export interface StoragePurgeDispatcherOptions {
  readonly batchSize?: number;
  readonly lease?: { readonly ms: number };
  readonly retry?: { readonly attempts: number; readonly backoff: OutboxBackoff };
  readonly roundsPerSecond?: number;
}

export interface StorageModuleOptions<
  TCreateIntent extends OperationTransport | undefined = OperationTransport | undefined,
  TComplete extends OperationTransport | undefined = OperationTransport | undefined,
> {
  /** Every attachment the application declares, each owned by its own module. */
  readonly attachments: readonly AnyAttachment[];
  readonly adapter: StorageAdapter;
  readonly ledger: AttachmentLedger;
  /** Durable storage for purge intents; must join the consumer's write transaction. */
  readonly outbox: OutboxBackend;
  /** Access policy of the intent and completion operations; defaults to `authenticatedAccess()`. */
  readonly access?: OperationAccess;
  /** Typed so the client contract sees the mounted HTTP operations. */
  readonly transports?: StorageModuleTransports<TCreateIntent, TComplete>;
  readonly sweep?: StorageSweepOptions;
  /** Required when any attachment declares variants. */
  readonly variants?: StorageVariantOptions;
  readonly purge?: StoragePurgeDispatcherOptions;
  readonly retention?: OutboxRetention;
  /** Prepended to every object key, for example `tenant-a/`. */
  readonly keyPrefix?: string;
  /** Lifetime of signed download URLs; defaults to 15 minutes. */
  readonly signedUrlTtlMs?: number;
  /** Module ids this module imports, for example the module exporting the job backend. */
  readonly imports?: readonly string[];
  readonly clock?: () => Date;
  readonly randomUUID?: () => string;
}

const DEFAULT_SWEEP_TRIGGER: JobIntervalTrigger = Object.freeze({
  kind: "interval",
  everyMs: 5 * 60 * 1000,
});
const DEFAULT_SWEEP_BATCH = 100;
const DEFAULT_UNATTACHED_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VARIANT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_DISPATCH_BATCH = 100;
const DEFAULT_DISPATCH_LEASE_MS = 30_000;
const DEFAULT_DISPATCH_RETRY = Object.freeze({
  attempts: 8,
  backoff: Object.freeze({ initialMs: 1_000, multiplier: 4, maxMs: 15 * 60_000 }),
});

export const createIntentBodySchema = objectSchema({
  attachment: stringSchema({ minLength: 1 }),
  contentType: stringSchema({ minLength: 1 }),
  size: integerSchema({ minimum: 1 }),
  filename: optionalSchema(stringSchema({ minLength: 1 })),
});

export const createIntentOutputSchema = objectSchema({
  intentId: stringSchema({ minLength: 1 }),
  objectKey: stringSchema({ minLength: 1 }),
  upload: objectSchema({
    url: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    headers: recordSchema(stringSchema()),
  }),
  expiresAt: stringSchema({ minLength: 1 }),
});

export const completeParamsSchema = objectSchema({ intentId: stringSchema({ minLength: 1 }) });

export const completeOutputSchema = objectSchema({
  objectId: stringSchema({ minLength: 1 }),
  objectKey: stringSchema({ minLength: 1 }),
  contentType: stringSchema({ minLength: 1 }),
  size: integerSchema({ minimum: 0 }),
});

const sweepInputSchema = objectSchema({});
const variantInputSchema = objectSchema({
  objectId: stringSchema({ minLength: 1 }),
  variant: stringSchema({ minLength: 1 }),
});

export const attachmentUnknown = operationError({
  code: "ATTACHMENT_UNKNOWN",
  status: 404,
  message: "No attachment with that id is declared",
});
export const attachmentContentTypeRejected = operationError({
  code: "ATTACHMENT_CONTENT_TYPE_REJECTED",
  status: 415,
  message: "The attachment does not accept that content type",
});
export const attachmentTooLarge = operationError({
  code: "ATTACHMENT_TOO_LARGE",
  status: 413,
  message: "The declared size exceeds the attachment limit",
});
export const intentNotFound = operationError({
  code: "INTENT_NOT_FOUND",
  status: 404,
  message: "No upload intent with that id exists",
});
export const intentForbidden = operationError({
  code: "INTENT_FORBIDDEN",
  status: 403,
  message: "The upload intent belongs to another actor",
});
export const intentExpired = operationError({
  code: "INTENT_EXPIRED",
  status: 410,
  message: "The upload intent expired or was already settled",
});
export const uploadMissing = operationError({
  code: "UPLOAD_MISSING",
  status: 409,
  message: "The provider has no object for the intent; upload it before completing",
});
export const uploadRejected = operationError({
  code: "UPLOAD_REJECTED",
  status: 422,
  message: "The uploaded object does not match the intent and was removed",
});

/**
 * The module a consumer mounts once. It owns the attachment capabilities
 * (bound to each `attachment.binding` and exported), the signed-intent and
 * completion operations, the sweep job, the durable purge outbox with its
 * dispatcher, dead-letter and cleanup operations, and, when configured, the
 * variant job. Every module that declares or binds an attachment imports
 * `ship-storage`.
 *
 * Mounting it introduces the framework permission `ship.outbox:manage` for
 * the purge dead-letter operations. The sweep is a single-runner job, so the
 * application must bind a `LockProvider` and a `JobBackend` as it does for
 * any declared job.
 */
export function defineStorageModule<
  const TCreateIntent extends OperationTransport | undefined = undefined,
  const TComplete extends OperationTransport | undefined = undefined,
>(options: StorageModuleOptions<TCreateIntent, TComplete>) {
  assertOptions(options);
  const clock = options.clock ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const access = options.access ?? authenticatedAccess();
  const keyPrefix = options.keyPrefix ?? "";
  const attachmentsById = new Map(
    options.attachments.map((attachment) => [attachment.id, attachment] as const),
  );
  const purgeOutbox = defineStoragePurgeOutbox(options.retention ?? DEFAULT_PURGE_RETENTION);
  const purger = createStoragePurger({ adapter: options.adapter, ledger: options.ledger, clock });

  const generateVariant = defineJob({
    id: STORAGE_VARIANT_JOB_ID,
    input: variantInputSchema,
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel", max: options.variants?.concurrency ?? 2 },
    retry: { attempts: 3, backoff: { initialMs: 1_000, multiplier: 4, maxMs: 60_000 } },
    retention: { completedMs: 60 * 60 * 1000, deadLetteredMs: 7 * 24 * 60 * 60 * 1000 },
    transaction: "none",
    dependencies: {
      adapter: storageAdapterEffect,
      processor: storageImageProcessorEffect,
      ledger: storageLedgerDependency,
    },
    effects: [storageAdapterEffect, storageImageProcessorEffect],
    handler: async ({ input, services }) => {
      const object = await services.ledger.readObject(undefined, input.objectId);
      if (!object || (object.status !== "uploaded" && object.status !== "attached")) {
        return { rendered: false, reason: "object-unavailable" };
      }
      const attachment = attachmentsById.get(object.attachmentId);
      const variant = attachment?.variants[input.variant];
      if (!attachment || !variant) return { rendered: false, reason: "variant-unknown" };
      if (object.variants[input.variant]) return { rendered: false, reason: "already-rendered" };
      const original = await services.adapter.get(object.key);
      if (!original) return { rendered: false, reason: "original-missing" };
      const result = await services.processor.transform(original.body, variant, {
        contentType: object.contentType,
      });
      const key = `${object.key}/variants/${input.variant}.${variantExtension(result.contentType)}`;
      const stored = await services.adapter.put(key, result.bytes, {
        contentType: result.contentType,
        ...(attachment.visibility === "public" ? { cacheControl: "public, max-age=31536000" } : {}),
      });
      await services.ledger.recordVariant(object.id, input.variant, {
        key,
        contentType: result.contentType,
        size: stored.size,
      });
      await options.variants?.cache?.set(
        `ship-storage.variant:${attachment.id}:${object.id}:${input.variant}`,
        { key, contentType: result.contentType, size: stored.size },
        { ttlMs: options.variants.cacheTtlMs ?? DEFAULT_VARIANT_CACHE_TTL_MS },
      );
      return { rendered: true, key };
    },
  });

  const variantRuntime = options.variants
    ? {
        enqueue: createJobEnqueuer<typeof variantInputSchema>(
          generateVariant,
          options.variants.jobs,
        ).enqueue,
        ...(options.variants.cache ? { cache: options.variants.cache } : {}),
        cacheTtlMs: options.variants.cacheTtlMs ?? DEFAULT_VARIANT_CACHE_TTL_MS,
      }
    : undefined;

  const createIntent = defineOperation({
    id: STORAGE_CREATE_INTENT_OPERATION_ID,
    transport: options.transports?.createIntent as TCreateIntent,
    input: { body: createIntentBodySchema },
    output: { 201: createIntentOutputSchema },
    successStatus: 201,
    errors: [attachmentUnknown, attachmentContentTypeRejected, attachmentTooLarge],
    access,
    transaction: "none",
    dependencies: { adapter: storageAdapterEffect, ledger: storageLedgerDependency },
    effects: [storageAdapterEffect],
    handler: async ({ input, services, context }) => {
      const attachment = attachmentsById.get(input.body.attachment);
      if (!attachment) throw operationFailure(attachmentUnknown);
      if (!attachmentAcceptsContentType(attachment, input.body.contentType)) {
        throw operationFailure(attachmentContentTypeRejected);
      }
      if (input.body.size > attachment.maxBytes) throw operationFailure(attachmentTooLarge);
      const now = clock();
      const intentId = randomUUID();
      const key = `${keyPrefix}${attachment.id}/${intentId}`;
      const expiresAt = new Date(now.getTime() + attachment.intentTtlMs);
      const contentType = input.body.contentType.toLowerCase().split(";")[0]!.trim();
      const signed = await services.adapter.signUpload({
        key,
        contentType,
        size: input.body.size,
        expiresAt,
      });
      const intent = await services.ledger.createIntent({
        id: intentId,
        attachmentId: attachment.id,
        key,
        contentType,
        size: input.body.size,
        actorId: context.actor?.id ?? "anonymous",
        createdAt: now,
        expiresAt,
      });
      return {
        intentId: intent.id,
        objectKey: intent.key,
        upload: { url: signed.url, method: signed.method, headers: signed.headers },
        expiresAt: intent.expiresAt.toISOString(),
      };
    },
  });

  const complete = defineOperation({
    id: STORAGE_COMPLETE_OPERATION_ID,
    transport: options.transports?.complete as TComplete,
    input: { params: completeParamsSchema },
    output: { 200: completeOutputSchema },
    successStatus: 200,
    errors: [intentNotFound, intentForbidden, intentExpired, uploadMissing, uploadRejected],
    access,
    transaction: "none",
    dependencies: { adapter: storageAdapterEffect, ledger: storageLedgerDependency },
    effects: [storageAdapterEffect],
    handler: async ({ input, services, context }) => {
      const intent = await services.ledger.readIntent(input.params.intentId);
      if (!intent) throw operationFailure(intentNotFound);
      if (intent.actorId !== (context.actor?.id ?? "anonymous")) {
        throw operationFailure(intentForbidden);
      }
      const now = clock();
      if (intent.status !== "pending" || intent.expiresAt.getTime() <= now.getTime()) {
        // A late completion: the sweep may already have abandoned the intent
        // and the client may still have PUT the bytes. Remove them so an
        // abandoned intent never leaves an orphan behind.
        await services.adapter.delete(intent.key);
        throw operationFailure(intentExpired);
      }
      const attachment = attachmentsById.get(intent.attachmentId);
      const stored = await services.adapter.head(intent.key);
      if (!stored) throw operationFailure(uploadMissing);
      const contentType = (stored.contentType ?? intent.contentType)
        .toLowerCase()
        .split(";")[0]!
        .trim();
      if (
        !attachment ||
        stored.size > attachment.maxBytes ||
        contentType !== intent.contentType ||
        !attachmentAcceptsContentType(attachment, contentType)
      ) {
        await services.adapter.delete(intent.key);
        throw operationFailure(uploadRejected);
      }
      const settled = await services.ledger.completeIntent({
        intentId: intent.id,
        objectId: randomUUID(),
        size: stored.size,
        contentType,
        completedAt: now,
      });
      if (!settled) {
        // The sweep won the race between our read and our write; the bytes
        // go the same way as any other abandoned upload.
        await services.adapter.delete(intent.key);
        throw operationFailure(intentExpired);
      }
      return {
        objectId: settled.object.id,
        objectKey: settled.object.key,
        contentType: settled.object.contentType,
        size: settled.object.size,
      };
    },
  });

  const sweepBatch = options.sweep?.batchSize ?? DEFAULT_SWEEP_BATCH;
  const graceMs = options.sweep?.unattachedGraceMs ?? DEFAULT_UNATTACHED_GRACE_MS;
  const sweep = defineJob({
    id: STORAGE_SWEEP_JOB_ID,
    input: sweepInputSchema,
    trigger: options.sweep?.trigger ?? DEFAULT_SWEEP_TRIGGER,
    concurrency: { mode: "single-runner", key: () => "sweep" },
    retry: { attempts: 1, backoff: { initialMs: 1_000 } },
    retention: { completedMs: 24 * 60 * 60 * 1000, deadLetteredMs: 7 * 24 * 60 * 60 * 1000 },
    transaction: "none",
    dependencies: {
      adapter: storageAdapterEffect,
      purger: storagePurgeEffect,
      ledger: storageLedgerDependency,
    },
    effects: [storageAdapterEffect, storagePurgeEffect],
    handler: async ({ services }) => {
      const now = clock();
      const abandoned = await services.ledger.claimExpiredIntents(now, sweepBatch);
      for (const intent of abandoned) {
        // The client may have PUT the bytes and never completed; the key is
        // reserved for this intent alone, so deleting it is always safe.
        await services.adapter.delete(intent.key);
      }
      const stale = await services.ledger.claimStaleObjects(
        new Date(now.getTime() - graceMs),
        sweepBatch,
      );
      let purged = 0;
      for (const object of stale) {
        if ((await services.purger.purge(object.id)) === "purged") purged += 1;
      }
      return { abandoned: abandoned.length, stale: stale.length, purged };
    },
  });

  const dispatcher = defineOutboxDispatcher(purgeOutbox, {
    batchSize: options.purge?.batchSize ?? DEFAULT_DISPATCH_BATCH,
    lease: options.purge?.lease ?? { ms: DEFAULT_DISPATCH_LEASE_MS },
    retry: options.purge?.retry ?? DEFAULT_DISPATCH_RETRY,
    deadLetter: true,
    ...(options.purge?.roundsPerSecond !== undefined
      ? { roundsPerSecond: options.purge.roundsPerSecond }
      : {}),
    clock,
  });
  const cleanup = defineOutboxCleanup(purgeOutbox, { clock });

  const providers: AnyProvider[] = [
    valueProvider(storageAdapterEffect, options.adapter),
    valueProvider(storageLedgerDependency, options.ledger),
    valueProvider(storagePurgeEffect, purger),
    valueProvider(purgeOutbox.writer, options.outbox),
  ];
  const exported: DependencyToken[] = [];
  if (options.variants) {
    providers.push(valueProvider(storageImageProcessorEffect, options.variants.processor));
  }
  for (const attachment of options.attachments) {
    providers.push(
      valueProvider(
        attachment.binding,
        createAttachmentCapability({
          attachment,
          adapter: options.adapter,
          ledger: options.ledger,
          purgeOutbox,
          purgeBackend: options.outbox,
          ...(variantRuntime ? { variants: variantRuntime } : {}),
          ...(options.signedUrlTtlMs !== undefined
            ? { signedUrlTtlMs: options.signedUrlTtlMs }
            : {}),
          clock,
        }),
      ),
    );
    exported.push(attachment.binding);
  }

  const module = defineModule({
    id: STORAGE_MODULE_ID,
    operations: [
      createIntent,
      complete,
      sweep,
      ...(options.variants ? [generateVariant] : []),
      ...dispatcher.operations,
      cleanup,
    ],
    providers,
    imports: [...(options.imports ?? [])],
    exports: exported,
  });

  return Object.freeze({
    ...module,
    /** The purge outbox, for binding a Drizzle or in-memory backend. */
    purgeOutbox,
    operationsByRole: Object.freeze({
      createIntent,
      complete,
      sweep,
      ...(options.variants ? { generateVariant } : {}),
      dispatcher,
      cleanup,
    }),
  });
}

export type StorageModule = ReturnType<typeof defineStorageModule>;

function assertOptions(options: StorageModuleOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "defineStorageModule requires an options object",
    );
  }
  if (!Array.isArray(options.attachments) || !options.attachments.every(isAttachment)) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "attachments must contain only defineAttachment() results",
    );
  }
  const ids = new Set<string>();
  for (const attachment of options.attachments) {
    if (ids.has(attachment.id)) {
      throw new StorageModuleError(
        "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
        `attachment ${JSON.stringify(attachment.id)} is listed more than once`,
      );
    }
    ids.add(attachment.id);
  }
  if (!isStorageAdapter(options.adapter)) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "adapter must be a StorageAdapter (disk, s3, gcs or the in-memory test adapter)",
    );
  }
  if (!isAttachmentLedger(options.ledger)) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "ledger must be an AttachmentLedger (createDrizzleAttachmentLedger or the in-memory test ledger)",
    );
  }
  if (
    typeof options.outbox !== "object" ||
    options.outbox === null ||
    Reflect.get(options.outbox, "kind") !== "ship.outbox-backend"
  ) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "outbox must be an OutboxBackend bound to the ship-storage.purge outbox",
    );
  }
  const declaresVariants = options.attachments.some(
    (attachment) => Object.keys(attachment.variants).length > 0,
  );
  if (declaresVariants && !options.variants) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "an attachment declares variants; pass variants: { processor, jobs } so they can be rendered",
    );
  }
  if (options.variants) {
    if (!isImageProcessor(options.variants.processor)) {
      throw new StorageModuleError(
        "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
        "variants.processor must be an ImageProcessor",
      );
    }
    if (
      typeof options.variants.jobs !== "object" ||
      options.variants.jobs === null ||
      typeof Reflect.get(options.variants.jobs, "enqueue") !== "function"
    ) {
      throw new StorageModuleError(
        "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
        "variants.jobs must be the application's JobBackend",
      );
    }
  }
  if (options.keyPrefix !== undefined && !/^(?:[A-Za-z0-9._-]+\/)*$/u.test(options.keyPrefix)) {
    throw new StorageModuleError(
      "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      "keyPrefix must be empty or slash-terminated safe segments such as tenant-a/",
    );
  }
  for (const [name, value] of [
    ["signedUrlTtlMs", options.signedUrlTtlMs],
    ["sweep.batchSize", options.sweep?.batchSize],
    ["sweep.unattachedGraceMs", options.sweep?.unattachedGraceMs],
    ["variants.cacheTtlMs", options.variants?.cacheTtlMs],
    ["variants.concurrency", options.variants?.concurrency],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new StorageModuleError(
        "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
        `${name} must be a positive safe integer`,
      );
    }
  }
}
