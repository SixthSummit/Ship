# @sixthsummit/ship-storage

Declared managed storage for Ship applications. An application declares an
`attachment` field (single or many objects, accepted content types, size,
visibility, image variants); this package supplies the module that issues
signed direct-to-bucket upload intents, settles completions, sweeps abandoned
intents, renders variants lazily and purges objects durably when the owning
record is deleted or the field is cleared.

```ts
import { defineAttachment } from "@sixthsummit/ship-core";
import { defineStorageModule } from "@sixthsummit/ship-storage";
import { createGcsStorageAdapter } from "@sixthsummit/ship-storage/gcs";
import { storageHttpTransports } from "@sixthsummit/ship-storage/hono";
import { createDrizzleAttachmentLedger, createDrizzleOutbox } from "@sixthsummit/ship-drizzle";

export const galleryPhoto = defineAttachment({
  id: "gallery.photo",
  cardinality: "many",
  contentTypes: ["image/jpeg", "image/png", "image/webp"],
  maxBytes: 10_000_000,
  visibility: "private",
  maxCount: 24,
  variants: { thumb: { width: 320, height: 320, fit: "cover", format: "webp" } },
});

const storage = defineStorageModule({
  attachments: [galleryPhoto],
  adapter: createGcsStorageAdapter({ client: new Storage(), bucket: env.bucket }),
  ledger: createDrizzleAttachmentLedger({ database }),
  outbox: createDrizzleOutbox({ outbox: purgeOutbox, database }),
  transports: storageHttpTransports({ basePath: "/storage" }),
  variants: { processor: createSharpImageProcessor(sharp), jobs: jobBackend, cache },
  imports: ["platform"],
});
```

A consumer operation binds `galleryPhoto.binding`, declares
`attachments: [galleryPhoto]`, and calls `services.photos.attach({ ownerId,
objectId })` or `services.photos.detach({ ownerId })` inside a
`transaction: "write"` operation. The ledger change and the purge intent commit
with the owning record; the `ship-storage.purge` dispatcher deletes the
provider objects afterwards and the purge ledger makes replays no-ops.

Adapters: `./disk` (development; signed URLs served by
`createDiskStorageHandler`), `./s3` (AWS S3, Cloudflare R2, MinIO; in-house
SigV4, no SDK, static or resolver credentials, single-request uploads up to
5 GiB), `./gcs` (Google Cloud Storage through an injected
`@google-cloud/storage` client). `@sixthsummit/ship-testing/storage` ships an
in-memory adapter and ledger plus `storageAdapterConformance`.

Tables (`shipStorageIntentsTable`, `shipStorageObjectsTable`,
`shipStoragePurgesTable`) are included in the application's own migrations as a
release step; nothing runs at boot. The Angular `/storage` entrypoint drives the
intent, PUT-with-progress and completion flow from the client contract.

See `docs/v4/features/storage.md` and ADR-0022 in the repository for the full
design, diagnostics and operational guidance.
