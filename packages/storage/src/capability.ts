import {
  type AnyAttachment,
  type AttachmentCapability,
  type AttachmentLedger,
  type AttachmentObject,
  type AttachmentUrl,
  type AttachmentVariantObject,
  type AttachmentVariantResolution,
  type CacheBackend,
  createOutboxWriter,
  type JobEnqueueResult,
  type OutboxBackend,
  type ScopedAttachmentCapability,
  type StorageAdapter,
} from "@sixthsummit/ship-core";
import { STORAGE_PURGE_INTENT_ID, type StoragePurgeOutbox } from "./tokens.js";

export type AttachmentCapabilityErrorCode =
  | "SHIP_ATTACHMENT_SCOPE_REQUIRED"
  | "SHIP_ATTACHMENT_OBJECT_UNAVAILABLE"
  | "SHIP_ATTACHMENT_LIMIT_EXCEEDED"
  | "SHIP_ATTACHMENT_VARIANT_UNKNOWN"
  | "SHIP_ATTACHMENT_VARIANTS_UNCONFIGURED"
  | "SHIP_ATTACHMENT_VARIANT_QUEUE_FULL";

/**
 * Raised by the scoped capability. Handlers translate the codes they expose
 * to clients into their own declared `operationFailure`s; an untranslated
 * error is an unexpected failure, which is the right outcome for a bug.
 */
export class AttachmentCapabilityError extends Error {
  readonly code: AttachmentCapabilityErrorCode;
  readonly attachmentId: string;
  readonly objectId?: string;

  constructor(
    code: AttachmentCapabilityErrorCode,
    message: string,
    options: { readonly attachmentId: string; readonly objectId?: string },
  ) {
    super(message);
    this.name = "AttachmentCapabilityError";
    this.code = code;
    this.attachmentId = options.attachmentId;
    this.objectId = options.objectId;
  }
}

export interface AttachmentVariantRuntime {
  /** Enqueues `ship-storage.generate-variant`; the module binds it to the job backend. */
  readonly enqueue: (
    input: { readonly objectId: string; readonly variant: string },
    options: { readonly dedupeKey: string },
  ) => Promise<JobEnqueueResult>;
  /** Remembers resolved variant objects so hot reads skip the ledger. */
  readonly cache?: CacheBackend;
  readonly cacheTtlMs: number;
}

export interface AttachmentCapabilityOptions {
  readonly attachment: AnyAttachment;
  readonly adapter: StorageAdapter;
  readonly ledger: AttachmentLedger;
  readonly purgeOutbox: StoragePurgeOutbox;
  readonly purgeBackend: OutboxBackend;
  /** Required when the attachment declares variants. */
  readonly variants?: AttachmentVariantRuntime;
  /** Lifetime of a signed download URL; defaults to 15 minutes. */
  readonly signedUrlTtlMs?: number;
  readonly clock?: () => Date;
}

const DEFAULT_SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const VARIANT_CACHE_NAMESPACE = "ship-storage.variant";

/**
 * Builds the capability bound to `attachment.binding`. The executor calls
 * `withScope` once per run with the unit-of-work scope (or `undefined`
 * outside a transaction); the scoped view joins that transaction for
 * `attach` and `detach` and records purge intents through the purge outbox
 * in the same scope.
 */
export function createAttachmentCapability(
  options: AttachmentCapabilityOptions,
): AttachmentCapability {
  const { attachment, adapter, ledger } = options;
  const clock = options.clock ?? (() => new Date());
  const signedUrlTtlMs = options.signedUrlTtlMs ?? DEFAULT_SIGNED_URL_TTL_MS;
  const variantNames = new Set(Object.keys(attachment.variants));
  if (variantNames.size > 0 && !options.variants) {
    throw new AttachmentCapabilityError(
      "SHIP_ATTACHMENT_VARIANTS_UNCONFIGURED",
      `attachment ${JSON.stringify(attachment.id)} declares variants but the storage module has no variants configuration`,
      { attachmentId: attachment.id },
    );
  }

  const urlFor = async (key: string, expiresInMs: number | undefined): Promise<AttachmentUrl> => {
    if (attachment.visibility === "public") return Object.freeze({ url: adapter.publicUrl(key) });
    const expiresAt = new Date(clock().getTime() + (expiresInMs ?? signedUrlTtlMs));
    return Object.freeze({ url: await adapter.signDownload(key, { expiresAt }), expiresAt });
  };

  const readable = (object: AttachmentObject | undefined): AttachmentObject | undefined =>
    object && (object.status === "uploaded" || object.status === "attached") ? object : undefined;

  const cacheKey = (objectId: string, name: string): string =>
    `${VARIANT_CACHE_NAMESPACE}:${attachment.id}:${objectId}:${name}`;

  const withScope = (scope: object | undefined): ScopedAttachmentCapability => {
    const requireScope = (action: string): object => {
      if (scope === undefined) {
        throw new AttachmentCapabilityError(
          "SHIP_ATTACHMENT_SCOPE_REQUIRED",
          `${action} on attachment ${JSON.stringify(attachment.id)} requires a transaction: "write" operation so the ledger change and the purge intent commit with the owning record`,
          { attachmentId: attachment.id },
        );
      }
      return scope;
    };

    const detachInScope = async (
      transaction: object,
      ownerId: string,
      objectId: string | undefined,
    ): Promise<readonly AttachmentObject[]> => {
      const requestedAt = clock();
      const detached = await ledger.detach(transaction, {
        attachmentId: attachment.id,
        ownerId,
        ...(objectId !== undefined ? { objectId } : {}),
        requestedAt,
      });
      if (detached.length === 0) return detached;
      const writer = createOutboxWriter<StoragePurgeOutbox["intents"]>(
        options.purgeOutbox,
        options.purgeBackend,
        transaction,
        clock,
      );
      for (const object of detached) {
        await writer.enqueue(
          STORAGE_PURGE_INTENT_ID,
          { objectId: object.id },
          { dedupeKey: object.id },
        );
      }
      return detached;
    };

    const scoped: ScopedAttachmentCapability = {
      attachmentId: attachment.id,
      attach: async ({ ownerId, objectId }) => {
        const transaction = requireScope("attach");
        const existing = await ledger.listObjects(attachment.id, ownerId);
        if (attachment.cardinality === "single") {
          // A single field replaces its object: the previous one is purged
          // in the same transaction as the new binding.
          if (existing.some((object) => object.id === objectId)) {
            throw new AttachmentCapabilityError(
              "SHIP_ATTACHMENT_OBJECT_UNAVAILABLE",
              `object ${JSON.stringify(objectId)} is already attached`,
              { attachmentId: attachment.id, objectId },
            );
          }
          if (existing.length > 0) await detachInScope(transaction, ownerId, undefined);
        } else if (existing.length >= attachment.maxCount) {
          throw new AttachmentCapabilityError(
            "SHIP_ATTACHMENT_LIMIT_EXCEEDED",
            `owner ${JSON.stringify(ownerId)} already holds ${existing.length} of ${attachment.maxCount} ${attachment.id} objects`,
            { attachmentId: attachment.id, objectId },
          );
        }
        const attached = await ledger.attach(transaction, {
          attachmentId: attachment.id,
          ownerId,
          objectId,
          attachedAt: clock(),
        });
        if (!attached) {
          throw new AttachmentCapabilityError(
            "SHIP_ATTACHMENT_OBJECT_UNAVAILABLE",
            `object ${JSON.stringify(objectId)} is not an unattached upload of attachment ${JSON.stringify(attachment.id)}`,
            { attachmentId: attachment.id, objectId },
          );
        }
        return attached;
      },
      detach: async ({ ownerId, objectId }) =>
        detachInScope(requireScope("detach"), ownerId, objectId),
      list: (ownerId) => ledger.listObjects(attachment.id, ownerId),
      read: async (objectId) => {
        const object = await ledger.readObject(objectId);
        return object?.attachmentId === attachment.id ? object : undefined;
      },
      url: async (objectId, urlOptions) => {
        const object = readable(await ledger.readObject(objectId));
        if (!object || object.attachmentId !== attachment.id) return undefined;
        return urlFor(object.key, urlOptions?.expiresInMs);
      },
      variant: async (objectId, name, urlOptions): Promise<AttachmentVariantResolution | undefined> => {
        if (!variantNames.has(name)) {
          throw new AttachmentCapabilityError(
            "SHIP_ATTACHMENT_VARIANT_UNKNOWN",
            `attachment ${JSON.stringify(attachment.id)} declares no variant ${JSON.stringify(name)}`,
            { attachmentId: attachment.id, objectId },
          );
        }
        const runtime = options.variants as AttachmentVariantRuntime;
        const cached = runtime.cache
          ? ((await runtime.cache.get(cacheKey(objectId, name))) as AttachmentVariantObject | undefined)
          : undefined;
        if (cached) {
          return Object.freeze({
            status: "ready" as const,
            url: await urlFor(cached.key, urlOptions?.expiresInMs),
          });
        }
        const object = readable(await ledger.readObject(objectId));
        if (!object || object.attachmentId !== attachment.id) return undefined;
        const rendered = object.variants[name];
        if (rendered) {
          await runtime.cache?.set(cacheKey(objectId, name), rendered, { ttlMs: runtime.cacheTtlMs });
          return Object.freeze({
            status: "ready" as const,
            url: await urlFor(rendered.key, urlOptions?.expiresInMs),
          });
        }
        const enqueued = await runtime.enqueue(
          { objectId, variant: name },
          { dedupeKey: `${objectId}:${name}` },
        );
        if (!enqueued.accepted) {
          throw new AttachmentCapabilityError(
            "SHIP_ATTACHMENT_VARIANT_QUEUE_FULL",
            `variant ${JSON.stringify(name)} of ${JSON.stringify(objectId)} could not be queued: ${enqueued.rejected}`,
            { attachmentId: attachment.id, objectId },
          );
        }
        return Object.freeze({ status: "pending" as const });
      },
    };
    return Object.freeze(scoped);
  };

  return Object.freeze({
    kind: "ship.attachment-capability" as const,
    attachmentId: attachment.id,
    withScope,
  });
}
