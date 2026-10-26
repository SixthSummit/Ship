# ADR-0022: Declare managed storage as an attachment capability with provider adapters, lazy variants and durable purge

- **Status:** Accepted
- **Date:** 2026-10-22
- **Scope:** Attachment declaration and diagnostics, the `StorageAdapter` and `AttachmentLedger` contracts, signed upload intents and completion fencing, the orphan sweep, image variants, the purge outbox and ledger, contract projection, the Angular upload client
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0010](./0010-declared-immediate-effects.md) · [ADR-0011](./0011-explicit-bounded-request-bodies.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md) · [ADR-0015](./0015-declared-jobs-and-schedules.md) · [ADR-0019](./0019-declared-read-cache.md)

## Context

The compatibility distribution ships `StorageService` adapters (disk, S3, GCS)
and a multipart parser. Everything above them is per application: a key
layout, a table that remembers which object belongs to which row, a cleanup
intent ledger so a deleted row's object is eventually removed, a fence so a
late upload completion does not resurrect an object the cleanup already
deleted, and a thumbnail pipeline. One consumer wrote that stack four times
for four photo fields and still has an open issue because nothing owns the
lifecycle of an object whose URL was cleared from its row. The second consumer
needs a profile picture and a PDF and is about to write it a fifth time.

Rails' Active Storage shows what a framework-owned lifecycle looks like:
`has_one_attached` on the model, direct uploads, variants and automatic purge
with no custom cleanup code. The kernel already has the primitives such a
lifecycle needs: operations with executable transaction scopes (ADR-0006),
declared immediate effects (ADR-0010), a durable outbox whose intents commit
with the business change (ADR-0014), declared jobs (ADR-0015) and a read
cache (ADR-0019). Managed storage should be declared with those primitives.

## Decision

### An attachment is a declaration on a module, used by operations

```ts
const photo = defineAttachment({
  id: "gallery.photo",            // namespaced by the owning module
  cardinality: "many",            // or "single"
  contentTypes: ["image/*"],      // wildcards allowed
  maxBytes: 10_000_000,
  visibility: "private",          // signed URLs; "public" has a stable URL
  maxCount: 24,
  variants: { thumb: { width: 320, height: 320, fit: "cover", format: "webp" } },
});
```

The owning module lists it in `attachments`. An operation that attaches,
detaches, lists or resolves objects declares `attachments: [photo]` and binds
`photo.binding`; the executor hands the handler a
`ScopedAttachmentCapability` bound to the running transaction. Declaring
without binding, binding without declaring, binding an attachment no module
declares, using one from a module that is not imported, or declaring an
attachment that no mounted storage module serves are compile diagnostics
(`SHIP_OPERATION_ATTACHMENT_UNBOUND`, `SHIP_OPERATION_ATTACHMENT_UNDECLARED`,
`SHIP_ATTACHMENT_UNDECLARED`, `SHIP_ATTACHMENT_IMPORT_REQUIRED`,
`SHIP_ATTACHMENT_STORAGE_MODULE_MISSING`), as are a duplicate or misnamed id
and a non-singleton capability provider. Variants on a non-image attachment
are rejected at definition time.

### Contracts live in the kernel; drivers live outside it

`StorageAdapter` (sign an upload, head, get, put, delete, sign a download,
public URL, health) and `AttachmentLedger` (intents, objects, purges) are
kernel contracts, like `CacheBackend` and `JobBackend`. The adapter is
deliberately narrow: direct uploads go to the provider through a signed PUT,
the framework reads whole objects only to derive variants, and `delete` of a
missing key is a success. `@sixthsummit/ship-storage` ships the local-disk
adapter (HMAC-signed URLs served by a fetch-style handler), an S3-compatible
adapter with in-house Signature Version 4 over Web Crypto (AWS S3, Cloudflare
R2, MinIO, no SDK) and a GCS adapter over an injected `@google-cloud/storage`
client. `@sixthsummit/ship-drizzle` ships the three tables and the ledger;
`@sixthsummit/ship-testing` ships in-memory twins and
`storageAdapterConformance`, which every adapter passes.

### Uploads are signed intents settled by a fenced completion

`defineStorageModule({ attachments, adapter, ledger, outbox, ... })` mounts
`ship-storage`:

- `ship-storage.create-intent` validates the declared content type and size,
  reserves a key `<attachmentId>/<intentId>`, records a `pending` intent with
  the caller's actor id and the declared `intentTtlMs`, and returns the
  provider's signed PUT. It is a `transaction: "none"` operation with the
  adapter as a declared immediate effect (ADR-0010).
- The client PUTs the bytes to the provider; the application server never
  buffers them (ADR-0011 stays for multipart bodies an application still wants
  to accept itself).
- `ship-storage.complete` is callable only by the actor who created the
  intent. It asks the provider for the object's size and content type, refuses
  a mismatch (`UPLOAD_REJECTED`, deleting the bytes) or a missing object
  (`UPLOAD_MISSING`), and moves the intent to `completed` and the object to
  `uploaded` in one ledger transaction. An intent that is expired, already
  completed or abandoned answers `INTENT_EXPIRED` and deletes whatever the
  client uploaded late. The atomic `completeIntent` is the fence: the sweep
  and a late completion cannot both win.

### Abandoned uploads are swept, never trusted

`ship-storage.sweep` is a keyed single-runner job (ADR-0015). Each pass claims
pending intents past expiry with `FOR UPDATE SKIP LOCKED`, marks them
`abandoned` and deletes their keys (the key is reserved for that intent alone,
so the delete is always safe), then claims `uploaded` objects older than the
unattached grace period and purges them. Two sweepers never abandon one intent
twice; an abandoned intent cannot complete.

### Attach and detach are transactional; purge is a durable intent

`attach({ ownerId, objectId })` and `detach({ ownerId, objectId? })` run only
inside a `transaction: "write"` operation; outside one they fail with
`SHIP_ATTACHMENT_SCOPE_REQUIRED`. The ledger change joins the operation's
unit of work (ADR-0006). `detach` marks the objects `purging`, writes one
purge-ledger row per object listing every key (the original and every
rendered variant) and records one `purge-object` intent per object through the
framework-owned `ship-storage.purge` outbox **in the same transaction**
(ADR-0014). Deleting the owning row and detaching in one write operation is
therefore atomic with the purge intent: a rollback leaves no intent and no
`purging` row.

The dispatcher performs the purge afterwards through the `StoragePurger`
effect: it reads the purge row, deletes every key, and marks the row. A
replayed intent finds the row marked and does nothing, so at-least-once
delivery is safe. A `single` attachment replaces its object on `attach`, and
the previous object's purge commits with the new binding.

### Variants are rendered lazily through jobs and remembered through the cache

`variant(objectId, name)` answers `ready` with a URL when the ledger (or the
cache capability, ADR-0019) already knows the rendered key, and otherwise
enqueues `ship-storage.generate-variant` with a dedupe key and answers
`pending`. The job reads the original, renders through an injected
`ImageProcessor` (`createSharpImageProcessor(sharp)`; the package carries no
native dependency), stores the derivative under `<key>/variants/<name>.<ext>`,
records it on the object and warms the cache. Variants belong to the object:
the purge row lists them and the purge removes them together.

### The contract carries the policy and nothing provider-shaped

The graph gains `attachments` nodes (policy, provider id, operations that bind
them); the client manifest gains `attachments` keyed by id with cardinality,
content types, size, visibility, count and variant names, and each operation
lists the attachment ids it binds. The provider, key layout, ledger binding
and intent TTL are never projected. `ApplicationContractOf` types the
attachment ids and variant names so a client cannot request an undeclared
variant.

### The Angular client drives the whole flow

`@sixthsummit/ship-angular/storage` adds `createAttachmentUpload(client, {
attachment, policy }, { allowedProviderOrigins })`: validate against the
policy read from the manifest, obtain the intent, PUT with progress through
the existing signed-upload lifecycle, settle through completion, and expose
the settled `object` for the application's own attach operation. The origin
allowlist is required; a signed destination outside it never receives bytes.

## Consequences

- An application declares what may be uploaded and binds a capability; it
  writes no key layout, no cleanup ledger, no late-completion fence and no
  thumbnail pipeline. The second consumer's profile picture and PDF are two
  declarations.
- Object lifecycle is reviewable: the graph shows which operations bind which
  attachment, the contract shows the policy, and `inspect` shows the purge
  outbox and the sweep like any other durable work.
- Purge is eventual and at-least-once. Between commit and dispatch the object
  still exists at the provider; the ledger already says `purging`, so URLs
  are no longer issued for it.
- The sweep and the purge dispatcher must run. An application that mounts the
  module without a job runtime or an outbox runner accumulates `pending`
  intents and `purging` rows until one starts; `health()` on the ledger
  reports owed purges.
- Variants are rendered after the first request, so the first viewer sees the
  original (or a placeholder the application chooses) until the job runs.
- Mounting the module introduces `ship.outbox:manage` for the purge
  dead-letter operations and requires a `LockProvider` for the sweep.
- Object ids are unguessable UUIDs and completion is actor-bound, but
  `attach` trusts the handler's `ownerId`: tenant isolation is the
  application's authorization, folded into the owner id as the golden consumer
  does (`<tenantId>/<projectId>`).
- The compatibility `StorageService`, `parseUpload` and `fileSchema` are
  untouched.

## Rejected alternatives

### Proxy uploads through the application server

Rejected. Buffering bytes in the operation ties upload size to request body
limits and process memory, and every provider already supports signed direct
uploads. Multipart operations remain available for applications that want the
bytes in the handler.

### Purge in an after-commit callback or in the delete handler

Rejected, reaffirming ADR-0010 and ADR-0014. A process that dies between
commit and callback leaves an object nobody will ever delete and no record
that a delete was owed; a provider delete inside the transaction deletes
bytes for a change that may roll back.

### Let the provider own the lifecycle (bucket lifecycle rules, object tags)

Rejected as the primary mechanism. Lifecycle rules are coarse, provider
specific and invisible to the graph; a tag-based expiry cannot know whether a
row still references the object. Applications may add them as a safety net.

### Render variants at completion time

Rejected. Every declared variant would be rendered for every upload whether or
not it is viewed, inside the completion request. Lazy rendering through the
jobs capability keeps completion fast and renders only what is requested;
applications that want eager rendering enqueue the job from their attach
operation.

### A capability that takes the transaction as an argument

Rejected. Passing `services.tx` into every call is easy to forget and
impossible for the compiler to check. The executor already knows the scope and
binds outbox writers to it; attachment capabilities use the same seam.

### An attachment column type on the entity

Rejected. The kernel has no entity model to add a column type to (ADR-0007);
the ledger owns the association and the owner id is the application's own key.
