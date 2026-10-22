import type { ApplicationDiagnostic } from "./application.js";
import type { DependencyToken } from "./dependency.js";
import { isDependencyToken } from "./dependency.js";
import type { AnyModule } from "./module.js";
import type { AnyOperation } from "./operation.js";

const ATTACHMENT_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const VARIANT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+)$/iu;
const BINDING_SUFFIX = ".attachment";
/** The module id a mounted storage module must use. */
export const STORAGE_MODULE_ID = "ship-storage";
/** Default lifetime of a signed upload intent before the sweep abandons it. */
export const DEFAULT_ATTACHMENT_INTENT_TTL_MS = 15 * 60 * 1000;
/** Upper bound on `maxCount` for `many` attachments; a larger field is a listing, not an attachment. */
export const MAX_ATTACHMENT_COUNT = 1_000;

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

export type AttachmentCardinality = "single" | "many";
/** `private` objects are reachable only through short-lived signed URLs; `public` objects have a stable URL. */
export type AttachmentVisibility = "private" | "public";
export type AttachmentVariantFit = "cover" | "contain" | "inside";
export type AttachmentVariantFormat = "webp" | "jpeg" | "png" | "avif";

/**
 * A declared image derivative. Variants are generated lazily by the
 * `ship-storage.generate-variant` job the first time they are requested and
 * remembered through the ledger and the cache capability.
 */
export interface AttachmentVariant {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: AttachmentVariantFit;
  readonly format?: AttachmentVariantFormat;
  /** 1..100; adapters pass it to the encoder. */
  readonly quality?: number;
}

export type AttachmentVariants = Readonly<Record<string, AttachmentVariant>>;

export interface AttachmentDefinition<
  TId extends string = string,
  TVariants extends AttachmentVariants = AttachmentVariants,
  TCardinality extends AttachmentCardinality = AttachmentCardinality,
  TVisibility extends AttachmentVisibility = AttachmentVisibility,
> {
  /** Namespaced by the owning module, `<moduleId>.<field>`, like an operation id. */
  readonly id: TId;
  readonly cardinality: TCardinality;
  /** Accepted media types; `image/*` style wildcards are allowed. */
  readonly contentTypes: readonly string[];
  /** Upper bound on one object; the intent refuses a larger declared size and completion re-checks it. */
  readonly maxBytes: number;
  readonly visibility: TVisibility;
  /** For `many`: how many objects one owner may hold. Defaults to {@link MAX_ATTACHMENT_COUNT}. */
  readonly maxCount?: number;
  /** Image derivatives; only valid when every accepted content type is an image type. */
  readonly variants?: TVariants;
  /** How long an issued upload intent stays valid before the sweep abandons it. */
  readonly intentTtlMs?: number;
}

export interface Attachment<
  TId extends string = string,
  TVariants extends AttachmentVariants = AttachmentVariants,
  TCardinality extends AttachmentCardinality = AttachmentCardinality,
  TVisibility extends AttachmentVisibility = AttachmentVisibility,
> extends AttachmentDefinition<TId, TVariants, TCardinality, TVisibility> {
  readonly kind: "ship.attachment";
  readonly maxCount: number;
  readonly variants: TVariants;
  readonly intentTtlMs: number;
  /**
   * The dependency an operation binds to attach, detach, list and resolve
   * objects of this attachment. The storage module provides it; the executor
   * hands the handler a transaction-scoped view.
   */
  readonly binding: AttachmentDependencyToken<
    Attachment<TId, TVariants, TCardinality, TVisibility>
  >;
}

export interface AnyAttachment {
  readonly kind: "ship.attachment";
  readonly id: string;
  readonly cardinality: AttachmentCardinality;
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  readonly visibility: AttachmentVisibility;
  readonly maxCount: number;
  readonly variants: AttachmentVariants;
  readonly intentTtlMs: number;
  readonly binding: DependencyToken & {
    readonly scope: "attachment";
    readonly attachmentId: string;
  };
}

export type AttachmentVariantName<TAttachment> = TAttachment extends {
  readonly variants: infer TVariants;
}
  ? Extract<keyof TVariants, string>
  : string;

export interface AttachmentDependencyToken<TAttachment extends AnyAttachment = AnyAttachment>
  extends DependencyToken<
    AttachmentCapability,
    ScopedAttachmentCapability<AttachmentVariantName<TAttachment>>
  > {
  readonly scope: "attachment";
  readonly attachmentId: string;
}

export type AttachmentDefinitionDiagnosticCode =
  | "SHIP_ATTACHMENT_DEFINITION_INVALID"
  | "SHIP_ATTACHMENT_ID_INVALID"
  | "SHIP_ATTACHMENT_CARDINALITY_INVALID"
  | "SHIP_ATTACHMENT_CONTENT_TYPES_INVALID"
  | "SHIP_ATTACHMENT_MAX_BYTES_INVALID"
  | "SHIP_ATTACHMENT_VISIBILITY_INVALID"
  | "SHIP_ATTACHMENT_MAX_COUNT_INVALID"
  | "SHIP_ATTACHMENT_VARIANT_INVALID"
  | "SHIP_ATTACHMENT_VARIANT_CONTENT_TYPE_INVALID"
  | "SHIP_ATTACHMENT_INTENT_TTL_INVALID";

export class InvalidAttachmentDefinitionError extends Error {
  readonly code: AttachmentDefinitionDiagnosticCode;
  readonly attachmentId?: string;
  readonly field?: string;

  constructor(
    code: AttachmentDefinitionDiagnosticCode,
    message: string,
    options: { readonly attachmentId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidAttachmentDefinitionError";
    this.code = code;
    this.attachmentId = options.attachmentId;
    this.field = options.field;
  }
}

/**
 * Declares a managed attachment field: how many objects an owner may hold,
 * what may be uploaded, how large, who may read it, and which image
 * derivatives exist. The declaration carries no provider detail; the storage
 * module binds the adapter, ledger and purge outbox at composition time.
 */
export function defineAttachment<
  const TId extends string,
  const TVariants extends AttachmentVariants = Readonly<Record<never, never>>,
  const TCardinality extends AttachmentCardinality = AttachmentCardinality,
  const TVisibility extends AttachmentVisibility = AttachmentVisibility,
>(
  definition: AttachmentDefinition<TId, TVariants, TCardinality, TVisibility>,
): Attachment<TId, TVariants, TCardinality, TVisibility> {
  assertAttachmentDefinition(definition);
  const variants = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.variants ?? {}).map(([name, variant]) => [
        name,
        Object.freeze({ ...variant }),
      ]),
    ),
  ) as TVariants;
  const attachment = {
    kind: "ship.attachment" as const,
    id: definition.id,
    cardinality: definition.cardinality,
    contentTypes: Object.freeze(definition.contentTypes.map((type) => type.toLowerCase())),
    maxBytes: definition.maxBytes,
    visibility: definition.visibility,
    maxCount:
      definition.cardinality === "single" ? 1 : (definition.maxCount ?? MAX_ATTACHMENT_COUNT),
    variants,
    intentTtlMs: definition.intentTtlMs ?? DEFAULT_ATTACHMENT_INTENT_TTL_MS,
  } as {
    -readonly [TKey in keyof Attachment<TId, TVariants, TCardinality, TVisibility>]: Attachment<
      TId,
      TVariants,
      TCardinality,
      TVisibility
    >[TKey];
  };
  attachment.binding = Object.freeze({
    kind: "ship.dependency" as const,
    id: `${definition.id}${BINDING_SUFFIX}`,
    scope: "attachment" as const,
    attachmentId: definition.id,
  }) as AttachmentDependencyToken<Attachment<TId, TVariants, TCardinality, TVisibility>>;
  const frozen = Object.freeze(attachment);
  bindingAttachments.set(attachment.binding, frozen as unknown as AnyAttachment);
  return frozen;
}

const bindingAttachments = new WeakMap<object, AnyAttachment>();

/** Resolves the attachment a binding token was created for; undefined for foreign tokens. */
export function attachmentForBinding(token: DependencyToken): AnyAttachment | undefined {
  return bindingAttachments.get(token);
}

export function isAttachment(value: unknown): value is AnyAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.attachment" &&
    typeof Reflect.get(value, "id") === "string" &&
    ATTACHMENT_ID_PATTERN.test(Reflect.get(value, "id")) &&
    isAttachmentDependencyToken(Reflect.get(value, "binding"))
  );
}

export function isAttachmentDependencyToken(value: unknown): value is AttachmentDependencyToken {
  return (
    isDependencyToken(value) &&
    value.scope === "attachment" &&
    typeof Reflect.get(value, "attachmentId") === "string" &&
    value.id === `${Reflect.get(value, "attachmentId")}${BINDING_SUFFIX}`
  );
}

/** True when a declared content type list admits `contentType`, honouring `type/*` wildcards. */
export function attachmentAcceptsContentType(
  attachment: Pick<AnyAttachment, "contentTypes">,
  contentType: string,
): boolean {
  const candidate = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!CONTENT_TYPE_PATTERN.test(candidate) || candidate.endsWith("/*")) return false;
  return attachment.contentTypes.some((accepted) =>
    accepted.endsWith("/*") ? candidate.startsWith(accepted.slice(0, -1)) : accepted === candidate,
  );
}

function isImageContentType(contentType: string): boolean {
  return contentType === "image/*" || contentType.startsWith("image/");
}

function assertAttachmentDefinition(
  definition: unknown,
): asserts definition is AttachmentDefinition {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_ATTACHMENT_DEFINITION_INVALID", "attachment definition must be an object");
  }
  const id = Reflect.get(definition, "id");
  const attachmentId = typeof id === "string" ? id : undefined;
  if (!attachmentId || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    fail(
      "SHIP_ATTACHMENT_ID_INVALID",
      "attachment id must contain at least two lowercase dot-separated segments (<moduleId>.<field>)",
      attachmentId,
      "id",
    );
  }
  const cardinality = Reflect.get(definition, "cardinality");
  if (cardinality !== "single" && cardinality !== "many") {
    fail(
      "SHIP_ATTACHMENT_CARDINALITY_INVALID",
      "cardinality must be single or many",
      attachmentId,
      "cardinality",
    );
  }
  const contentTypes = Reflect.get(definition, "contentTypes");
  if (
    !Array.isArray(contentTypes) ||
    contentTypes.length === 0 ||
    !contentTypes.every(
      (type) => typeof type === "string" && CONTENT_TYPE_PATTERN.test(type) && type === type.trim(),
    ) ||
    new Set(contentTypes.map((type: string) => type.toLowerCase())).size !== contentTypes.length
  ) {
    fail(
      "SHIP_ATTACHMENT_CONTENT_TYPES_INVALID",
      "contentTypes must be a non-empty list of unique media types such as image/png or image/*",
      attachmentId,
      "contentTypes",
    );
  }
  const maxBytes = Reflect.get(definition, "maxBytes");
  if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) {
    fail(
      "SHIP_ATTACHMENT_MAX_BYTES_INVALID",
      "maxBytes must be a positive safe integer",
      attachmentId,
      "maxBytes",
    );
  }
  const visibility = Reflect.get(definition, "visibility");
  if (visibility !== "private" && visibility !== "public") {
    fail(
      "SHIP_ATTACHMENT_VISIBILITY_INVALID",
      "visibility must be private or public",
      attachmentId,
      "visibility",
    );
  }
  const maxCount = Reflect.get(definition, "maxCount");
  if (maxCount !== undefined) {
    if (cardinality === "single") {
      fail(
        "SHIP_ATTACHMENT_MAX_COUNT_INVALID",
        "maxCount applies to many attachments only; a single attachment holds one object",
        attachmentId,
        "maxCount",
      );
    }
    if (
      !Number.isSafeInteger(maxCount) ||
      (maxCount as number) < 1 ||
      (maxCount as number) > MAX_ATTACHMENT_COUNT
    ) {
      fail(
        "SHIP_ATTACHMENT_MAX_COUNT_INVALID",
        `maxCount must be an integer between 1 and ${MAX_ATTACHMENT_COUNT}`,
        attachmentId,
        "maxCount",
      );
    }
  }
  const intentTtlMs = Reflect.get(definition, "intentTtlMs");
  if (intentTtlMs !== undefined && (!Number.isSafeInteger(intentTtlMs) || intentTtlMs <= 0)) {
    fail(
      "SHIP_ATTACHMENT_INTENT_TTL_INVALID",
      "intentTtlMs must be a positive safe integer",
      attachmentId,
      "intentTtlMs",
    );
  }
  const variants = Reflect.get(definition, "variants");
  if (variants === undefined) return;
  if (typeof variants !== "object" || variants === null || Array.isArray(variants)) {
    fail(
      "SHIP_ATTACHMENT_VARIANT_INVALID",
      "variants must be a map of variant names to { width?, height?, fit?, format?, quality? }",
      attachmentId,
      "variants",
    );
  }
  const names = Object.keys(variants);
  if (names.length > 0 && !contentTypes.every((type: string) => isImageContentType(type))) {
    fail(
      "SHIP_ATTACHMENT_VARIANT_CONTENT_TYPE_INVALID",
      "variants require every accepted content type to be an image type",
      attachmentId,
      "variants",
    );
  }
  for (const name of names) {
    const variant = Reflect.get(variants, name);
    if (!VARIANT_NAME_PATTERN.test(name) || !isAttachmentVariant(variant)) {
      fail(
        "SHIP_ATTACHMENT_VARIANT_INVALID",
        `variant ${JSON.stringify(name)} must have a lowercase name and declare at least a width or height, with optional fit, format and quality`,
        attachmentId,
        `variants.${name}`,
      );
    }
  }
}

function isAttachmentVariant(value: unknown): value is AttachmentVariant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const width = Reflect.get(value, "width");
  const height = Reflect.get(value, "height");
  const fit = Reflect.get(value, "fit");
  const format = Reflect.get(value, "format");
  const quality = Reflect.get(value, "quality");
  const dimension = (item: unknown) =>
    item === undefined || (Number.isSafeInteger(item) && (item as number) > 0);
  return (
    (width !== undefined || height !== undefined) &&
    dimension(width) &&
    dimension(height) &&
    (fit === undefined || fit === "cover" || fit === "contain" || fit === "inside") &&
    (format === undefined || ["webp", "jpeg", "png", "avif"].includes(format as string)) &&
    (quality === undefined ||
      (Number.isSafeInteger(quality) && (quality as number) >= 1 && (quality as number) <= 100))
  );
}

function fail(
  code: AttachmentDefinitionDiagnosticCode,
  message: string,
  attachmentId?: string,
  field?: string,
): never {
  throw new InvalidAttachmentDefinitionError(code, message, { attachmentId, field });
}

// ---------------------------------------------------------------------------
// Capability contracts (adapters live outside the kernel)
// ---------------------------------------------------------------------------

export type AttachmentObjectStatus = "uploaded" | "attached" | "purging" | "purged";
export type AttachmentIntentStatus = "pending" | "completed" | "abandoned";

export interface AttachmentVariantObject {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
}

/** A stored object of one attachment, as the ledger records it. */
export interface AttachmentObject {
  readonly id: string;
  readonly attachmentId: string;
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly status: AttachmentObjectStatus;
  /** The actor who completed the upload. */
  readonly uploadedBy: string;
  /** Present once the object is attached to an owner. */
  readonly ownerId?: string;
  readonly createdAt: Date;
  readonly attachedAt?: Date;
  readonly variants: Readonly<Record<string, AttachmentVariantObject>>;
}

/** A signed upload intent: an object key reserved for one upload. */
export interface AttachmentIntent {
  readonly id: string;
  readonly attachmentId: string;
  readonly key: string;
  readonly contentType: string;
  /** The size the client declared; completion verifies the stored object against it. */
  readonly size: number;
  readonly actorId: string;
  readonly status: AttachmentIntentStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly completedAt?: Date;
  readonly abandonedAt?: Date;
  readonly objectId?: string;
}

/** A purge owed for one object; the row makes the purge idempotent across replays. */
export interface AttachmentPurge {
  readonly objectId: string;
  /** Every key the purge deletes: the original and each generated variant. */
  readonly keys: readonly string[];
  readonly requestedAt: Date;
  readonly purgedAt?: Date;
  readonly attempts: number;
}

export interface AttachmentUrl {
  readonly url: string;
  /** Absent for public objects. */
  readonly expiresAt?: Date;
}

export type AttachmentVariantResolution =
  | { readonly status: "ready"; readonly url: AttachmentUrl }
  | { readonly status: "pending" };

/**
 * The handler-facing view of one attachment, bound to the running
 * operation's unit-of-work scope by the executor. `attach` and `detach`
 * require a write transaction: they change the ledger and record purge
 * intents that must commit with the owning record.
 */
export interface ScopedAttachmentCapability<TVariant extends string = string> {
  readonly attachmentId: string;
  /** Binds an uploaded, unattached object to an owner. */
  attach(input: { readonly ownerId: string; readonly objectId: string }): Promise<AttachmentObject>;
  /**
   * Detaches one object, or every object of the owner when `objectId` is
   * omitted, and records one durable purge intent per object. Returns the
   * objects now marked `purging`.
   */
  detach(input: {
    readonly ownerId: string;
    readonly objectId?: string;
  }): Promise<readonly AttachmentObject[]>;
  list(ownerId: string): Promise<readonly AttachmentObject[]>;
  read(objectId: string): Promise<AttachmentObject | undefined>;
  /** A URL for the original object; signed and short-lived for private attachments. */
  url(
    objectId: string,
    options?: { readonly expiresInMs?: number },
  ): Promise<AttachmentUrl | undefined>;
  /**
   * A URL for a declared variant. The first request enqueues generation and
   * answers `pending`; later requests answer `ready` from the ledger or cache.
   */
  variant(
    objectId: string,
    name: TVariant,
    options?: { readonly expiresInMs?: number },
  ): Promise<AttachmentVariantResolution | undefined>;
}

/** The provider value bound to `attachment.binding`; the executor scopes it per run. */
export interface AttachmentCapability {
  readonly kind: "ship.attachment-capability";
  readonly attachmentId: string;
  withScope(scope: object | undefined): ScopedAttachmentCapability;
}

export function isAttachmentCapability(value: unknown): value is AttachmentCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.attachment-capability" &&
    typeof Reflect.get(value, "attachmentId") === "string" &&
    typeof Reflect.get(value, "withScope") === "function"
  );
}

export interface StorageObjectMeta {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: Date;
}

export interface StorageSignedUpload {
  readonly url: string;
  readonly method: "PUT";
  /** Headers the client must send verbatim; the signature covers them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface StorageSignUploadRequest {
  readonly key: string;
  readonly contentType: string;
  /** The exact size the client declared; adapters that can bind it to the signature do. */
  readonly size: number;
  readonly expiresAt: Date;
}

export interface StorageAdapterHealth {
  readonly available: boolean;
  readonly detail?: string;
}

/**
 * Provider contract for object storage. It is deliberately narrow: direct
 * uploads go to the provider through a signed URL, the framework only ever
 * reads whole objects to derive variants, and deletes are idempotent (a
 * missing key is a success). Drivers live in `@sixthsummit/ship-storage`.
 */
export interface StorageAdapter {
  readonly kind: "ship.storage-adapter";
  /** Informational provider name (`disk`, `s3`, `gcs`); never projected into contracts. */
  readonly provider: string;
  signUpload(request: StorageSignUploadRequest): Promise<StorageSignedUpload>;
  head(key: string): Promise<StorageObjectMeta | undefined>;
  get(
    key: string,
  ): Promise<{ readonly body: Uint8Array; readonly meta: StorageObjectMeta } | undefined>;
  put(
    key: string,
    body: Uint8Array,
    options: { readonly contentType: string; readonly cacheControl?: string },
  ): Promise<StorageObjectMeta>;
  delete(key: string): Promise<void>;
  signDownload(key: string, options: { readonly expiresAt: Date }): Promise<string>;
  publicUrl(key: string): string;
  health(): Promise<StorageAdapterHealth>;
}

export function isStorageAdapter(value: unknown): value is StorageAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.storage-adapter" &&
    typeof Reflect.get(value, "provider") === "string" &&
    ["signUpload", "head", "get", "put", "delete", "signDownload", "publicUrl", "health"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

export interface AttachmentIntentInput {
  readonly id: string;
  readonly attachmentId: string;
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly actorId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface AttachmentCompletionInput {
  readonly intentId: string;
  readonly objectId: string;
  /** The size the provider reports; replaces the declared size. */
  readonly size: number;
  readonly contentType: string;
  readonly completedAt: Date;
}

export interface AttachmentAttachInput {
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly objectId: string;
  readonly attachedAt: Date;
}

export interface AttachmentDetachInput {
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly objectId?: string;
  readonly requestedAt: Date;
}

export interface AttachmentLedgerHealth {
  readonly available: boolean;
  readonly detail?: string;
}

/**
 * Durable bookkeeping for intents, objects and purges. Every method that
 * takes a `scope` joins the executor-supplied unit-of-work scope so the
 * ledger change commits or rolls back with the owning record; methods
 * without one run autonomously (the intent and completion operations are
 * not transactional because they perform provider effects).
 */
export interface AttachmentLedger {
  readonly kind: "ship.attachment-ledger";
  createIntent(input: AttachmentIntentInput): Promise<AttachmentIntent>;
  readIntent(intentId: string): Promise<AttachmentIntent | undefined>;
  /**
   * Atomically moves a pending intent to completed and creates the object.
   * Returns undefined when the intent is not pending any more (completed,
   * abandoned by the sweep, or unknown), which is how a late completion is fenced.
   */
  completeIntent(
    input: AttachmentCompletionInput,
  ): Promise<{ readonly intent: AttachmentIntent; readonly object: AttachmentObject } | undefined>;
  /** Atomically claims pending intents past expiry as abandoned; safe across concurrent sweepers. */
  claimExpiredIntents(now: Date, limit: number): Promise<readonly AttachmentIntent[]>;
  readObject(objectId: string): Promise<AttachmentObject | undefined>;
  listObjects(attachmentId: string, ownerId: string): Promise<readonly AttachmentObject[]>;
  /** Returns undefined when the object is not an unattached upload of this attachment. */
  attach(
    scope: object | undefined,
    input: AttachmentAttachInput,
  ): Promise<AttachmentObject | undefined>;
  /** Marks matching attached objects `purging`, records a purge row per object, returns them. */
  detach(
    scope: object | undefined,
    input: AttachmentDetachInput,
  ): Promise<readonly AttachmentObject[]>;
  /** Uploaded objects never attached before `cutoff`: marks them `purging` with a purge row and returns them. */
  claimStaleObjects(cutoff: Date, limit: number): Promise<readonly AttachmentObject[]>;
  recordVariant(objectId: string, name: string, variant: AttachmentVariantObject): Promise<void>;
  readPurge(objectId: string): Promise<AttachmentPurge | undefined>;
  /** Marks the purge done; returns false when it was already done (a replay). */
  markPurged(objectId: string, purgedAt: Date): Promise<boolean>;
  health(): Promise<AttachmentLedgerHealth>;
}

export function isAttachmentLedger(value: unknown): value is AttachmentLedger {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.attachment-ledger" &&
    [
      "createIntent",
      "readIntent",
      "completeIntent",
      "claimExpiredIntents",
      "readObject",
      "listObjects",
      "attach",
      "detach",
      "claimStaleObjects",
      "recordVariant",
      "readPurge",
      "markPurged",
      "health",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface AttachmentGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly cardinality: AttachmentCardinality;
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  readonly visibility: AttachmentVisibility;
  readonly maxCount: number;
  readonly variants: readonly string[];
  readonly intentTtlMs: number;
  /** The provider id that binds the capability, when a storage module is mounted. */
  readonly providerId?: string;
  /** Operations that bind this attachment. */
  readonly operations: readonly string[];
}

export function collectAttachmentOwners(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: ApplicationDiagnostic[],
): ReadonlyMap<string, { readonly module: AnyModule; readonly attachment: AnyAttachment }> {
  const owners = new Map<string, { module: AnyModule; attachment: AnyAttachment }>();
  for (const module of [...modules].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const attachment of [...module.attachments].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const previous = owners.get(attachment.id);
      if (previous) {
        diagnostics.push({
          code: "SHIP_ATTACHMENT_ID_DUPLICATE",
          severity: "error",
          message: `attachment id ${JSON.stringify(attachment.id)} is declared by both ${JSON.stringify(previous.module.id)} and ${JSON.stringify(module.id)}`,
          hint: "Declare each attachment in exactly one module and import that module where it is used.",
          appId,
          moduleId: module.id,
          providerId: attachment.binding.id,
          path: "attachments",
        });
        continue;
      }
      owners.set(attachment.id, { module, attachment });
      if (!attachment.id.startsWith(`${module.id}.`)) {
        diagnostics.push({
          code: "SHIP_ATTACHMENT_MODULE_ID_MISMATCH",
          severity: "error",
          message: `attachment ${JSON.stringify(attachment.id)} is not namespaced by module ${JSON.stringify(module.id)}`,
          hint: `Rename the attachment so its id starts with ${JSON.stringify(`${module.id}.`)}.`,
          appId,
          moduleId: module.id,
          providerId: attachment.binding.id,
          path: "attachments",
        });
      }
    }
  }
  const bound = new Set<string>();
  for (const module of modules) {
    for (const provider of module.providers) {
      if (isAttachmentDependencyToken(provider.token)) bound.add(provider.token.attachmentId);
    }
  }
  for (const [id, owner] of [...owners].sort(([left], [right]) => left.localeCompare(right))) {
    if (bound.has(id)) continue;
    diagnostics.push({
      code: "SHIP_ATTACHMENT_STORAGE_MODULE_MISSING",
      severity: "error",
      message: `attachment ${JSON.stringify(id)} is declared but no module binds its capability; nothing can be uploaded to it`,
      hint: `Mount defineStorageModule({ attachments: [...] }) from @sixthsummit/ship-storage with this attachment listed, and import ${JSON.stringify(STORAGE_MODULE_ID)} where it is used.`,
      appId,
      moduleId: owner.module.id,
      providerId: owner.attachment.binding.id,
      path: "attachments",
    });
  }
  return owners;
}

export function checkOperationAttachments(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  owners: ReadonlyMap<string, { readonly module: AnyModule; readonly attachment: AnyAttachment }>,
  diagnostics: ApplicationDiagnostic[],
): void {
  const context = { appId, moduleId: module.id, operationId: operation.id };
  const declaredIds = new Set(operation.attachments.map((attachment) => attachment.id));
  const boundAttachments = Object.entries(operation.dependencies).flatMap(([name, token]) =>
    isAttachmentDependencyToken(token) ? [{ name, attachmentId: token.attachmentId }] : [],
  );
  const boundIds = new Set(boundAttachments.map((item) => item.attachmentId));

  for (const attachment of [...operation.attachments].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const owner = owners.get(attachment.id);
    if (!owner || owner.attachment !== attachment) {
      diagnostics.push({
        code: "SHIP_ATTACHMENT_UNDECLARED",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} uses attachment ${JSON.stringify(attachment.id)} that no module declares`,
        hint: "Add the attachment instance to the owning module's attachments list.",
        ...context,
        providerId: attachment.binding.id,
        path: "attachments",
      });
    } else if (
      owner.module.id !== module.id &&
      !module.imports.includes(owner.module.id) &&
      module.id !== STORAGE_MODULE_ID
    ) {
      diagnostics.push({
        code: "SHIP_ATTACHMENT_IMPORT_REQUIRED",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} uses attachment ${JSON.stringify(attachment.id)} from module ${JSON.stringify(owner.module.id)} without importing it`,
        hint: `Add ${JSON.stringify(owner.module.id)} to ${JSON.stringify(module.id)} imports.`,
        ...context,
        providerId: attachment.binding.id,
        path: "attachments",
      });
    }
    if (!boundIds.has(attachment.id)) {
      diagnostics.push({
        code: "SHIP_OPERATION_ATTACHMENT_UNBOUND",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} declares attachment ${JSON.stringify(attachment.id)} without binding its capability token`,
        hint: "Bind attachment.binding in the operation dependencies or remove the declaration.",
        ...context,
        providerId: attachment.binding.id,
        path: "attachments",
      });
    }
  }
  for (const bound of boundAttachments.sort((left, right) => left.name.localeCompare(right.name))) {
    if (declaredIds.has(bound.attachmentId)) continue;
    diagnostics.push({
      code: "SHIP_OPERATION_ATTACHMENT_UNDECLARED",
      severity: "error",
      message: `operation ${JSON.stringify(operation.id)} binds attachment ${JSON.stringify(bound.attachmentId)} without declaring it in attachments`,
      hint: "Add the attachment to the operation attachments list.",
      ...context,
      providerId: `${bound.attachmentId}${BINDING_SUFFIX}`,
      path: `dependencies.${bound.name}`,
    });
  }
}

export function projectAttachments(modules: readonly AnyModule[]): readonly AttachmentGraphNode[] {
  const users = new Map<string, string[]>();
  const providers = new Map<string, string>();
  for (const module of modules) {
    for (const operation of module.operations) {
      for (const attachment of operation.attachments) {
        const list = users.get(attachment.id) ?? [];
        list.push(operation.id);
        users.set(attachment.id, list);
      }
    }
    for (const provider of module.providers) {
      if (isAttachmentDependencyToken(provider.token)) {
        providers.set(provider.token.attachmentId, provider.token.id);
      }
    }
  }
  const nodes: AttachmentGraphNode[] = [];
  for (const module of modules) {
    for (const attachment of module.attachments) {
      const providerId = providers.get(attachment.id);
      nodes.push(
        Object.freeze({
          id: attachment.id,
          moduleId: module.id,
          cardinality: attachment.cardinality,
          contentTypes: Object.freeze([...attachment.contentTypes].sort()),
          maxBytes: attachment.maxBytes,
          visibility: attachment.visibility,
          maxCount: attachment.maxCount,
          variants: Object.freeze(Object.keys(attachment.variants).sort()),
          intentTtlMs: attachment.intentTtlMs,
          ...(providerId ? { providerId } : {}),
          operations: Object.freeze([...new Set(users.get(attachment.id) ?? [])].sort()),
        }),
      );
    }
  }
  return Object.freeze(nodes.sort((left, right) => left.id.localeCompare(right.id)));
}
