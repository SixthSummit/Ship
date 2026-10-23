import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type {
  StorageAdapter,
  StorageAdapterHealth,
  StorageObjectMeta,
  StorageSignedUpload,
  StorageSignUploadRequest,
} from "@sixthsummit/ship-core";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const META_SUFFIX = ".ship-meta.json";

export type DiskStorageErrorCode =
  | "SHIP_STORAGE_DISK_OPTIONS_INVALID"
  | "SHIP_STORAGE_DISK_KEY_INVALID";

export class DiskStorageError extends TypeError {
  readonly code: DiskStorageErrorCode;

  constructor(code: DiskStorageErrorCode, message: string) {
    super(message);
    this.name = "DiskStorageError";
    this.code = code;
  }
}

export interface DiskStorageAdapterOptions {
  /** Objects live at `<rootDir>/<key>`; the directory is created on first write. */
  readonly rootDir: string;
  /**
   * The absolute URL the application serves {@link createDiskStorageHandler}
   * under, for example `http://localhost:3000/storage`. Signed upload and
   * download URLs are built beneath it.
   */
  readonly baseUrl: string;
  /** HMAC secret the signed URLs are minted and verified with. At least 16 bytes. */
  readonly secret: string | Uint8Array;
  readonly now?: () => Date;
}

export interface DiskStorageAdapter extends StorageAdapter {
  readonly adapter: "disk";
  readonly rootDir: string;
  readonly baseUrl: string;
  /** Verifies a signed URL this adapter minted; exposed for the request handler. */
  verify(url: URL, method: "PUT" | "GET"): DiskSignatureVerification;
}

export type DiskSignatureVerification =
  | {
      readonly ok: true;
      readonly key: string;
      readonly contentType?: string;
      readonly size?: number;
    }
  | { readonly ok: false; readonly reason: "signature" | "expired" | "key" | "route" };

interface StoredMeta {
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: string;
}

/**
 * Local-disk adapter for development and tests. It mints HMAC-signed upload
 * and download URLs beneath `baseUrl`; the application serves them with
 * {@link createDiskStorageHandler}, which enforces the signed content type,
 * size and expiry exactly as a bucket does for a presigned PUT. Keys are
 * validated so a crafted key can never escape `rootDir`.
 */
export function createDiskStorageAdapter(options: DiskStorageAdapterOptions): DiskStorageAdapter {
  assertOptions(options);
  const rootDir = resolve(options.rootDir);
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const secret = typeof options.secret === "string" ? Buffer.from(options.secret) : options.secret;
  const now = options.now ?? (() => new Date());

  const pathFor = (key: string): string => {
    assertKey(key);
    const target = resolve(rootDir, key);
    if (target !== rootDir && !target.startsWith(`${rootDir}${sep}`)) {
      throw new DiskStorageError("SHIP_STORAGE_DISK_KEY_INVALID", "key escapes the root directory");
    }
    return target;
  };

  const sign = (parts: readonly string[]): string =>
    createHmac("sha256", secret).update(parts.join("\n")).digest("base64url");

  const readMeta = async (key: string): Promise<StoredMeta | undefined> => {
    try {
      const raw = await readFile(`${pathFor(key)}${META_SUFFIX}`, "utf8");
      return JSON.parse(raw) as StoredMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const toMeta = (key: string, meta: StoredMeta): StorageObjectMeta =>
    Object.freeze({
      key,
      size: meta.size,
      contentType: meta.contentType,
      etag: meta.etag,
      lastModified: new Date(meta.lastModified),
    });

  const put: StorageAdapter["put"] = async (key, body, putOptions) => {
    const target = pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const meta: StoredMeta = {
      contentType: putOptions.contentType,
      size: body.byteLength,
      etag: `"${createHmac("sha256", "etag").update(body).digest("hex").slice(0, 32)}"`,
      lastModified: now().toISOString(),
    };
    await writeFile(target, body);
    await writeFile(`${target}${META_SUFFIX}`, JSON.stringify(meta));
    return toMeta(key, meta);
  };

  const verify = (url: URL, method: "PUT" | "GET"): DiskSignatureVerification => {
    const base = new URL(`${baseUrl}/`);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      return { ok: false, reason: "route" };
    }
    const route = url.pathname.slice(base.pathname.length);
    const [kind, ...rest] = route.split("/");
    const key = rest.map((segment) => decodeURIComponent(segment)).join("/");
    if (!KEY_PATTERN.test(key)) return { ok: false, reason: "key" };
    if (kind === "public") {
      return method === "GET" ? { ok: true, key } : { ok: false, reason: "route" };
    }
    if ((kind !== "upload" || method !== "PUT") && (kind !== "download" || method !== "GET")) {
      return { ok: false, reason: "route" };
    }
    const expires = Number(url.searchParams.get("exp"));
    const signature = url.searchParams.get("sig") ?? "";
    const contentType = url.searchParams.get("ct") ?? undefined;
    const size = url.searchParams.get("size");
    const expected =
      kind === "upload"
        ? sign(["PUT", key, contentType ?? "", size ?? "", String(expires)])
        : sign(["GET", key, String(expires)]);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { ok: false, reason: "signature" };
    }
    if (!Number.isFinite(expires) || expires <= now().getTime()) {
      return { ok: false, reason: "expired" };
    }
    return kind === "upload"
      ? { ok: true, key, ...(contentType ? { contentType } : {}), size: Number(size) }
      : { ok: true, key };
  };

  const adapter: DiskStorageAdapter = {
    kind: "ship.storage-adapter",
    provider: "disk",
    adapter: "disk",
    rootDir,
    baseUrl,
    verify,
    signUpload: async (request: StorageSignUploadRequest): Promise<StorageSignedUpload> => {
      assertKey(request.key);
      const expires = request.expiresAt.getTime();
      const url = new URL(`${baseUrl}/upload/${encodeKey(request.key)}`);
      url.searchParams.set("exp", String(expires));
      url.searchParams.set("ct", request.contentType);
      url.searchParams.set("size", String(request.size));
      url.searchParams.set(
        "sig",
        sign(["PUT", request.key, request.contentType, String(request.size), String(expires)]),
      );
      return Object.freeze({
        url: url.toString(),
        method: "PUT" as const,
        headers: Object.freeze({ "content-type": request.contentType }),
        expiresAt: request.expiresAt,
      });
    },
    head: async (key) => {
      const meta = await readMeta(key);
      return meta ? toMeta(key, meta) : undefined;
    },
    get: async (key) => {
      const meta = await readMeta(key);
      if (!meta) return undefined;
      const body = await readFile(pathFor(key));
      return {
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        meta: toMeta(key, meta),
      };
    },
    put,
    delete: async (key) => {
      const target = pathFor(key);
      await rm(target, { force: true });
      await rm(`${target}${META_SUFFIX}`, { force: true });
    },
    signDownload: async (key, signOptions) => {
      assertKey(key);
      const expires = signOptions.expiresAt.getTime();
      const url = new URL(`${baseUrl}/download/${encodeKey(key)}`);
      url.searchParams.set("exp", String(expires));
      url.searchParams.set("sig", sign(["GET", key, String(expires)]));
      return url.toString();
    },
    publicUrl: (key) => {
      assertKey(key);
      return `${baseUrl}/public/${encodeKey(key)}`;
    },
    health: async (): Promise<StorageAdapterHealth> => {
      try {
        await mkdir(rootDir, { recursive: true });
        const info = await stat(rootDir);
        return info.isDirectory()
          ? { available: true, detail: rootDir }
          : { available: false, detail: `${rootDir} is not a directory` };
      } catch (error) {
        return { available: false, detail: error instanceof Error ? error.message : "stat failed" };
      }
    },
  };
  return Object.freeze(adapter);
}

/**
 * A fetch-style request handler that serves the adapter's signed upload,
 * signed download and public routes. Mount it under the adapter's `baseUrl`,
 * for example with Hono: `app.all("/storage/*", (c) => handler(c.req.raw))`.
 * A signed PUT is accepted only with the signed content type, size and
 * before expiry, which is what makes the completion check meaningful locally.
 */
export function createDiskStorageHandler(
  adapter: DiskStorageAdapter,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "PUT") {
      const verification = adapter.verify(url, "PUT");
      if (!verification.ok) return refuse(verification.reason);
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
      if (contentType === undefined || contentType !== verification.contentType) {
        return new Response("content type does not match the signed upload", { status: 403 });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      if (verification.size !== undefined && body.byteLength !== verification.size) {
        return new Response("size does not match the signed upload", { status: 400 });
      }
      await adapter.put(verification.key, body, { contentType });
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const verification = adapter.verify(url, "GET");
      if (!verification.ok) return refuse(verification.reason);
      const stored = await adapter.get(verification.key);
      if (!stored) return new Response("not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : stored.body, {
        status: 200,
        headers: {
          "content-type": stored.meta.contentType ?? "application/octet-stream",
          "content-length": String(stored.meta.size),
          ...(stored.meta.etag ? { etag: stored.meta.etag } : {}),
          "cache-control": url.pathname.includes("/public/")
            ? "public, max-age=31536000"
            : "private, no-store",
        },
      });
    }
    return new Response("method not allowed", { status: 405 });
  };
}

function refuse(reason: "signature" | "expired" | "key" | "route"): Response {
  switch (reason) {
    case "route":
      return new Response("not found", { status: 404 });
    case "key":
      return new Response("invalid key", { status: 400 });
    case "expired":
      return new Response("signature expired", { status: 403 });
    default:
      return new Response("invalid signature", { status: 403 });
  }
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length > 1024 || !KEY_PATTERN.test(key)) {
    throw new DiskStorageError(
      "SHIP_STORAGE_DISK_KEY_INVALID",
      `storage key must be a slash-separated path of safe segments; received ${JSON.stringify(key)}`,
    );
  }
}

function assertOptions(options: DiskStorageAdapterOptions): void {
  if (typeof options?.rootDir !== "string" || options.rootDir.length === 0) {
    throw new DiskStorageError("SHIP_STORAGE_DISK_OPTIONS_INVALID", "rootDir must be a path");
  }
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new DiskStorageError(
      "SHIP_STORAGE_DISK_OPTIONS_INVALID",
      "baseUrl must be an absolute URL",
    );
  }
  if (base.search || base.hash || (base.protocol !== "http:" && base.protocol !== "https:")) {
    throw new DiskStorageError(
      "SHIP_STORAGE_DISK_OPTIONS_INVALID",
      "baseUrl must be an http(s) URL without query or fragment",
    );
  }
  const secretLength =
    typeof options.secret === "string"
      ? Buffer.byteLength(options.secret)
      : options.secret instanceof Uint8Array
        ? options.secret.byteLength
        : 0;
  if (secretLength < 16) {
    throw new DiskStorageError(
      "SHIP_STORAGE_DISK_OPTIONS_INVALID",
      "secret must be at least 16 bytes",
    );
  }
}
