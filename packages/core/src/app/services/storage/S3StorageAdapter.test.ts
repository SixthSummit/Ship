import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

// Mock the presigner before importing the adapter so it picks up the
// mocked module. The real presigner needs SigV4 credentials configured
// on the client; not interesting for adapter unit tests.
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: { input: { Key?: string } }) => {
    return `https://signed.example.com/${command.input.Key}?ttl=900`;
  }),
}));

import { S3StorageAdapter } from "./S3StorageAdapter.js";

/**
 * The adapter is just a translator from StorageService method calls into
 * S3 SDK commands. Real-S3 integration is covered later via either
 * testcontainers (LocalStack) or a live integration test pinned to a
 * dedicated bucket. Here we verify:
 *   - Commands of the right class are constructed
 *   - With the right input shape
 *   - On send, the response is mapped back into StorageObjectMeta
 *   - 404 / NoSuchKey is mapped to null on get / false on exists
 */

interface SendCall {
  command: object;
  commandName: string;
  input: Record<string, unknown>;
}

function makeFakeS3Client(
  responder: (command: object) => unknown | Promise<unknown> = () => ({}),
): { client: S3Client; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const client = {
    send: vi.fn(async (command: object) => {
      calls.push({
        command,
        commandName: command.constructor.name,
        input: (command as { input: Record<string, unknown> }).input,
      });
      const result = await responder(command);
      return result;
    }),
  } as unknown as S3Client;
  return { client, calls };
}

function bufferToWebStream(buf: Buffer): { transformToWebStream: () => ReadableStream } {
  return {
    transformToWebStream() {
      return Readable.toWeb(Readable.from(buf)) as ReadableStream;
    },
  };
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

describe("S3StorageAdapter.put", () => {
  it("sends a PutObjectCommand with Bucket / Key / Body / metadata", async () => {
    const { client, calls } = makeFakeS3Client(() => ({ ETag: '"abc"' }));
    const adapter = new S3StorageAdapter({ client, bucket: "my-bucket" });

    const meta = await adapter.put("hello.txt", Buffer.from("hello"), {
      contentType: "text/plain",
      cacheControl: "public, max-age=60",
      metadata: { author: "alice" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBeInstanceOf(PutObjectCommand);
    expect(calls[0].input).toMatchObject({
      Bucket: "my-bucket",
      Key: "hello.txt",
      ContentType: "text/plain",
      CacheControl: "public, max-age=60",
      Metadata: { author: "alice" },
    });
    expect(meta).toMatchObject({
      key: "hello.txt",
      size: 5,
      contentType: "text/plain",
      etag: '"abc"',
    });
  });

  it("applies keyPrefix to PutObject keys but returns the unprefixed key in meta", async () => {
    const { client, calls } = makeFakeS3Client(() => ({ ETag: '"x"' }));
    const adapter = new S3StorageAdapter({ client, bucket: "b", keyPrefix: "prod/" });

    const meta = await adapter.put("file.txt", Buffer.from("v"));
    expect(calls[0].input.Key).toBe("prod/file.txt");
    expect(meta.key).toBe("file.txt"); // round-trip clean
  });

  it("supports Uint8Array, Blob, and ReadableStream bodies", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });

    await expect(adapter.put("a", new Uint8Array([1, 2, 3]))).resolves.toMatchObject({ size: 3 });
    await expect(adapter.put("b", new Blob(["abcd"]))).resolves.toMatchObject({ size: 4 });

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("stream-body"));
        c.close();
      },
    });
    await expect(adapter.put("c", stream)).resolves.toMatchObject({ size: "stream-body".length });
  });
});

describe("S3StorageAdapter.get", () => {
  it("returns the body as a Web ReadableStream + the parsed metadata", async () => {
    const { client } = makeFakeS3Client(() => ({
      Body: bufferToWebStream(Buffer.from("payload")),
      ContentLength: 7,
      ContentType: "text/plain",
      LastModified: new Date("2026-04-29T10:00:00Z"),
      ETag: '"abc"',
      Metadata: { kind: "test" },
    }));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });

    const result = await adapter.get("k");
    expect(result).not.toBeNull();
    expect(await streamToString(result!.stream)).toBe("payload");
    expect(result!.meta).toMatchObject({
      key: "k",
      size: 7,
      contentType: "text/plain",
      etag: '"abc"',
      metadata: { kind: "test" },
    });
    expect(result!.meta.lastModified).toBeInstanceOf(Date);
  });

  it("returns null for NoSuchKey errors", async () => {
    const { client } = makeFakeS3Client(() => {
      const err = new Error("not found") as Error & { name: string };
      err.name = "NoSuchKey";
      throw err;
    });
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    expect(await adapter.get("missing")).toBeNull();
  });

  it("returns null for 404 metadata errors (e.g., HeadObject 404)", async () => {
    const { client } = makeFakeS3Client(() => {
      const err = new Error("not found") as Error & { $metadata: { httpStatusCode: number } };
      (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
        httpStatusCode: 404,
      };
      throw err;
    });
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    expect(await adapter.get("missing")).toBeNull();
  });

  it("propagates non-404 errors", async () => {
    const { client } = makeFakeS3Client(() => {
      throw new Error("network down");
    });
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    await expect(adapter.get("k")).rejects.toThrow("network down");
  });

  it("uses GetObjectCommand with Bucket + (prefixed) Key", async () => {
    const { client, calls } = makeFakeS3Client(() => ({
      Body: bufferToWebStream(Buffer.from("x")),
    }));
    const adapter = new S3StorageAdapter({ client, bucket: "b", keyPrefix: "p/" });
    await adapter.get("k");
    expect(calls[0].command).toBeInstanceOf(GetObjectCommand);
    expect(calls[0].input).toMatchObject({ Bucket: "b", Key: "p/k" });
  });
});

describe("S3StorageAdapter.exists", () => {
  it("returns true when HeadObject succeeds", async () => {
    const { client, calls } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    expect(await adapter.exists("k")).toBe(true);
    expect(calls[0].command).toBeInstanceOf(HeadObjectCommand);
  });

  it("returns false on NotFound", async () => {
    const { client } = makeFakeS3Client(() => {
      const err = new Error("404") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    });
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    expect(await adapter.exists("k")).toBe(false);
  });
});

describe("S3StorageAdapter.delete", () => {
  it("sends a DeleteObjectCommand", async () => {
    const { client, calls } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b", keyPrefix: "p/" });
    await adapter.delete("k");
    expect(calls[0].command).toBeInstanceOf(DeleteObjectCommand);
    expect(calls[0].input).toMatchObject({ Bucket: "b", Key: "p/k" });
  });
});

describe("S3StorageAdapter.list", () => {
  it("sends ListObjectsV2Command and maps Contents → StorageObjectMeta[]", async () => {
    const { client, calls } = makeFakeS3Client(() => ({
      Contents: [
        { Key: "p/a.txt", Size: 3, LastModified: new Date("2026-01-01T00:00:00Z"), ETag: '"e1"' },
        { Key: "p/b.txt", Size: 5, LastModified: new Date("2026-01-02T00:00:00Z"), ETag: '"e2"' },
      ],
      IsTruncated: true,
      NextContinuationToken: "next-cursor",
    }));
    const adapter = new S3StorageAdapter({ client, bucket: "b", keyPrefix: "p/" });

    const result = await adapter.list("alpha", { maxKeys: 50 });
    expect(calls[0].command).toBeInstanceOf(ListObjectsV2Command);
    expect(calls[0].input).toMatchObject({
      Bucket: "b",
      Prefix: "p/alpha",
      MaxKeys: 50,
    });
    expect(result.objects).toEqual([
      { key: "a.txt", size: 3, lastModified: expect.any(Date), etag: '"e1"' },
      { key: "b.txt", size: 5, lastModified: expect.any(Date), etag: '"e2"' },
    ]);
    expect(result.nextContinuationToken).toBe("next-cursor");
  });

  it("returns an empty list when Contents is undefined", async () => {
    const { client } = makeFakeS3Client(() => ({ IsTruncated: false }));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    const result = await adapter.list();
    expect(result.objects).toEqual([]);
    expect(result.nextContinuationToken).toBeUndefined();
  });

  it("forwards ContinuationToken", async () => {
    const { client, calls } = makeFakeS3Client(() => ({ Contents: [] }));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    await adapter.list("", { continuationToken: "abc" });
    expect(calls[0].input).toMatchObject({ ContinuationToken: "abc" });
  });
});

describe("S3StorageAdapter.signedUrl", () => {
  it("returns a signed URL for GET (default method) including the prefixed key", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b", keyPrefix: "p/" });
    const url = await adapter.signedUrl("k");
    // Mock returns `https://signed.example.com/<Key>?ttl=900`
    expect(url).toContain("/p/k");
  });

  it("supports method: 'PUT' with contentType", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    const url = await adapter.signedUrl("k", { method: "PUT", contentType: "image/png" });
    expect(url).toContain("/k");
  });
});

describe("S3StorageAdapter.signedUrl — TTL ceiling (F3)", () => {
  it("accepts expiresInSec at the default ceiling (86400s)", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    await expect(adapter.signedUrl("k", { expiresInSec: 86_400 })).resolves.toBeTruthy();
  });

  it("rejects expiresInSec one second above the default ceiling", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    await expect(adapter.signedUrl("k", { expiresInSec: 86_401 })).rejects.toThrow(/out of range/);
  });

  it("rejects expiresInSec = 0 (degenerate)", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    await expect(adapter.signedUrl("k", { expiresInSec: 0 })).rejects.toThrow(/out of range/);
  });

  it("rejects negative expiresInSec", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({ client, bucket: "b" });
    await expect(adapter.signedUrl("k", { expiresInSec: -1 })).rejects.toThrow(/out of range/);
  });

  it("honors a tightened per-adapter ceiling", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({
      client,
      bucket: "b",
      maxExpiresInSec: 3_600,
    });
    await expect(adapter.signedUrl("k", { expiresInSec: 3_600 })).resolves.toBeTruthy();
    await expect(adapter.signedUrl("k", { expiresInSec: 7_200 })).rejects.toThrow(/out of range/);
  });

  it("honors a relaxed per-adapter ceiling", async () => {
    const { client } = makeFakeS3Client(() => ({}));
    const adapter = new S3StorageAdapter({
      client,
      bucket: "b",
      // 7 days for a static-asset bucket fronting a CDN where leakage
      // is not a concern.
      maxExpiresInSec: 7 * 86_400,
    });
    await expect(adapter.signedUrl("k", { expiresInSec: 6 * 86_400 })).resolves.toBeTruthy();
  });

  it("throws at construction when maxExpiresInSec <= 0", () => {
    const { client } = makeFakeS3Client(() => ({}));
    expect(() => new S3StorageAdapter({ client, bucket: "b", maxExpiresInSec: 0 })).toThrow(
      /must be positive/,
    );
    expect(() => new S3StorageAdapter({ client, bucket: "b", maxExpiresInSec: -1 })).toThrow(
      /must be positive/,
    );
  });
});
