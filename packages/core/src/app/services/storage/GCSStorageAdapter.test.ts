import { Readable } from "node:stream";
import type { Bucket } from "@google-cloud/storage";
import { describe, expect, it } from "vitest";
import { GCSStorageAdapter } from "./GCSStorageAdapter.js";

/**
 * The adapter is a translator from StorageService → GCS Bucket.file() API.
 * Tests use a hand-rolled fake Bucket / File. Real-GCS integration via
 * fake-gcs-server testcontainer comes later.
 */

interface FakeFileState {
  name: string;
  body?: Buffer;
  metadata: {
    contentType?: string;
    cacheControl?: string;
    metadata?: Record<string, string>;
    size?: string | number;
    updated?: string;
    etag?: string;
  };
  exists: boolean;
}

function makeFakeBucket() {
  const files = new Map<string, FakeFileState>();
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function recordCall(method: string, ...args: unknown[]) {
    calls.push({ method, args });
  }

  const fakeFile = (name: string) => {
    const ensureState = (): FakeFileState => {
      let state = files.get(name);
      if (!state) {
        state = { name, metadata: {}, exists: false };
        files.set(name, state);
      }
      return state;
    };
    return {
      get name() {
        return name;
      },
      get metadata() {
        return ensureState().metadata;
      },
      async save(
        buf: Buffer,
        opts: {
          metadata?: {
            contentType?: string;
            cacheControl?: string;
            metadata?: Record<string, string>;
          };
        },
      ) {
        recordCall("save", name, buf, opts);
        const state = ensureState();
        state.body = buf;
        state.exists = true;
        state.metadata = {
          ...opts.metadata,
          size: String(buf.byteLength),
          updated: new Date().toISOString(),
          etag: `etag-${name}`,
        };
      },
      async exists() {
        recordCall("exists", name);
        return [files.get(name)?.exists ?? false];
      },
      async getMetadata() {
        recordCall("getMetadata", name);
        return [ensureState().metadata];
      },
      createReadStream() {
        recordCall("createReadStream", name);
        const buf = ensureState().body ?? Buffer.alloc(0);
        return Readable.from(buf);
      },
      async delete(opts?: { ignoreNotFound?: boolean }) {
        recordCall("delete", name, opts);
        files.delete(name);
      },
      async getSignedUrl(opts: unknown) {
        recordCall("getSignedUrl", name, opts);
        return [`https://storage.googleapis.com/signed/${name}?ttl=900`];
      },
    };
  };

  const bucket = {
    file: (name: string) => fakeFile(name),
    async getFiles(opts: { prefix?: string; maxResults?: number; pageToken?: string }) {
      recordCall("getFiles", opts);
      const all = [...files.values()].filter(
        (f) => f.exists && (opts.prefix === undefined || f.name.startsWith(opts.prefix)),
      );
      const page = all.slice(0, opts.maxResults ?? all.length);
      const nextQuery =
        page.length < all.length ? { pageToken: `cursor-${page.length}` } : undefined;
      const fileWrappers = page.map((s) => fakeFile(s.name));
      return [fileWrappers, nextQuery];
    },
  } as unknown as Bucket;

  return { bucket, files, calls };
}

async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("GCSStorageAdapter.put", () => {
  it("calls file.save with the buffer + metadata", async () => {
    const { bucket, calls } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });

    const meta = await adapter.put("a.txt", Buffer.from("hello"), {
      contentType: "text/plain",
      cacheControl: "max-age=60",
      metadata: { author: "alice" },
    });

    expect(calls[0].method).toBe("save");
    const saveCall = calls[0].args as [string, Buffer, { metadata: unknown }];
    expect(saveCall[0]).toBe("a.txt");
    expect(saveCall[2].metadata).toMatchObject({
      contentType: "text/plain",
      cacheControl: "max-age=60",
      metadata: { author: "alice" },
    });
    expect(meta).toMatchObject({
      key: "a.txt",
      size: 5,
      contentType: "text/plain",
    });
  });

  it("applies keyPrefix", async () => {
    const { bucket, calls } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket, keyPrefix: "prod/" });
    await adapter.put("a.txt", Buffer.from("v"));
    const saveCall = calls[0].args as [string, Buffer, unknown];
    expect(saveCall[0]).toBe("prod/a.txt");
  });

  it("supports Uint8Array, Blob, and ReadableStream bodies", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });

    await expect(adapter.put("a", new Uint8Array([1, 2, 3]))).resolves.toMatchObject({ size: 3 });
    await expect(adapter.put("b", new Blob(["abcd"]))).resolves.toMatchObject({ size: 4 });

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("xyz"));
        c.close();
      },
    });
    await expect(adapter.put("c", stream)).resolves.toMatchObject({ size: 3 });
  });
});

describe("GCSStorageAdapter.get", () => {
  it("returns null for missing keys", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    expect(await adapter.get("nope")).toBeNull();
  });

  it("streams the stored body and returns metadata", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await adapter.put("a", Buffer.from("hello world"), {
      contentType: "text/plain",
      metadata: { kind: "test" },
    });

    const result = await adapter.get("a");
    expect(result).not.toBeNull();
    expect(await streamToString(result!.stream)).toBe("hello world");
    expect(result!.meta).toMatchObject({
      key: "a",
      size: 11,
      contentType: "text/plain",
      etag: "etag-a",
    });
    expect(result!.meta.lastModified).toBeInstanceOf(Date);
  });
});

describe("GCSStorageAdapter.exists", () => {
  it("returns true for present, false for missing", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    expect(await adapter.exists("nope")).toBe(false);
    await adapter.put("yep", Buffer.from("v"));
    expect(await adapter.exists("yep")).toBe(true);
  });
});

describe("GCSStorageAdapter.delete", () => {
  it("calls file.delete with ignoreNotFound: true (no-throw on missing)", async () => {
    const { bucket, calls } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await adapter.delete("k");
    const deleteCall = calls.find((c) => c.method === "delete")!;
    expect(deleteCall.args[1]).toEqual({ ignoreNotFound: true });
  });
});

describe("GCSStorageAdapter.list", () => {
  it("returns objects + nextContinuationToken from getFiles", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await adapter.put("a", Buffer.from("1"));
    await adapter.put("b", Buffer.from("22"));
    await adapter.put("c", Buffer.from("333"));

    const result = await adapter.list("", { maxKeys: 2 });
    expect(result.objects).toHaveLength(2);
    expect(result.nextContinuationToken).toBe("cursor-2");
  });

  it("filters by prefix (after applying keyPrefix)", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket, keyPrefix: "p/" });
    await adapter.put("alpha", Buffer.from("1"));
    await adapter.put("beta", Buffer.from("2"));

    const result = await adapter.list("al");
    expect(result.objects.map((o) => o.key)).toEqual(["alpha"]);
  });
});

describe("GCSStorageAdapter.signedUrl", () => {
  it("returns a v4 signed URL for read by default", async () => {
    const { bucket, calls } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    const url = await adapter.signedUrl("k");
    expect(url).toContain("storage.googleapis.com/signed/k");
    const signCall = calls.find((c) => c.method === "getSignedUrl")!;
    const opts = signCall.args[1] as { version: string; action: string };
    expect(opts.version).toBe("v4");
    expect(opts.action).toBe("read");
  });

  it("requests action=write for method: 'PUT'", async () => {
    const { bucket, calls } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await adapter.signedUrl("k", { method: "PUT", contentType: "image/png" });
    const signCall = calls.find((c) => c.method === "getSignedUrl")!;
    const opts = signCall.args[1] as { action: string; contentType: string };
    expect(opts.action).toBe("write");
    expect(opts.contentType).toBe("image/png");
  });
});

describe("GCSStorageAdapter.signedUrl — TTL ceiling (F3)", () => {
  it("accepts expiresInSec at the default ceiling (86400s)", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await expect(adapter.signedUrl("k", { expiresInSec: 86_400 })).resolves.toBeTruthy();
  });

  it("rejects expiresInSec one second above the default ceiling", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await expect(adapter.signedUrl("k", { expiresInSec: 86_401 })).rejects.toThrow(/out of range/);
  });

  it("rejects expiresInSec = 0", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await expect(adapter.signedUrl("k", { expiresInSec: 0 })).rejects.toThrow(/out of range/);
  });

  it("rejects negative expiresInSec", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket });
    await expect(adapter.signedUrl("k", { expiresInSec: -10 })).rejects.toThrow(/out of range/);
  });

  it("honors a tightened per-adapter ceiling", async () => {
    const { bucket } = makeFakeBucket();
    const adapter = new GCSStorageAdapter({ bucket, maxExpiresInSec: 3_600 });
    await expect(adapter.signedUrl("k", { expiresInSec: 3_600 })).resolves.toBeTruthy();
    await expect(adapter.signedUrl("k", { expiresInSec: 7_200 })).rejects.toThrow(/out of range/);
  });

  it("throws at construction when maxExpiresInSec <= 0", () => {
    const { bucket } = makeFakeBucket();
    expect(() => new GCSStorageAdapter({ bucket, maxExpiresInSec: 0 })).toThrow(/must be positive/);
    expect(() => new GCSStorageAdapter({ bucket, maxExpiresInSec: -1 })).toThrow(
      /must be positive/,
    );
  });
});

describe("GCSStorageAdapter — sanity", () => {
  it("satisfies StorageService at the type level", () => {
    const { bucket } = makeFakeBucket();
    const adapter: import("./StorageService.js").StorageService = new GCSStorageAdapter({ bucket });
    expect(adapter).toBeDefined();
  });
});
