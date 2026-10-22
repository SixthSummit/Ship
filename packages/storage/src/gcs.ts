import type {
  StorageAdapter,
  StorageAdapterHealth,
  StorageObjectMeta,
  StorageSignedUpload,
  StorageSignUploadRequest,
} from "@sixthsummit/ship-core";

const KEY_PATTERN = /^[^\u0000-\u001f\u007f]{1,1024}$/u;

export type GcsStorageErrorCode = "SHIP_STORAGE_GCS_OPTIONS_INVALID" | "SHIP_STORAGE_GCS_KEY_INVALID";

export class GcsStorageError extends TypeError {
  readonly code: GcsStorageErrorCode;

  constructor(code: GcsStorageErrorCode, message: string) {
    super(message);
    this.name = "GcsStorageError";
    this.code = code;
  }
}

/**
 * The slice of `@google-cloud/storage` this adapter calls. Injecting the
 * client keeps the SDK (and its credentials discovery) out of this package;
 * a hand-rolled fake satisfies it in unit tests.
 */
export interface GcsFileLike {
  getSignedUrl(config: {
    readonly version: "v4";
    readonly action: "read" | "write";
    readonly expires: Date;
    readonly contentType?: string;
  }): Promise<readonly [string]>;
  getMetadata(): Promise<
    readonly [
      {
        readonly size?: string | number;
        readonly contentType?: string;
        readonly etag?: string;
        readonly updated?: string;
      },
    ]
  >;
  download(): Promise<readonly [Uint8Array]>;
  save(
    data: Uint8Array,
    options: { readonly contentType: string; readonly metadata?: { readonly cacheControl?: string } },
  ): Promise<void>;
  delete(options?: { readonly ignoreNotFound?: boolean }): Promise<unknown>;
  publicUrl(): string;
}

export interface GcsBucketLike {
  file(key: string): GcsFileLike;
  exists(): Promise<readonly [boolean]>;
}

export interface GcsClientLike {
  bucket(name: string): GcsBucketLike;
}

export interface GcsStorageAdapterOptions {
  readonly client: GcsClientLike;
  readonly bucket: string;
  /** Base for `publicUrl()`; defaults to the SDK's `file.publicUrl()`. */
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
}

export interface GcsStorageAdapter extends StorageAdapter {
  readonly adapter: "gcs";
  readonly bucket: string;
}

/**
 * Google Cloud Storage adapter over an injected `@google-cloud/storage`
 * client. Uploads are V4 signed PUT URLs bound to the content type; the
 * completion operation verifies size and type through `head()`. Deletes
 * ignore a missing object so a replayed purge is a success.
 */
export function createGcsStorageAdapter(options: GcsStorageAdapterOptions): GcsStorageAdapter {
  assertOptions(options);
  const bucket = options.client.bucket(options.bucket);
  const now = options.now ?? (() => new Date());
  const publicBase = options.publicBaseUrl?.replace(/\/+$/u, "");
  const file = (key: string): GcsFileLike => {
    assertKey(key);
    return bucket.file(key);
  };

  const head = async (key: string): Promise<StorageObjectMeta | undefined> => {
    try {
      const [metadata] = await file(key).getMetadata();
      const lastModified = metadata.updated ? new Date(metadata.updated) : undefined;
      return Object.freeze({
        key,
        size: Number(metadata.size ?? 0),
        ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
        ...(metadata.etag ? { etag: metadata.etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };

  const adapter: GcsStorageAdapter = {
    kind: "ship.storage-adapter",
    provider: "gcs",
    adapter: "gcs",
    bucket: options.bucket,
    signUpload: async (request: StorageSignUploadRequest): Promise<StorageSignedUpload> => {
      const [url] = await file(request.key).getSignedUrl({
        version: "v4",
        action: "write",
        expires: request.expiresAt,
        contentType: request.contentType,
      });
      return Object.freeze({
        url,
        method: "PUT" as const,
        headers: Object.freeze({ "content-type": request.contentType }),
        expiresAt: request.expiresAt,
      });
    },
    head,
    get: async (key) => {
      const meta = await head(key);
      if (!meta) return undefined;
      try {
        const [body] = await file(key).download();
        return { body, meta: Object.freeze({ ...meta, size: body.byteLength }) };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    put: async (key, body, putOptions) => {
      await file(key).save(body, {
        contentType: putOptions.contentType,
        ...(putOptions.cacheControl ? { metadata: { cacheControl: putOptions.cacheControl } } : {}),
      });
      return Object.freeze({
        key,
        size: body.byteLength,
        contentType: putOptions.contentType,
        lastModified: now(),
      });
    },
    delete: async (key) => {
      await file(key).delete({ ignoreNotFound: true });
    },
    signDownload: async (key, signOptions) => {
      const [url] = await file(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: signOptions.expiresAt,
      });
      return url;
    },
    publicUrl: (key) =>
      publicBase
        ? `${publicBase}/${key.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`
        : file(key).publicUrl(),
    health: async (): Promise<StorageAdapterHealth> => {
      try {
        const [exists] = await bucket.exists();
        return exists
          ? { available: true, detail: `bucket ${options.bucket} reachable` }
          : { available: false, detail: `bucket ${options.bucket} does not exist` };
      } catch (error) {
        return { available: false, detail: error instanceof Error ? error.message : "request failed" };
      }
    },
  };
  return Object.freeze(adapter);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (Reflect.get(error, "code") === 404 || Reflect.get(error, "code") === "404")
  );
}

function assertKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key) || key.startsWith("/")) {
    throw new GcsStorageError(
      "SHIP_STORAGE_GCS_KEY_INVALID",
      `storage key must be 1 to 1024 printable characters without a leading slash; received ${JSON.stringify(key)}`,
    );
  }
}

function assertOptions(options: GcsStorageAdapterOptions): void {
  if (typeof options?.client?.bucket !== "function") {
    throw new GcsStorageError(
      "SHIP_STORAGE_GCS_OPTIONS_INVALID",
      "client must expose bucket(name) like @google-cloud/storage",
    );
  }
  if (typeof options.bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{1,221}$/u.test(options.bucket)) {
    throw new GcsStorageError("SHIP_STORAGE_GCS_OPTIONS_INVALID", "bucket must be a valid bucket name");
  }
  if (options.publicBaseUrl !== undefined) {
    try {
      const url = new URL(options.publicBaseUrl);
      if (url.search || url.hash) throw new Error("query");
    } catch {
      throw new GcsStorageError(
        "SHIP_STORAGE_GCS_OPTIONS_INVALID",
        "publicBaseUrl must be an absolute URL without query or fragment",
      );
    }
  }
}
