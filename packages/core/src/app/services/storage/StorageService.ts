/**
 * `StorageService` — framework-wide blob/object storage abstraction.
 *
 * Three adapters ship in v4.0:
 *   - `DiskStorageAdapter` (this batch) — local filesystem; tests + dev.
 *   - `S3StorageAdapter` (next batch) — `@aws-sdk/client-s3` as optional
 *     peer dep; production default for AWS.
 *   - `GCSStorageAdapter` (next batch) — `@google-cloud/storage` as
 *     optional peer dep; Sixth Summit's GCP default.
 *
 * The interface is intentionally narrow — `put` / `get` / `exists` /
 * `delete` / `list` / `signedUrl` — so future adapters (R2, Azure Blob,
 * Cloudflare KV-as-blob) can plug in without API churn. Per-adapter
 * options that don't fit the common shape go in the constructor, not the
 * interface.
 */

export type StorageBody = Buffer | Uint8Array | ReadableStream | Blob | File;

export interface StorageObjectMeta {
  /** Object key relative to the adapter's namespace (no leading "/"). */
  key: string;
  /** Size in bytes. */
  size: number;
  /** MIME type if recorded. */
  contentType?: string;
  /** Last-modified timestamp if the adapter reports it. */
  lastModified?: Date;
  /** Adapter-specific entity tag (md5, opaque, etc.). */
  etag?: string;
  /** User-supplied metadata recorded at put-time. */
  metadata?: Record<string, string>;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ListOptions {
  /** Max objects per page. Default 1000. */
  maxKeys?: number;
  /** Opaque cursor returned by the previous page. */
  continuationToken?: string;
}

export interface ListResult {
  objects: StorageObjectMeta[];
  nextContinuationToken?: string;
}

export interface SignedUrlOptions {
  /**
   * TTL in seconds. Default 900 (15 min). Bounded by the adapter's
   * `maxExpiresInSec` (default 86400 = 24h); values exceeding the
   * ceiling throw `BadRequestError`.
   *
   * The ceiling defends multi-tenant deployments: a long-lived
   * signed URL survives session revocation, role changes, and tenant
   * migrations, so any leak (logs, share-link UX, analytics, browser
   * history forwarded to support) becomes a window of cross-tenant
   * data exposure with no audit trail. Per-adapter configurable when
   * a higher ceiling is genuinely required.
   */
  expiresInSec?: number;
  /** `"GET"` (download) or `"PUT"` (browser-direct upload). Default `"GET"`. */
  method?: "GET" | "PUT";
  /** Required `Content-Type` for PUT pre-signed URLs. */
  contentType?: string;
}

export interface GetResult {
  /** Streaming body. The caller must drain or cancel. */
  stream: ReadableStream;
  meta: StorageObjectMeta;
}

export interface StorageService {
  /** Upload `body` under `key`. Returns the recorded metadata. */
  put(key: string, body: StorageBody, opts?: PutOptions): Promise<StorageObjectMeta>;

  /** Returns `null` when the object doesn't exist. */
  get(key: string): Promise<GetResult | null>;

  exists(key: string): Promise<boolean>;

  delete(key: string): Promise<void>;

  list(prefix?: string, opts?: ListOptions): Promise<ListResult>;

  /**
   * Pre-signed URL for direct browser GET / PUT. Optional — adapters that
   * can't sign (e.g., the disk adapter without a separate file server)
   * should throw a clear error. Consumers that need signed URLs can branch
   * on `if ("signedUrl" in service)` or assume the production adapter
   * always implements it.
   */
  signedUrl?(key: string, opts?: SignedUrlOptions): Promise<string>;
}
