import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import type {
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  StorageBody,
  StorageObjectMeta,
  StorageService,
} from "./StorageService.js";

/**
 * Local-filesystem `StorageService` adapter.
 *
 * Stores object data at `<rootDir>/<key>` (with `..` traversal blocked).
 * Per-object metadata (contentType, cacheControl, user metadata) lives in
 * a sibling `.meta.json` file. Auto-creates intermediate directories on
 * `put`. Used in tests + single-instance dev. Production deployments
 * should use a real cloud adapter (`S3StorageAdapter` or `GCSStorageAdapter`,
 * shipping in the next batch).
 *
 * `signedUrl` is intentionally not implemented — there's no built-in
 * file server, and writing an ad-hoc one risks accidental public-read
 * exposure. Consumers wanting signed URLs in dev should mount the
 * `rootDir` behind an authenticated route.
 */

interface MetaSidecar {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface DiskStorageAdapterOptions {
  /** Absolute path to the root directory. Created on first `put` if absent. */
  rootDir: string;
}

export class DiskStorageAdapter implements StorageService {
  private rootDir: string;
  /**
   * Lazily-resolved real path of `rootDir`. Cached because the root
   * doesn't move at runtime — and recomputing it per I/O call would
   * stat the entire root-prefix chain every time.
   */
  private realRootCache?: string;

  constructor(opts: DiskStorageAdapterOptions) {
    this.rootDir = path.resolve(opts.rootDir);
  }

  // ── path helpers ────────────────────────────────────────────────────

  /**
   * Resolve a key to an absolute filesystem path, refusing path traversal.
   * String-based check only — see `resolveKeySafe` for the realpath-based
   * defense against symlink escapes.
   */
  private resolveKey(key: string): { dataPath: string; metaPath: string } {
    if (!key || key === "/" || key.startsWith("/")) {
      throw new Error(`DiskStorageAdapter: invalid key "${key}"`);
    }
    const normalized = path.posix.normalize(key);
    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
      throw new Error(`DiskStorageAdapter: key escapes root: "${key}"`);
    }
    const dataPath = path.join(this.rootDir, normalized);
    if (!dataPath.startsWith(this.rootDir + path.sep) && dataPath !== this.rootDir) {
      throw new Error(`DiskStorageAdapter: resolved path escapes root: "${dataPath}"`);
    }
    return { dataPath, metaPath: `${dataPath}.meta.json` };
  }

  /**
   * `resolveKey` after a realpath-pass that defeats symlink escapes —
   * critical for multi-tenant deployments on shared filesystems (NFS,
   * shared k8s volumes) where one tenant's upload directory could
   * contain a symlink pointing at another tenant's prefix. The pure
   * string check in `resolveKey` is sound against `..` patterns but
   * doesn't notice symlinks.
   *
   * Strategy: find the deepest existing ancestor of the target path,
   * `realpath` it (resolving any symlinks along the way), then
   * re-check that the canonical absolute path is still inside
   * `realRootDir`. New-key writes work because the "deepest existing
   * ancestor" is usually the parent directory of the new file.
   *
   * `lstat` (not `stat`) is the gate so a symlink whose target is
   * missing is still detected — we want the symlink itself to count
   * as "exists" for the walk, then realpath resolves it.
   */
  private async resolveKeySafe(key: string): Promise<{ dataPath: string; metaPath: string }> {
    const { dataPath } = this.resolveKey(key);

    // Walk up from dataPath until we hit a path that exists (incl.
    // as a symlink — dangling or otherwise). Accumulate the
    // non-existing suffix labels for re-joining to the realpath of
    // the deepest existing ancestor.
    let probe = dataPath;
    const suffix: string[] = [];
    let probeIsSymlink = false;
    while (true) {
      try {
        const lst = await lstat(probe);
        probeIsSymlink = lst.isSymbolicLink();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break; // hit filesystem root
        suffix.unshift(path.basename(probe));
        probe = parent;
      }
    }

    let realProbe: string;
    if (probeIsSymlink) {
      // Resolve the symlink ourselves so a dangling target (realpath
      // would throw ENOENT and silently fall back to root) still
      // surfaces as an escape attempt.
      const linkTarget = await readlink(probe);
      const absoluteTarget = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.join(path.dirname(probe), linkTarget);
      // Canonicalize the parent directory (the parent does exist —
      // probe lives in it). The leaf is the symlink target's basename.
      const realParent = await realpath(path.dirname(absoluteTarget));
      realProbe = path.join(realParent, path.basename(absoluteTarget));
    } else {
      try {
        realProbe = await realpath(probe);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Race: the path disappeared between lstat and realpath.
          // Fall back to the cached rootDir realpath.
          realProbe = await this.getRealRoot();
        } else {
          throw err;
        }
      }
    }

    const realDataPath = suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix);
    const realRoot = await this.getRealRoot();

    if (!realDataPath.startsWith(realRoot + path.sep) && realDataPath !== realRoot) {
      throw new Error(
        `DiskStorageAdapter: realpath escapes root: "${realDataPath}" (key "${key}")`,
      );
    }

    return { dataPath: realDataPath, metaPath: `${realDataPath}.meta.json` };
  }

  private async getRealRoot(): Promise<string> {
    if (this.realRootCache !== undefined) return this.realRootCache;
    try {
      this.realRootCache = await realpath(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // rootDir hasn't been created yet — fall back to the
        // string-resolved form. First `put` will create it.
        this.realRootCache = this.rootDir;
      } else {
        throw err;
      }
    }
    return this.realRootCache;
  }

  /** Convert any StorageBody into a Buffer (DiskStorageAdapter buffers fully). */
  private async bodyToBuffer(body: StorageBody): Promise<Buffer> {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof Blob) {
      // Covers File too (File extends Blob).
      return Buffer.from(await body.arrayBuffer());
    }
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
    throw new Error("DiskStorageAdapter: unsupported body type");
  }

  // ── StorageService impl ─────────────────────────────────────────────

  async put(key: string, body: StorageBody, opts: PutOptions = {}): Promise<StorageObjectMeta> {
    const { dataPath, metaPath } = await this.resolveKeySafe(key);
    await mkdir(path.dirname(dataPath), { recursive: true });

    const buf = await this.bodyToBuffer(body);
    await writeFile(dataPath, buf);

    const sidecar: MetaSidecar = {
      contentType: opts.contentType,
      cacheControl: opts.cacheControl,
      metadata: opts.metadata,
    };
    // Only write the sidecar if any of the fields are present; saves clutter.
    if (sidecar.contentType || sidecar.cacheControl || sidecar.metadata) {
      await writeFile(metaPath, JSON.stringify(sidecar, null, 2));
    }

    const stats = await stat(dataPath);
    return {
      key,
      size: stats.size,
      contentType: opts.contentType,
      lastModified: stats.mtime,
      metadata: opts.metadata,
    };
  }

  async get(key: string): Promise<GetResult | null> {
    const { dataPath, metaPath } = await this.resolveKeySafe(key);
    let stats;
    try {
      stats = await stat(dataPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let sidecar: MetaSidecar = {};
    try {
      sidecar = JSON.parse(await readFile(metaPath, "utf8")) as MetaSidecar;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const nodeStream = createReadStream(dataPath);
    const stream = Readable.toWeb(nodeStream) as ReadableStream;

    const meta: StorageObjectMeta = {
      key,
      size: stats.size,
      contentType: sidecar.contentType,
      lastModified: stats.mtime,
      metadata: sidecar.metadata,
    };
    return { stream, meta };
  }

  async exists(key: string): Promise<boolean> {
    const { dataPath } = await this.resolveKeySafe(key);
    try {
      await stat(dataPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { dataPath, metaPath } = await this.resolveKeySafe(key);
    await rm(dataPath, { force: true });
    await rm(metaPath, { force: true });
  }

  /**
   * Recursive listing of `rootDir`. `prefix` is matched against the
   * key (not the absolute path); `continuationToken` is an opaque numeric
   * cursor of how many entries have been emitted so far.
   *
   * For local-disk semantics this is fine; production cloud adapters
   * carry stronger pagination guarantees.
   */
  async list(prefix = "", opts: ListOptions = {}): Promise<ListResult> {
    const maxKeys = opts.maxKeys ?? 1000;
    const startAfter = opts.continuationToken ? Number.parseInt(opts.continuationToken, 10) : 0;

    const allKeys = await this.walkKeys(this.rootDir, "");
    const filtered = allKeys.filter((k) => k.startsWith(prefix)).sort();
    const slice = filtered.slice(startAfter, startAfter + maxKeys);

    const objects: StorageObjectMeta[] = [];
    for (const key of slice) {
      // Skip entries whose canonical path escapes the root — defends
      // against symlinked entries that walkKeys couldn't classify
      // (rare; walkKeys uses Dirent.isFile() which is false for
      // symlinks, but a TOCTOU race could still surface one here).
      let dataPath: string;
      try {
        ({ dataPath } = await this.resolveKeySafe(key));
      } catch {
        continue;
      }
      const stats = await stat(dataPath);
      objects.push({
        key,
        size: stats.size,
        lastModified: stats.mtime,
      });
    }

    const nextOffset = startAfter + slice.length;
    return {
      objects,
      nextContinuationToken: nextOffset < filtered.length ? String(nextOffset) : undefined,
    };
  }

  /**
   * Yields all keys (relative paths) under `dir`. Skips `.meta.json`
   * sidecars so they don't appear as separate objects.
   */
  private async walkKeys(dir: string, relPrefix: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(...(await this.walkKeys(path.join(dir, entry.name), rel)));
      } else if (entry.isFile() && !entry.name.endsWith(".meta.json")) {
        out.push(rel);
      }
    }
    return out;
  }

  // signedUrl is intentionally NOT implemented; see file header.
}
