import {
  type AttachmentLedger,
  type DependencyToken,
  defineOutbox,
  dependency,
  type EffectDependencyToken,
  effectDependency,
  type OutboxRetention,
  objectSchema,
  outboxIntent,
  type StorageAdapter,
  stringSchema,
} from "@sixthsummit/ship-core";
import type { ImageProcessor } from "./image.js";

/** The fixed id of the framework-owned purge outbox. */
export const STORAGE_PURGE_OUTBOX_ID = "ship-storage.purge";
/** The single purge intent: delete every key of one object. */
export const STORAGE_PURGE_INTENT_ID = "purge-object";
/** The dispatcher operation every runner executes for owed purges. */
export const STORAGE_PURGE_DISPATCH_OPERATION_ID = `${STORAGE_PURGE_OUTBOX_ID}.dispatch`;
/** The job that abandons expired intents and purges uploads never attached. */
export const STORAGE_SWEEP_JOB_ID = "ship-storage.sweep";
/** The job that renders one declared variant of one object. */
export const STORAGE_VARIANT_JOB_ID = "ship-storage.generate-variant";
/** The operation a client calls to obtain a signed upload. */
export const STORAGE_CREATE_INTENT_OPERATION_ID = "ship-storage.create-intent";
/** The operation a client calls after the provider accepted the PUT. */
export const STORAGE_COMPLETE_OPERATION_ID = "ship-storage.complete";

export const DEFAULT_PURGE_RETENTION: OutboxRetention = Object.freeze({
  completedMs: 7 * 24 * 60 * 60 * 1000,
  deadLetteredMs: 30 * 24 * 60 * 60 * 1000,
});

/** The provider adapter as an immediate effect: signing, head, put and delete leave the process. */
export const storageAdapterEffect: EffectDependencyToken<StorageAdapter> =
  effectDependency<StorageAdapter>("ship-storage.adapter", { delivery: "immediate" });

/** The ledger is a database capability, not an effect: it is read and written autonomously. */
export const storageLedgerDependency: DependencyToken<AttachmentLedger> =
  dependency<AttachmentLedger>("ship-storage.ledger");

/** The image encoder the variant job renders through. */
export const storageImageProcessorEffect: EffectDependencyToken<ImageProcessor> =
  effectDependency<ImageProcessor>("ship-storage.image-processor", { delivery: "immediate" });

export type StoragePurgeOutcome = "purged" | "already-purged" | "unknown";

/**
 * Performs one owed purge: deletes every key the purge row lists and marks
 * the row. Replays find the row marked and do nothing, so at-least-once
 * delivery of the intent is safe.
 */
export interface StoragePurger {
  readonly kind: "ship.storage-purger";
  purge(objectId: string): Promise<StoragePurgeOutcome>;
}

export const storagePurgeEffect: EffectDependencyToken<StoragePurger> =
  effectDependency<StoragePurger>("ship-storage.purger", { delivery: "immediate" });

export function createStoragePurger(options: {
  readonly adapter: StorageAdapter;
  readonly ledger: AttachmentLedger;
  readonly clock?: () => Date;
}): StoragePurger {
  const clock = options.clock ?? (() => new Date());
  return Object.freeze({
    kind: "ship.storage-purger" as const,
    purge: async (objectId: string) => {
      const purge = await options.ledger.readPurge(objectId);
      if (!purge) return "unknown";
      if (purge.purgedAt) return "already-purged";
      for (const key of purge.keys) await options.adapter.delete(key);
      return (await options.ledger.markPurged(objectId, clock())) ? "purged" : "already-purged";
    },
  });
}

export const storagePurgePayloadSchema = objectSchema({
  objectId: stringSchema({ minLength: 1 }),
});

/**
 * Framework-owned durable outbox for object purges. `detach()` records one
 * intent per object inside the consumer's write transaction, so the intent
 * commits or rolls back with the owning record; the dispatcher deletes the
 * provider objects afterwards. Deletion is eventual and at-least-once.
 */
export function defineStoragePurgeOutbox(retention: OutboxRetention = DEFAULT_PURGE_RETENTION) {
  return defineOutbox({
    id: STORAGE_PURGE_OUTBOX_ID,
    retention,
    intents: {
      [STORAGE_PURGE_INTENT_ID]: outboxIntent({
        payload: storagePurgePayloadSchema,
        effect: storagePurgeEffect,
        perform: async ({ effect, payload }) => {
          await effect.purge(payload.objectId);
        },
      }),
    },
  });
}

export type StoragePurgeOutbox = ReturnType<typeof defineStoragePurgeOutbox>;
