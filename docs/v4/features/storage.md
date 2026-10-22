# Managed storage

Declared attachments, signed direct uploads, lazy image variants and durable
purge for operation applications, plus the compatibility `StorageService`
adapters the monolithic package still ships.

> **Target architecture:** the first half of this page describes the
> `attachment` capability ([ADR-0022](../../rearchitecture/decisions/0022-declared-managed-storage.md))
> for `@sixthsummit/ship-core` applications. The second half documents the
> compatibility adapters and applies only to `@sixthsummit/ship-api` code.

## Declaring an attachment

An attachment is a field on a module's entity contract: how many objects an
owner holds, what may be uploaded, how large, who may read it and which image
derivatives exist. It names no provider.

```ts
import { defineAttachment } from "@sixthsummit/ship-core";

export const projectPhoto = defineAttachment({
  id: "portfolio.photo",            // <moduleId>.<field>
  cardinality: "many",              // or "single"
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5_000_000,
  visibility: "private",            // short-lived signed URLs; "public" has a stable URL
  maxCount: 12,                     // many only; defaults to 1000
  intentTtlMs: 15 * 60 * 1000,      // how long a signed upload stays valid
  variants: { thumb: { width: 320, height: 320, fit: "cover", format: "webp" } },
});
```

The owning module lists it:

```ts
defineModule({
  id: "portfolio",
  operations: [attachPhoto, removePhoto, listPhotos],
  imports: ["ship-storage"],
  attachments: [projectPhoto],
  // ...
});
```

Definition-time diagnostics (`InvalidAttachmentDefinitionError`): an id without
a module prefix, an empty or malformed content-type list, a non-positive size,
`maxCount` on a `single` attachment or outside `1..1000`, a variant without a
width or height, and `variants` on an attachment whose content types are not
all images (`SHIP_ATTACHMENT_VARIANT_CONTENT_TYPE_INVALID`).

## Using an attachment from an operation

An operation declares the attachments it touches and binds each one's
`binding` token. The executor hands the handler a capability scoped to the
running transaction.

```ts
const attachPhoto = defineOperation({
  id: "portfolio.attach-photo",
  transport: http.post("/tenants/:tenantId/projects/:projectId/photos"),
  input: { params: projectParams, body: z.object({ objectId: z.string().uuid() }) },
  output: { 201: z.object({ objectId: z.string(), count: z.number().int() }) },
  successStatus: 201,
  errors: [tenantAccessDenied, photoUnavailable, photoLimitReached],
  access: permission("portfolio:write"),
  transaction: "write",
  dependencies: { tx: portfolioUnitOfWork, photos: projectPhoto.binding },
  attachments: [projectPhoto],
  handler: async ({ input, services, context }) => {
    const scope = await authorizeTenant(input.params.tenantId, context);
    const ownerId = `${scope.tenantId}/${input.params.projectId}`;
    try {
      const object = await services.photos.attach({ ownerId, objectId: input.body.objectId });
      return { objectId: object.id, count: (await services.photos.list(ownerId)).length };
    } catch (error) {
      if (error instanceof AttachmentCapabilityError) {
        throw operationFailure(
          error.code === "SHIP_ATTACHMENT_LIMIT_EXCEEDED" ? photoLimitReached : photoUnavailable,
        );
      }
      throw error;
    }
  },
});
```

The scoped capability:

| Method | Transaction | Meaning |
| --- | --- | --- |
| `attach({ ownerId, objectId })` | `write` | Binds a completed, unattached object to an owner. A `single` attachment replaces and purges the previous object; a `many` attachment refuses past `maxCount`. |
| `detach({ ownerId, objectId? })` | `write` | Marks one or every object of the owner `purging` and records one durable purge intent per object in the same transaction. |
| `list(ownerId)` | any | Attached objects, oldest first. |
| `read(objectId)` | any | One object of this attachment. |
| `url(objectId, { expiresInMs? })` | any | Signed (private) or stable (public) URL for the original; `undefined` once the object is purging or purged. |
| `variant(objectId, name, { expiresInMs? })` | any | `{ status: "ready", url }` when rendered, `{ status: "pending" }` after enqueueing the render job. |

`attach` and `detach` outside a write transaction throw
`AttachmentCapabilityError` with `SHIP_ATTACHMENT_SCOPE_REQUIRED`; the ledger
change and the purge intent must commit with the owning record. The capability
never authorizes: fold the authentic tenant into `ownerId` and check access in
the operation as with any repository.

Compile diagnostics (`defineApp`):

| Code | Meaning |
| --- | --- |
| `SHIP_OPERATION_ATTACHMENT_UNBOUND` | `attachments` lists an attachment whose `binding` is not in `dependencies`. |
| `SHIP_OPERATION_ATTACHMENT_UNDECLARED` | `dependencies` binds an attachment missing from `attachments`. |
| `SHIP_ATTACHMENT_UNDECLARED` | No module declares the attachment instance. |
| `SHIP_ATTACHMENT_IMPORT_REQUIRED` | The owning module is not imported. |
| `SHIP_ATTACHMENT_ID_DUPLICATE` / `SHIP_ATTACHMENT_MODULE_ID_MISMATCH` | Two owners, or an id not prefixed by its module. |
| `SHIP_ATTACHMENT_STORAGE_MODULE_MISSING` | The attachment is declared but no `defineStorageModule` lists it, so nothing can be uploaded to it. |
| `SHIP_ATTACHMENT_PROVIDER_LIFETIME_INVALID` | A capability provider is not a singleton. |

## Mounting the storage module

`@sixthsummit/ship-storage` provides the module every attachment is served by.
Mount it once:

```ts
import { defineStorageModule, defineStoragePurgeOutbox } from "@sixthsummit/ship-storage";
import { createGcsStorageAdapter } from "@sixthsummit/ship-storage/gcs";
import { createSharpImageProcessor } from "@sixthsummit/ship-storage/image";
import { storageHttpTransports } from "@sixthsummit/ship-storage/hono";
import { createDrizzleAttachmentLedger, createDrizzleOutbox } from "@sixthsummit/ship-drizzle";

const storage = defineStorageModule({
  attachments: [projectPhoto],
  adapter: createGcsStorageAdapter({ client: new Storage(), bucket: env.bucket }),
  ledger: createDrizzleAttachmentLedger({ database }),
  outbox: createDrizzleOutbox({ outbox: defineStoragePurgeOutbox(), database }),
  transports: storageHttpTransports({ basePath: "/storage" }),
  variants: { processor: createSharpImageProcessor(sharp), jobs: jobBackend, cache },
  sweep: { trigger: { kind: "interval", everyMs: 5 * 60_000 }, unattachedGraceMs: 24 * 60 * 60_000 },
  access: authenticatedAccess(),   // intent + completion; default
});
```

It mounts, under module id `ship-storage`:

- `ship-storage.create-intent` (`POST /storage/intents`): validates the
  declared content type and size, reserves `<attachmentId>/<intentId>`,
  records a pending intent for the caller and returns the provider's signed
  PUT (`{ intentId, objectKey, upload: { url, method, headers }, expiresAt }`).
  Errors: `ATTACHMENT_UNKNOWN` 404, `ATTACHMENT_CONTENT_TYPE_REJECTED` 415,
  `ATTACHMENT_TOO_LARGE` 413.
- `ship-storage.complete` (`POST /storage/intents/:intentId/complete`):
  callable only by the intent's actor (`INTENT_FORBIDDEN` 403). Verifies the
  stored object through the adapter (`UPLOAD_MISSING` 409; a size or type
  mismatch is `UPLOAD_REJECTED` 422 and deletes the bytes) and atomically
  completes the intent and creates the `uploaded` object. An expired,
  abandoned or already settled intent answers `INTENT_EXPIRED` 410 and
  deletes whatever arrived late: a sweep and a late completion can never both
  win.
- `ship-storage.sweep`: a keyed single-runner job that abandons pending
  intents past expiry (deleting their reserved keys) and purges `uploaded`
  objects never attached within `unattachedGraceMs`. It needs the
  application's `JobBackend` and `LockProvider` like any declared job.
- `ship-storage.purge` outbox with `ship-storage.purge.dispatch`, its
  dead-letter operations (`ship.outbox:manage`) and `ship-storage.purge.cleanup`.
  Each `purge-object` intent deletes every key the purge row lists and marks
  the row; a replay is a no-op.
- `ship-storage.generate-variant` when `variants` is configured: renders one
  declared variant through the injected `ImageProcessor`, stores it under
  `<key>/variants/<name>.<ext>`, records it on the object and warms the cache.

Variants are required at mount time when any listed attachment declares them
(`SHIP_STORAGE_MODULE_OPTIONS_INVALID`). The image processor is injected so the
package has no native dependency; `createPassthroughImageProcessor()` exists for
tests.

## Adapters

| Entry | Adapter | Notes |
| --- | --- | --- |
| `@sixthsummit/ship-storage/disk` | `createDiskStorageAdapter({ rootDir, baseUrl, secret })` | Development and tests. HMAC-signed upload and download URLs beneath `baseUrl`; serve them with `createDiskStorageHandler(adapter)`, for example `app.all("/storage/*", (c) => handler(c.req.raw))`. The handler enforces the signed content type, size and expiry. Keys cannot escape `rootDir`. |
| `@sixthsummit/ship-storage/s3` | `createS3StorageAdapter({ bucket, region, credentials, endpoint?, forcePathStyle?, publicBaseUrl? })` | AWS S3, Cloudflare R2 (`region: "auto"`, R2 endpoint) and MinIO. In-house Signature Version 4 over Web Crypto; no SDK. Presigned PUTs bind the content type; completion re-checks size and type. |
| `@sixthsummit/ship-storage/gcs` | `createGcsStorageAdapter({ client, bucket, publicBaseUrl? })` | Google Cloud Storage over an injected `@google-cloud/storage` client (V4 signed URLs). |
| `@sixthsummit/ship-testing/storage` | `createInMemoryStorageAdapter()`, `createInMemoryAttachmentLedger()` | Unit tests. The in-memory adapter redeems its own grants through `upload(url, bytes, headers)`. |

Every adapter passes `storageAdapterConformance(createAdapter, { performUpload? })`
from `@sixthsummit/ship-testing/storage`; run it against a new adapter before
binding it.

## Tables and the release step

Include the ledger tables in the application's own schema and migrations:

```ts
import {
  shipStorageIntentsTable,
  shipStorageObjectsTable,
  shipStoragePurgesTable,
} from "@sixthsummit/ship-drizzle";

export const storageIntents = shipStorageIntentsTable();
export const storageObjects = shipStorageObjectsTable();
export const storagePurges = shipStoragePurgesTable();
```

Generate the migration with `drizzle-kit generate` and apply it as a gated
release step. Nothing is migrated at boot, and the tables are only ever added
to: `ship_storage_objects` retains `purged` rows as an audit trail until the
application's own retention removes them. Purge intents share the outbox
table (`shipOutboxTable()`) with every other outbox, partitioned by
`outbox_id`.

## Running the lifecycle

- **Sweep:** schedule through `startJobRuntime`; the default trigger is every
  five minutes. Prove it on an environment by creating an intent, not
  completing it, and watching the intent row move to `abandoned` after
  `intentTtlMs`.
- **Purge:** drive `ship-storage.purge.dispatch` with
  `startOutboxDispatchRunner(executor, "ship-storage.purge.dispatch")` or a
  dispatch job, exactly like the cache-invalidation outbox. Purge is eventual
  and at-least-once; the purge-ledger row makes replays idempotent.
- **Health:** `ledger.health()` reports owed purges; `adapter.health()`
  reports provider reachability.

## Contract and clients

The client manifest carries the policy and nothing provider-shaped:

```json
"attachments": {
  "portfolio.photo": {
    "cardinality": "many",
    "contentTypes": ["image/jpeg", "image/png", "image/webp"],
    "maxBytes": 5000000,
    "visibility": "private",
    "maxCount": 12,
    "variants": ["thumb"]
  }
}
```

Each operation lists the attachment ids it binds, and
`ApplicationContractOf<typeof app>["attachments"]` types ids and variant names.

Angular: `@sixthsummit/ship-angular/storage`.

```ts
import {
  attachmentPolicyFromManifest,
  createAttachmentUpload,
} from "@sixthsummit/ship-angular/storage";

const upload = createAttachmentUpload(
  client,
  { attachment: "portfolio.photo", policy: attachmentPolicyFromManifest(manifest, "portfolio.photo") },
  { allowedProviderOrigins: ["https://storage.googleapis.com"] },
);
await upload.start(file);            // validate, intent, PUT with progress, complete
const object = upload.object();      // { objectId, objectKey, contentType, size }
await client.call("portfolio.attach-photo", { params, body: { objectId: object.objectId } });
```

`status`, `pending`, `progress`, `result`, `error` and `intent` are signals;
`cancel()` aborts the transfer. The provider-origin allowlist is required.

## Compatibility adapters (`@sixthsummit/ship-api`)

> **Compatibility feature:** these storage services remain available from the
> monolithic v4 package. New operation applications declare attachments as
> described above.

The `StorageService` interface, the three adapters that ship (Disk / S3 / GCS), key-prefix scoping for multi-tenancy, signed URLs, and what each backend gets right and wrong.

### The interface

```ts
type StorageBody = Buffer | Uint8Array | ReadableStream | Blob | File;

interface StorageObjectMeta {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
  metadata?: Record<string, string>;
}

interface StorageService {
  put(key: string, body: StorageBody, opts?: PutOptions): Promise<StorageObjectMeta>;
  get(key: string): Promise<GetResult | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix?: string, opts?: ListOptions): Promise<ListResult>;
  signedUrl?(key: string, opts?: SignedUrlOptions): Promise<string>;
}
```

`signedUrl` is optional — `DiskStorageAdapter` doesn't implement it (no built-in file server, and writing an ad-hoc one risks public-read exposure). The two cloud adapters do.

### Disk — local development

```ts
import { DiskStorageAdapter } from "@sixthsummit/ship-api/app/services/storage/DiskStorageAdapter";

const storage = new DiskStorageAdapter({ rootDir: "/var/uploads" });

await storage.put("avatars/123.png", buffer, { contentType: "image/png" });
const result = await storage.get("avatars/123.png");
// result.body is a ReadableStream; result.meta is StorageObjectMeta
```

Stores objects at `<rootDir>/<key>` with metadata in a sibling `.meta.json`
file. Keys with `..` segments throw before any FS call, and the adapter
validates the resolved path stays inside `rootDir`. There is no `signedUrl`;
mount the directory behind an authenticated route rather than exposing it.

### S3 and GCS — production

`S3StorageAdapter({ client, bucket, keyPrefix? })` and
`GCSStorageAdapter({ bucket, keyPrefix? })` wrap the official SDK clients.
`keyPrefix` scopes every key (for example per tenant) and `signedUrl` issues
time-limited GET or PUT URLs. The compatibility adapters do not own an object
lifecycle: cleanup, orphan handling and variants remain application code,
which is what the managed capability above replaces.
