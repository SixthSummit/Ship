# @sixthsummit/ship-storage

## 0.1.0

### Minor Changes

- b350b5d: Initial release of `@sixthsummit/ship-storage`: `defineStorageModule` mounts `ship-storage` with signed upload intents (`ship-storage.create-intent`), an actor-bound, provider-verified completion that is atomically fenced against the sweep (`ship-storage.complete`), the `ship-storage.sweep` single-runner job for abandoned intents and never-attached uploads, the `ship-storage.purge` outbox whose intents are recorded inside the consumer's write transaction by `detach()` and kept idempotent by a purge-ledger row, and the lazy `ship-storage.generate-variant` job backed by an injected `ImageProcessor` (`createSharpImageProcessor`) and the cache capability. Adapters: local disk with HMAC-signed URLs served by `createDiskStorageHandler` (`./disk`), S3-compatible with in-house Signature Version 4 over Web Crypto for AWS S3, Cloudflare R2 and MinIO (`./s3`), and Google Cloud Storage over an injected client (`./gcs`); `./hono` provides the HTTP transports.

### Patch Changes

- d86f629: The S3 adapter signs single-request uploads only and now says so: `createS3StorageAdapter({ maxSingleUploadBytes })` defaults to the 5 GiB single-PUT ceiling (`S3_MAX_SINGLE_UPLOAD_BYTES`) shared by AWS S3, Cloudflare R2 and MinIO, and `signUpload` refuses a declared size above it with a clear error instead of issuing a grant the provider would reject. The credential resolver and session-token support are documented.
- 63eef39: Require `zod` `^4.6.7` (GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections) and resolve `body-parser` to `2.4.0` under the MCP server's Express dependency (GHSA-27r3-jxmh-p828). No API change; the Angular library now runs its own suite against zod 4 and the Angular scaffold template asks for `zod ^4.6.7`.
