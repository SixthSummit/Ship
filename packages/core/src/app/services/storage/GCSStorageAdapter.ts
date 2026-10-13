import type { Bucket } from "@google-cloud/storage";
import { BadRequestError } from "../../../http/errors/BadRequestError.js";
import type {
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  SignedUrlOptions,
  StorageBody,
  StorageObjectMeta,
  StorageService,
} from "./StorageService.js";

/**
 * Default upper bound on `signedUrl` TTL in seconds. 24 hours — see
 * the rationale in `SignedUrlOptions.expiresInSec`. Override
 * per-adapter via `GCSStorageAdapterOptions.maxExpiresInSec`.
 */
const DEFAULT_MAX_EXPIRES_IN_SEC = 86_400;

/**
 * Google Cloud Storage `StorageService` adapter.
 *
 * Wraps a `Bucket` from `@google-cloud/storage`. Sixth Summit's GCP
 * default. Consumers install the SDK and pass a constructed `Bucket`
 * (e.g., `new Storage().bucket("name")`).
 *
 * `signedUrl` uses GCS's V4 signing (`getSignedUrl({ version: 'v4', ... })`).
 *
 * The GCS SDK uses Buffers and Streams natively. `put` accepts the
 * framework's full `StorageBody` union and normalizes to a Buffer for
 * `file.save(...)`.
 */

export interface GCSStorageAdapterOptions {
  /** A `Bucket` instance from `@google-cloud/storage`. */
  bucket: Bucket;
  /** Optional prefix prepended to every key. */
  keyPrefix?: string;
  /**
   * Maximum TTL (in seconds) accepted by `signedUrl`. Defaults to
   * **86 400 (24 h)**. Requests with `expiresInSec` exceeding this
   * ceiling throw `BadRequestError`. See `SignedUrlOptions.expiresInSec`
   * for the multi-tenant rationale.
   */
  maxExpiresInSec?: number;
}

export class GCSStorageAdapter implements StorageService {
  private bucket: Bucket;
  private keyPrefix: string;
  private maxExpiresInSec: number;

  constructor(opts: GCSStorageAdapterOptions) {
    this.bucket = opts.bucket;
    this.keyPrefix = opts.keyPrefix ?? "";
    this.maxExpiresInSec = opts.maxExpiresInSec ?? DEFAULT_MAX_EXPIRES_IN_SEC;
    if (this.maxExpiresInSec <= 0) {
      throw new Error(
        `GCSStorageAdapter: maxExpiresInSec must be positive (got ${this.maxExpiresInSec})`,
      );
    }
  }

  private k(key: string): string {
    return this.keyPrefix + key;
  }

  private unk(gcsName: string): string {
    return gcsName.startsWith(this.keyPrefix) ? gcsName.slice(this.keyPrefix.length) : gcsName;
  }

  private async bodyToBuffer(body: StorageBody): Promise<Buffer> {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
    if (typeof (body as ReadableStream).getReader === "function") {
      const reader = (body as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return Buffer.concat(chunks);
    }
    throw new Error("GCSStorageAdapter: unsupported body type");
  }

  async put(key: string, body: StorageBody, opts: PutOptions = {}): Promise<StorageObjectMeta> {
    const buf = await this.bodyToBuffer(body);
    const file = this.bucket.file(this.k(key));
    await file.save(buf, {
      metadata: {
        contentType: opts.contentType,
        cacheControl: opts.cacheControl,
        metadata: opts.metadata,
      },
      resumable: buf.byteLength > 5 * 1024 * 1024, // resumable upload above 5 MB
    });
    return {
      key,
      size: buf.byteLength,
      contentType: opts.contentType,
      metadata: opts.metadata,
    };
  }

  async get(key: string): Promise<GetResult | null> {
    const file = this.bucket.file(this.k(key));
    const [exists] = await file.exists();
    if (!exists) return null;

    const [metadata] = await file.getMetadata();
    const nodeStream = file.createReadStream();
    // node:stream Readable → Web ReadableStream
    const stream = (await import("node:stream")).Readable.toWeb(nodeStream) as ReadableStream;

    const size =
      typeof metadata.size === "string" ? Number.parseInt(metadata.size, 10) : (metadata.size ?? 0);
    const lastModified = metadata.updated ? new Date(metadata.updated) : undefined;

    return {
      stream,
      meta: {
        key,
        size,
        contentType: metadata.contentType,
        lastModified,
        etag: metadata.etag,
        metadata: metadata.metadata as Record<string, string> | undefined,
      },
    };
  }

  async exists(key: string): Promise<boolean> {
    const [exists] = await this.bucket.file(this.k(key)).exists();
    return exists;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.file(this.k(key)).delete({ ignoreNotFound: true });
  }

  async list(prefix = "", opts: ListOptions = {}): Promise<ListResult> {
    const [files, nextQuery] = await this.bucket.getFiles({
      prefix: this.k(prefix),
      maxResults: opts.maxKeys ?? 1000,
      pageToken: opts.continuationToken,
      autoPaginate: false,
    });

    const objects: StorageObjectMeta[] = files.map((file) => {
      const m = file.metadata;
      const size = typeof m.size === "string" ? Number.parseInt(m.size, 10) : (m.size ?? 0);
      return {
        key: this.unk(file.name),
        size,
        contentType: m.contentType,
        lastModified: m.updated ? new Date(m.updated) : undefined,
        etag: m.etag,
      };
    });

    return {
      objects,
      nextContinuationToken: (nextQuery as { pageToken?: string } | undefined)?.pageToken,
    };
  }

  async signedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    const expiresInSec = opts.expiresInSec ?? 900;
    if (expiresInSec <= 0 || expiresInSec > this.maxExpiresInSec) {
      throw new BadRequestError(
        `Signed URL TTL out of range: ${expiresInSec}s (must be > 0 and <= ${this.maxExpiresInSec}s)`,
      );
    }
    const action: "read" | "write" = opts.method === "PUT" ? "write" : "read";

    const [url] = await this.bucket.file(this.k(key)).getSignedUrl({
      version: "v4",
      action,
      expires: Date.now() + expiresInSec * 1000,
      contentType: action === "write" ? opts.contentType : undefined,
    });
    return url;
  }
}
