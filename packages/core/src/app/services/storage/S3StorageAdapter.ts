import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
 * Default upper bound on `signedUrl` TTL in seconds. 24 hours — long
 * enough for typical share-link UX, short enough that a leaked URL is
 * a bounded, auditable window rather than an indefinite back door.
 * Override per-adapter via `S3StorageAdapterOptions.maxExpiresInSec`.
 */
const DEFAULT_MAX_EXPIRES_IN_SEC = 86_400;

/**
 * AWS S3 `StorageService` adapter.
 *
 * Wraps an `S3Client` from `@aws-sdk/client-s3`. Consumers install the SDK
 * (it's not a framework runtime dep — see `package.json` devDependencies)
 * and pass a constructed client. The adapter calls `client.send(...)` with
 * the relevant command per StorageService method.
 *
 * `signedUrl` uses `@aws-sdk/s3-request-presigner.getSignedUrl` which
 * generates a properly-signed URL without requiring the file to exist
 * (useful for browser-direct PUT uploads).
 *
 * Buckets, keys, and `keyPrefix` are passed verbatim to the SDK — the
 * adapter does NOT add a leading "/" or sanitize. Consumers should
 * sanitize paths upstream (the framework's parseUpload schema is the
 * recommended choke point).
 */

export interface S3StorageAdapterOptions {
  /** A constructed `S3Client` from `@aws-sdk/client-s3`. */
  client: S3Client;
  /** Bucket name. */
  bucket: string;
  /** Optional prefix prepended to every key (e.g., `"prod/uploads/"`). */
  keyPrefix?: string;
  /**
   * Maximum TTL (in seconds) accepted by `signedUrl`. Defaults to
   * **86 400 (24 h)**. Requests with `expiresInSec` exceeding this
   * ceiling throw `BadRequestError`; the multi-tenant rationale is
   * documented on `SignedUrlOptions.expiresInSec`.
   *
   * Adopters who need longer-lived URLs (e.g., a static-asset bucket
   * fronting a CDN where leakage is not a concern) raise this
   * deliberately. Adopters who want shorter URLs (e.g., 1h
   * compliance ceiling) set this lower.
   */
  maxExpiresInSec?: number;
}

export class S3StorageAdapter implements StorageService {
  private client: S3Client;
  private bucket: string;
  private keyPrefix: string;
  private maxExpiresInSec: number;

  constructor(opts: S3StorageAdapterOptions) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.keyPrefix = opts.keyPrefix ?? "";
    this.maxExpiresInSec = opts.maxExpiresInSec ?? DEFAULT_MAX_EXPIRES_IN_SEC;
    if (this.maxExpiresInSec <= 0) {
      throw new Error(
        `S3StorageAdapter: maxExpiresInSec must be positive (got ${this.maxExpiresInSec})`,
      );
    }
  }

  private k(key: string): string {
    return this.keyPrefix + key;
  }

  /** Strip the prefix from a key returned by the SDK so callers see what they asked for. */
  private unk(awsKey: string): string {
    return awsKey.startsWith(this.keyPrefix) ? awsKey.slice(this.keyPrefix.length) : awsKey;
  }

  private async bodyToS3(body: StorageBody): Promise<Buffer | Uint8Array> {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return body;
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
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
    throw new Error("S3StorageAdapter: unsupported body type");
  }

  async put(key: string, body: StorageBody, opts: PutOptions = {}): Promise<StorageObjectMeta> {
    const buf = await this.bodyToS3(body);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.k(key),
      Body: buf,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl,
      Metadata: opts.metadata,
    });
    const response = await this.client.send(command);
    return {
      key,
      size: buf.byteLength,
      contentType: opts.contentType,
      etag: response.ETag,
      metadata: opts.metadata,
    };
  }

  async get(key: string): Promise<GetResult | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
      );
      const body = response.Body;
      if (!body) return null;

      // The SDK exposes Body as a `Readable | ReadableStream | Blob`
      // depending on runtime; transformToWebStream() unifies it.
      const stream =
        typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function"
          ? (
              body as unknown as { transformToWebStream: () => ReadableStream }
            ).transformToWebStream()
          : (body as unknown as ReadableStream);

      const meta: StorageObjectMeta = {
        key,
        size: response.ContentLength ?? 0,
        contentType: response.ContentType,
        lastModified: response.LastModified,
        etag: response.ETag,
        metadata: response.Metadata,
      };
      return { stream, meta };
    } catch (err) {
      if (isS3NotFound(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }

  async list(prefix = "", opts: ListOptions = {}): Promise<ListResult> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.k(prefix),
        MaxKeys: opts.maxKeys ?? 1000,
        ContinuationToken: opts.continuationToken,
      }),
    );

    const objects: StorageObjectMeta[] = (response.Contents ?? []).map((entry) => ({
      key: this.unk(entry.Key ?? ""),
      size: entry.Size ?? 0,
      lastModified: entry.LastModified,
      etag: entry.ETag,
    }));

    return {
      objects,
      nextContinuationToken: response.IsTruncated ? response.NextContinuationToken : undefined,
    };
  }

  async signedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    const expiresIn = opts.expiresInSec ?? 900;
    if (expiresIn <= 0 || expiresIn > this.maxExpiresInSec) {
      throw new BadRequestError(
        `Signed URL TTL out of range: ${expiresIn}s (must be > 0 and <= ${this.maxExpiresInSec}s)`,
      );
    }
    const method = opts.method ?? "GET";
    if (method === "PUT") {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        ContentType: opts.contentType,
      });
      return getSignedUrl(this.client, command, { expiresIn });
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) });
    return getSignedUrl(this.client, command, { expiresIn });
  }
}

/** Detect "key not found" across the SDK's error variants. */
function isS3NotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  if (e.name === "NoSuchKey" || e.name === "NotFound") return true;
  if (e.Code === "NoSuchKey" || e.Code === "NotFound") return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}
