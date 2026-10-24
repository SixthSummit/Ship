---
"@sixthsummit/ship-storage": patch
---

The S3 adapter signs single-request uploads only and now says so: `createS3StorageAdapter({ maxSingleUploadBytes })` defaults to the 5 GiB single-PUT ceiling (`S3_MAX_SINGLE_UPLOAD_BYTES`) shared by AWS S3, Cloudflare R2 and MinIO, and `signUpload` refuses a declared size above it with a clear error instead of issuing a grant the provider would reject. The credential resolver and session-token support are documented.
