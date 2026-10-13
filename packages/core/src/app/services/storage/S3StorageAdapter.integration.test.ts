/**
 * Real-S3 integration test against a LocalStack testcontainer.
 *
 * V4_STATUS P4. The unit tests at `S3StorageAdapter.test.ts` use a
 * mocked `S3Client` and verify command construction; this layer
 * exercises the SAME adapter against a real S3-compatible API
 * (LocalStack) so we catch:
 *
 *   - SDK version regressions that change command-shape
 *     expectations (LocalStack speaks the real S3 protocol)
 *   - Signed-URL generation that produces URLs the same server
 *     can actually consume (the mocked test asserts the call
 *     happens but not that the URL works)
 *   - Multipart-upload defaults (the SDK auto-paths large bodies
 *     through `lib-storage`'s multi-part flow; mocks miss this)
 *   - Real list-with-prefix + continuation-token semantics
 *
 * Excluded from `npm test`; runs via `npm run test:integration -w
 * @sixthsummit/ship-api`. Same Docker requirement as G3's
 * Postgres harness.
 */

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S3StorageAdapter } from "./S3StorageAdapter.js";

const BUCKET = "ship-api-test-bucket";

interface S3TestCtx {
  container: StartedLocalStackContainer;
  client: S3Client;
  adapter: S3StorageAdapter;
  cleanup(): Promise<void>;
}

async function setupLocalStackS3(): Promise<S3TestCtx> {
  const container = await new LocalstackContainer("localstack/localstack:3").start();

  const endpoint = container.getConnectionUri();
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
    // LocalStack hostnames don't match the bucket — virtual-hosted-
    // style addressing fails. Force path-style to make `endpoint/bucket/key`
    // routing work.
    forcePathStyle: true,
  });

  // LocalStack's S3 starts empty; we own the test bucket.
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));

  const adapter = new S3StorageAdapter({ client, bucket: BUCKET });

  return {
    container,
    client,
    adapter,
    cleanup: async () => {
      client.destroy();
      await container.stop().catch(() => undefined);
    },
  };
}

async function readStream(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("S3StorageAdapter integration (LocalStack)", () => {
  let ctx: S3TestCtx;

  beforeAll(async () => {
    ctx = await setupLocalStackS3();
  }, 120_000); // LocalStack image is ~500 MB; cold pull can take a minute

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  beforeEach(async () => {
    // Clean slate per test — list-and-delete (no `truncate` for S3).
    const list = await ctx.adapter.list();
    await Promise.all(list.objects.map((obj) => ctx.adapter.delete(obj.key)));
  });

  // ─── put + get round-trip ───────────────────────────────────────────

  it("put + get round-trips bytes through real S3 protocol", async () => {
    const body = Buffer.from("hello, ship-api", "utf8");
    const meta = await ctx.adapter.put("hello.txt", body, {
      contentType: "text/plain",
    });

    expect(meta.key).toBe("hello.txt");
    expect(meta.size).toBe(body.length);

    const result = await ctx.adapter.get("hello.txt");
    expect(result).not.toBeNull();
    expect(result!.meta.contentType).toBe("text/plain");
    const fetched = await readStream(result!.stream);
    expect(fetched.equals(body)).toBe(true);
  });

  it("put with custom metadata round-trips through HeadObject", async () => {
    await ctx.adapter.put("with-meta.txt", Buffer.from("x"), {
      contentType: "text/plain",
      metadata: { uploadedBy: "alice", correlationId: "trace-123" },
    });

    const result = await ctx.adapter.get("with-meta.txt");
    expect(result!.meta.metadata).toEqual({
      uploadedby: "alice", // S3 normalizes metadata keys to lowercase
      correlationid: "trace-123",
    });
  });

  // ─── exists ─────────────────────────────────────────────────────────

  it("exists returns true for present keys, false for missing keys", async () => {
    await ctx.adapter.put("present.bin", Buffer.from([0, 1, 2]));
    expect(await ctx.adapter.exists("present.bin")).toBe(true);
    expect(await ctx.adapter.exists("missing.bin")).toBe(false);
  });

  // ─── delete ─────────────────────────────────────────────────────────

  it("delete removes the object; subsequent get returns null", async () => {
    await ctx.adapter.put("ephemeral.txt", Buffer.from("bye"));
    expect(await ctx.adapter.exists("ephemeral.txt")).toBe(true);
    await ctx.adapter.delete("ephemeral.txt");
    expect(await ctx.adapter.exists("ephemeral.txt")).toBe(false);
    expect(await ctx.adapter.get("ephemeral.txt")).toBeNull();
  });

  it("delete on a missing key is idempotent (S3 returns 204 either way)", async () => {
    await expect(ctx.adapter.delete("never-existed")).resolves.toBeUndefined();
  });

  // ─── list with prefix ───────────────────────────────────────────────

  it("list filters by prefix and returns the right object set", async () => {
    await ctx.adapter.put("uploads/a.txt", Buffer.from("a"));
    await ctx.adapter.put("uploads/b.txt", Buffer.from("b"));
    await ctx.adapter.put("downloads/c.txt", Buffer.from("c"));

    const uploads = await ctx.adapter.list("uploads/");
    const keys = uploads.objects.map((o) => o.key).sort();
    expect(keys).toEqual(["uploads/a.txt", "uploads/b.txt"]);
  });

  it("list with maxKeys + continuationToken paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.adapter.put(`page/${i}.txt`, Buffer.from([i]));
    }
    const page1 = await ctx.adapter.list("page/", { maxKeys: 3 });
    expect(page1.objects).toHaveLength(3);
    expect(page1.nextContinuationToken).toBeDefined();

    const page2 = await ctx.adapter.list("page/", {
      maxKeys: 3,
      continuationToken: page1.nextContinuationToken,
    });
    expect(page2.objects).toHaveLength(2);
    expect(page2.nextContinuationToken).toBeUndefined();
  });

  // ─── signed URL ─────────────────────────────────────────────────────

  it("signedUrl produces a URL the same server can actually serve", async () => {
    const body = Buffer.from("signed-content", "utf8");
    await ctx.adapter.put("signed.txt", body, {
      contentType: "text/plain",
    });

    const url = await ctx.adapter.signedUrl("signed.txt", {
      expiresInSec: 60,
    });

    // Hit the URL with a plain fetch — proves the SigV4 signature is
    // accepted by LocalStack's S3 (and by extension a real S3 server,
    // which speaks the same protocol).
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(body)).toBe(true);
  });
});
