# Storage adapters

> **Compatibility feature:** these storage services remain available from the
> monolithic v4 package. New operation applications introduce storage through an
> explicit narrow capability and declare any external effect.

The `StorageService` interface, the three adapters that ship (Disk / S3 / GCS), key-prefix scoping for multi-tenancy, signed URLs, and what each backend gets right and wrong.

## The interface

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

## Disk — local development

```ts
import { DiskStorageAdapter } from "@sixthsummit/ship-api/app/services/storage/DiskStorageAdapter";

const storage = new DiskStorageAdapter({
  rootDir: "/var/uploads",
});

await storage.put("avatars/123.png", buffer, { contentType: "image/png" });
const result = await storage.get("avatars/123.png");
// result.body is a ReadableStream; result.meta is StorageObjectMeta
```

Stores objects at `<rootDir>/<key>`. Metadata (contentType, cacheControl, user metadata) lives in a sibling `.meta.json` file:

```
/var/uploads/avatars/123.png
/var/uploads/avatars/123.png.meta.json
```

**Path traversal is blocked.** Keys with `..` segments throw before any FS call. The adapter resolves relative to `rootDir` and validates the result stays inside.

**No `signedUrl`.** For local dev where you need browser-accessible files, mount the `rootDir` behind an authenticated route — don't expose it publicly. A pattern:

```ts
app.get("/uploads/*", requireAuth({ provider }), async (c) => {
  const key = c.req.path.replace(/^\/uploads\//, "");
  const result = await storage.get(key);
  if (!result) throw new NotFoundError();
  return new Response(result.body, {
    headers: { "Content-Type": result.meta.contentType ?? "application/octet-stream" },
  });
});
```

## S3 — production

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { S3StorageAdapter } from "@sixthsummit/ship-api/app/services/storage/S3StorageAdapter";

const client = new S3Client({ region: "us-east-1" });
const storage = new S3StorageAdapter({
  client,
  bucket: env.S3_BUCKET,
  keyPrefix: `tenant:${tenantId}/`,    // optional, see "Key prefixing" below
});
```

The `@aws-sdk/client-s3` package is an **optional peer dependency** — the framework declares it but doesn't install. Consumers `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` themselves. Apps that don't use S3 don't ship the SDK.

**Streaming.** `put` accepts streams; `get` returns a `ReadableStream` body. Large files don't buffer in memory.

**Signed URLs.**

```ts
const url = await storage.signedUrl!("avatars/123.png", {
  expiresInSec: 900,                  // default 900 (15 min)
  method: "GET",                      // default
});

// PUT URL for direct browser uploads:
const uploadUrl = await storage.signedUrl!("avatars/123.png", {
  method: "PUT",
  contentType: "image/png",           // required for PUT URLs — included in signature
  expiresInSec: 60,
});
```

`method: "PUT"` URLs require `contentType` because the AWS signing protocol includes it. The browser doing the upload **must** send the same `Content-Type` header or S3 rejects the request with a signature mismatch.

## GCS — Google Cloud Storage

```ts
import { Storage } from "@google-cloud/storage";
import { GCSStorageAdapter } from "@sixthsummit/ship-api/app/services/storage/GCSStorageAdapter";

const bucket = new Storage().bucket(env.GCS_BUCKET);
const storage = new GCSStorageAdapter({ bucket });
```

Same interface as S3. Same opt-in install (`@google-cloud/storage` is a peer dep).

**Resumable uploads.** Files larger than ~5 MB use GCS's resumable upload protocol — handles network interruptions without restarting. Smaller files use a simple `file.save()` call.

**V4 signed URLs.** GCS's V4 signing requires a service account with the `iam.serviceAccountTokenCreator` role on itself for URL signing. If signed URL generation fails with `SIGN_KEY_NOT_FOUND`, that's the missing role.

```ts
const url = await storage.signedUrl!("avatars/123.png", {
  expiresInSec: 3600,
  method: "GET",
});
```

For PUT URLs, `contentType` is included in the signature (same constraint as S3).

## Key prefixing — multi-tenant scoping

Every adapter accepts a `keyPrefix` option. Keys you pass are prefixed transparently; keys returned to you have the prefix stripped:

```ts
const tenantStorage = new S3StorageAdapter({
  client,
  bucket: "shared-bucket",
  keyPrefix: `tenant:${tenantId}/`,
});

await tenantStorage.put("avatar.png", buffer);
// Stored at: tenant:abc123/avatar.png in the bucket

await tenantStorage.list();
// Returns keys without the tenant: prefix — caller works in their tenant's namespace
```

This is how multi-tenant apps reuse a single bucket safely. Each tenant's storage instance gets its own prefix; the application code is unaware of the prefix and can't accidentally cross-read.

For higher isolation (compliance, blast-radius), use one bucket per tenant. For most multi-tenant apps, the prefix is enough — bucket-per-tenant adds operational overhead (IAM, lifecycle policies, billing tags) that's rarely worth it.

## MIME validation lives elsewhere

The storage adapters accept whatever `contentType` you pass to `put()`. Validation against an allowed-list is the **upload route's** responsibility, not the storage adapter's:

```ts
import { parseUpload, fileSchema } from "@sixthsummit/ship-api";

const schema = z.object({
  avatar: fileSchema({
    maxBytes: 5_000_000,
    mimeTypes: ["image/png", "image/jpeg"],
  }),
});

app.post("/avatar", async (c) => {
  const body = await parseUpload(c, schema);
  // body.avatar.type is validated by file-type's magic-byte detection
  await storage.put(`avatars/${user.id}`, body.avatar, { contentType: body.avatar.type });
});
```

See [uploads](uploads.md) for `parseUpload` and `fileSchema`. The split is deliberate: validation is application policy; storage is infrastructure.

## Pagination

```ts
let token: string | undefined;
do {
  const page = await storage.list("uploads/", { maxKeys: 100, continuationToken: token });
  for (const obj of page.objects) {
    // process
  }
  token = page.nextContinuationToken;
} while (token);
```

`maxKeys` defaults to 1000 (the AWS / GCS default). Continuation tokens are opaque — pass them back unchanged.

## Choosing an adapter

|  | Disk | S3 | GCS |
| --- | :---: | :---: | :---: |
| Local dev | Yes | Optional (LocalStack) | Optional (fake-gcs-server) |
| Production | No | Yes | Yes |
| Signed URLs | No | Yes | Yes |
| Streaming uploads | Buffered | Yes | Yes (resumable >5 MB) |
| Multi-tenant via prefix | Yes | Yes | Yes |
| Cost model | Disk + ops | Per-GB + requests | Per-GB + requests |

Most teams use Disk in dev/test (`docker-compose` mounts a volume), S3 or GCS in prod. The local LocalStack and fake-gcs-server containers exist for tests that need to exercise the cloud adapters; the framework's integration test harness wires both up.

## Operational concerns

**Lifecycle rules go on the bucket, not in code.** S3 lifecycle policies for transitioning to Glacier, GCS object lifecycle management — configure these on the bucket itself. The adapter's job is reads and writes; archival is the bucket's job.

**Signed URL TTLs are tradeoffs.** Long TTLs (hours) are convenient but mean a leaked URL stays exploitable. Short TTLs (minutes) are safer but require the consumer to re-fetch the URL when they need it. Default 15 minutes is a reasonable middle.

**Large file uploads benefit from PUT URLs.** Routing an upload through your server consumes bandwidth and memory; a PUT signed URL lets the browser upload directly to the storage backend. The handler returns the URL; the client PUTs to it; the handler hears about completion via S3 / GCS notifications or a follow-up "I'm done" call.

**Disk adapter can't survive multi-replica.** Each pod has its own disk; writes don't propagate. Use `docker-compose` shared volumes for local dev only.

## Source

- [`packages/core/src/app/services/storage/StorageService.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/storage/StorageService.ts) — interface
- [`packages/core/src/app/services/storage/DiskStorageAdapter.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/storage/DiskStorageAdapter.ts)
- [`packages/core/src/app/services/storage/S3StorageAdapter.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/storage/S3StorageAdapter.ts)
- [`packages/core/src/app/services/storage/GCSStorageAdapter.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/storage/GCSStorageAdapter.ts)
- Integration tests: `S3StorageAdapter.integration.test.ts` (LocalStack), `GCSStorageAdapter.integration.test.ts` (fake-gcs-server)
