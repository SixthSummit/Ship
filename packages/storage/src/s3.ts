import type {
  StorageAdapter,
  StorageAdapterHealth,
  StorageObjectMeta,
  StorageSignedUpload,
  StorageSignUploadRequest,
} from "@sixthsummit/ship-core";

const MAX_KEY_LENGTH = 1024;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export type S3StorageErrorCode = "SHIP_STORAGE_S3_OPTIONS_INVALID" | "SHIP_STORAGE_S3_KEY_INVALID";

export class S3StorageError extends TypeError {
  readonly code: S3StorageErrorCode;

  constructor(code: S3StorageErrorCode, message: string) {
    super(message);
    this.name = "S3StorageError";
    this.code = code;
  }
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3StorageAdapterOptions {
  readonly bucket: string;
  /** `auto` for Cloudflare R2. */
  readonly region: string;
  readonly credentials: S3Credentials | (() => S3Credentials | Promise<S3Credentials>);
  /**
   * Service endpoint. Omit for AWS (`https://<bucket>.s3.<region>.amazonaws.com`);
   * set `https://<account-id>.r2.cloudflarestorage.com` for R2 or a MinIO URL.
   */
  readonly endpoint?: string;
  /** Address the bucket as a path segment of the endpoint. Defaults to true when an endpoint is given. */
  readonly forcePathStyle?: boolean;
  /** Base for `publicUrl()`; defaults to the bucket's own object URL. */
  readonly publicBaseUrl?: string;
  /**
   * The largest upload the adapter will grant. It signs single-request PUTs
   * only (no multipart), and S3, R2 and MinIO cap a single PUT at 5 GiB, so
   * the default is that cap; lower it to match a stricter bucket policy. An
   * attachment whose declared size exceeds it is refused at intent time.
   */
  readonly maxSingleUploadBytes?: number;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** The single-request PUT ceiling on AWS S3, Cloudflare R2 and MinIO. */
export const S3_MAX_SINGLE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export interface S3StorageAdapter extends StorageAdapter {
  readonly adapter: "s3";
  readonly bucket: string;
  /** The absolute URL of an object; useful for logs and assertions, never for access. */
  objectUrl(key: string): string;
}

/**
 * S3-compatible adapter (AWS S3, Cloudflare R2, MinIO) with in-house
 * Signature Version 4 presigning and request signing over Web Crypto, so the
 * package depends on no SDK and stays usable on edge runtimes. Uploads are
 * presigned PUTs whose signature covers the content type; completion verifies
 * size and type through `head()` afterwards. Deletes treat 404 as success.
 */
export function createS3StorageAdapter(options: S3StorageAdapterOptions): S3StorageAdapter {
  assertOptions(options);
  const bucket = options.bucket;
  const region = options.region;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const endpoint = new URL(options.endpoint ?? `https://s3.${region}.amazonaws.com`);
  const pathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
  const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
  const basePath = endpoint.pathname.replace(/\/+$/u, "");
  const publicBase = options.publicBaseUrl?.replace(/\/+$/u, "");

  const credentials = async (): Promise<S3Credentials> =>
    typeof options.credentials === "function" ? options.credentials() : options.credentials;
  const maxSingleUploadBytes = options.maxSingleUploadBytes ?? S3_MAX_SINGLE_UPLOAD_BYTES;

  const objectPath = (key: string): string =>
    `${basePath}${pathStyle ? `/${bucket}` : ""}/${encodeKey(key)}`;
  const objectUrl = (key: string): string => {
    assertKey(key);
    return `${endpoint.protocol}//${host}${objectPath(key)}`;
  };

  const presign = async (
    method: "PUT" | "GET",
    key: string,
    expiresAt: Date,
    signedHeaders: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const at = now();
    const expiresIn = Math.max(1, Math.floor((expiresAt.getTime() - at.getTime()) / 1000));
    if (expiresIn > MAX_PRESIGN_SECONDS) {
      throw new S3StorageError(
        "SHIP_STORAGE_S3_OPTIONS_INVALID",
        `signed URLs cannot outlive ${MAX_PRESIGN_SECONDS} seconds`,
      );
    }
    const creds = await credentials();
    const { amzDate, dateStamp } = amzTimestamps(at);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const headers: Record<string, string> = { host, ...lowercase(signedHeaders) };
    const headerNames = Object.keys(headers).sort();
    const query: [string, string][] = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${creds.accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expiresIn)],
      ["X-Amz-SignedHeaders", headerNames.join(";")],
      ...(creds.sessionToken
        ? [["X-Amz-Security-Token", creds.sessionToken] as [string, string]]
        : []),
    ];
    const canonicalQuery = canonicalQueryString(query);
    const canonicalRequest = [
      method,
      objectPath(key),
      canonicalQuery,
      `${headerNames.map((name) => `${name}:${headers[name]!.trim()}`).join("\n")}\n`,
      headerNames.join(";"),
      UNSIGNED_PAYLOAD,
    ].join("\n");
    const signature = await sign(
      creds.secretAccessKey,
      dateStamp,
      region,
      amzDate,
      scope,
      canonicalRequest,
    );
    return `${endpoint.protocol}//${host}${objectPath(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  };

  const request = async (
    method: "HEAD" | "GET" | "PUT" | "DELETE",
    key: string,
    body?: Uint8Array,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> => {
    const creds = await credentials();
    const at = now();
    const { amzDate, dateStamp } = amzTimestamps(at);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}),
      ...lowercase(extraHeaders),
    };
    const headerNames = Object.keys(headers).sort();
    const canonicalRequest = [
      method,
      objectPath(key),
      "",
      `${headerNames.map((name) => `${name}:${headers[name]!.trim()}`).join("\n")}\n`,
      headerNames.join(";"),
      payloadHash,
    ].join("\n");
    const signature = await sign(
      creds.secretAccessKey,
      dateStamp,
      region,
      amzDate,
      scope,
      canonicalRequest,
    );
    const { host: _host, ...sendHeaders } = headers;
    return fetchImpl(objectUrl(key), {
      method,
      headers: {
        ...sendHeaders,
        authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${headerNames.join(";")}, Signature=${signature}`,
      },
      ...(body ? { body: body as unknown as RequestInit["body"] } : {}),
    });
  };

  const metaFromResponse = (key: string, response: Response): StorageObjectMeta => {
    const contentType = response.headers.get("content-type") ?? undefined;
    const etag = response.headers.get("etag") ?? undefined;
    const lastModified = response.headers.get("last-modified");
    return Object.freeze({
      key,
      size: Number(response.headers.get("content-length") ?? 0),
      ...(contentType ? { contentType } : {}),
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified: new Date(lastModified) } : {}),
    });
  };

  const unexpected = (action: string, response: Response): Error =>
    new Error(
      `s3 ${action} failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );

  const adapter: S3StorageAdapter = {
    kind: "ship.storage-adapter",
    provider: "s3",
    adapter: "s3",
    bucket,
    objectUrl,
    signUpload: async (signRequest: StorageSignUploadRequest): Promise<StorageSignedUpload> => {
      assertKey(signRequest.key);
      if (signRequest.size > maxSingleUploadBytes) {
        throw new RangeError(
          `s3 adapter grants single-request uploads only (no multipart): ${signRequest.size} bytes exceeds the ${maxSingleUploadBytes}-byte ceiling; lower the attachment's maxBytes`,
        );
      }
      const headers = Object.freeze({ "content-type": signRequest.contentType });
      const url = await presign("PUT", signRequest.key, signRequest.expiresAt, headers);
      return Object.freeze({
        url,
        method: "PUT" as const,
        headers,
        expiresAt: signRequest.expiresAt,
      });
    },
    head: async (key) => {
      assertKey(key);
      const response = await request("HEAD", key);
      if (response.status === 404) return undefined;
      if (!response.ok) throw unexpected("head", response);
      return metaFromResponse(key, response);
    },
    get: async (key) => {
      assertKey(key);
      const response = await request("GET", key);
      if (response.status === 404) return undefined;
      if (!response.ok) throw unexpected("get", response);
      const body = new Uint8Array(await response.arrayBuffer());
      const meta = metaFromResponse(key, response);
      return { body, meta: Object.freeze({ ...meta, size: body.byteLength }) };
    },
    put: async (key, body, putOptions) => {
      assertKey(key);
      const response = await request("PUT", key, body, {
        "content-type": putOptions.contentType,
        "content-length": String(body.byteLength),
        ...(putOptions.cacheControl ? { "cache-control": putOptions.cacheControl } : {}),
      });
      if (!response.ok) throw unexpected("put", response);
      const etag = response.headers.get("etag") ?? undefined;
      return Object.freeze({
        key,
        size: body.byteLength,
        contentType: putOptions.contentType,
        ...(etag ? { etag } : {}),
        lastModified: now(),
      });
    },
    delete: async (key) => {
      assertKey(key);
      const response = await request("DELETE", key);
      if (response.status === 404 || response.status === 204 || response.ok) return;
      throw unexpected("delete", response);
    },
    signDownload: async (key, signOptions) => {
      assertKey(key);
      return presign("GET", key, signOptions.expiresAt, {});
    },
    publicUrl: (key) => {
      assertKey(key);
      return publicBase ? `${publicBase}/${encodeKey(key)}` : objectUrl(key);
    },
    health: async (): Promise<StorageAdapterHealth> => {
      try {
        const response = await request("HEAD", ".ship-health");
        return response.status === 404 || response.ok
          ? { available: true, detail: `${host} reachable` }
          : { available: false, detail: `bucket answered ${response.status}` };
      } catch (error) {
        return {
          available: false,
          detail: error instanceof Error ? error.message : "request failed",
        };
      }
    },
  };
  return Object.freeze(adapter);
}

async function sign(
  secret: string,
  dateStamp: string,
  region: string,
  amzDate: string,
  scope: string,
  canonicalRequest: string,
): Promise<string> {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  return hex(await hmac(kSigning, stringToSign));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(
    new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer),
    ),
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function amzTimestamps(at: Date): { amzDate: string; dateStamp: string } {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalQueryString(entries: readonly [string, string][]): string {
  return [...entries]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

function lowercase(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function assertKey(key: string): void {
  if (!isPrintableKey(key) || key.startsWith("/")) {
    throw new S3StorageError(
      "SHIP_STORAGE_S3_KEY_INVALID",
      `storage key must be 1 to 1024 printable characters without a leading slash; received ${JSON.stringify(key)}`,
    );
  }
}

function assertOptions(options: S3StorageAdapterOptions): void {
  if (typeof options?.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,62}$/u.test(options.bucket)) {
    throw new S3StorageError(
      "SHIP_STORAGE_S3_OPTIONS_INVALID",
      "bucket must be a valid bucket name",
    );
  }
  if (typeof options.region !== "string" || options.region.length === 0) {
    throw new S3StorageError(
      "SHIP_STORAGE_S3_OPTIONS_INVALID",
      "region is required (use auto for R2)",
    );
  }
  const credentials = options.credentials;
  const ceiling = options.maxSingleUploadBytes;
  if (
    ceiling !== undefined &&
    (!Number.isSafeInteger(ceiling) || ceiling <= 0 || ceiling > S3_MAX_SINGLE_UPLOAD_BYTES)
  ) {
    throw new TypeError(
      `maxSingleUploadBytes must be a positive integer no larger than ${S3_MAX_SINGLE_UPLOAD_BYTES}`,
    );
  }
  if (
    typeof credentials !== "function" &&
    (typeof credentials?.accessKeyId !== "string" ||
      typeof credentials?.secretAccessKey !== "string")
  ) {
    throw new S3StorageError(
      "SHIP_STORAGE_S3_OPTIONS_INVALID",
      "credentials must provide accessKeyId and secretAccessKey or a resolver",
    );
  }
  for (const field of ["endpoint", "publicBaseUrl"] as const) {
    const value = options[field];
    if (value === undefined) continue;
    try {
      const url = new URL(value);
      if (url.search || url.hash) throw new Error("query");
    } catch {
      throw new S3StorageError(
        "SHIP_STORAGE_S3_OPTIONS_INVALID",
        `${field} must be an absolute URL without query or fragment`,
      );
    }
  }
}

/** 1 to 1024 characters, none of them a C0 control character or DEL. */
function isPrintableKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
