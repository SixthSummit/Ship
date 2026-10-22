import { describe, expect, it } from "vitest";
import { createS3StorageAdapter, S3StorageError } from "./s3.js";

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array;
}

function fakeFetch(respond: (request: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? new Uint8Array(init.body as ArrayBuffer) : undefined;
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
      ...(body ? { body } : {}),
    };
    calls.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const AWS_EXAMPLE_NOW = new Date("2013-05-24T00:00:00.000Z");

describe("createS3StorageAdapter", () => {
  it("reproduces the AWS documentation presigned GET signature", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const adapter = createS3StorageAdapter({
      bucket: "examplebucket",
      region: "us-east-1",
      endpoint: "https://s3.amazonaws.com",
      forcePathStyle: false,
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      now: () => AWS_EXAMPLE_NOW,
    });
    const url = new URL(
      await adapter.signDownload("test.txt", {
        expiresAt: new Date(AWS_EXAMPLE_NOW.getTime() + 86_400_000),
      }),
    );
    expect(url.origin + url.pathname).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("presigns an upload bound to the content type with path-style R2 addressing", async () => {
    const adapter = createS3StorageAdapter({
      bucket: "vault",
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "key", secretAccessKey: "secret", sessionToken: "token" },
      now: () => AWS_EXAMPLE_NOW,
    });
    const signed = await adapter.signUpload({
      key: "gallery.photo/a b/1",
      contentType: "image/png",
      size: 10,
      expiresAt: new Date(AWS_EXAMPLE_NOW.getTime() + 60_000),
    });
    const url = new URL(signed.url);
    expect(signed.method).toBe("PUT");
    expect(signed.headers).toEqual({ "content-type": "image/png" });
    expect(url.origin + url.pathname).toBe(
      "https://account.r2.cloudflarestorage.com/vault/gallery.photo/a%20b/1",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("token");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/u);
    expect(adapter.publicUrl("gallery.photo/a b/1")).toBe(
      "https://account.r2.cloudflarestorage.com/vault/gallery.photo/a%20b/1",
    );
  });

  it("signs direct requests and maps provider answers", async () => {
    const { calls, fetchImpl } = fakeFetch((request) => {
      if (request.method === "HEAD" && request.url.endsWith("/missing")) {
        return new Response(null, { status: 404 });
      }
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": "3",
            "content-type": "image/png",
            etag: '"abc"',
            "last-modified": "Fri, 24 May 2013 00:00:00 GMT",
          },
        });
      }
      if (request.method === "GET") {
        return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
      }
      if (request.method === "PUT") return new Response(null, { status: 200, headers: { etag: '"x"' } });
      if (request.method === "DELETE") return new Response(null, { status: 404 });
      return new Response(null, { status: 500 });
    });
    const adapter = createS3StorageAdapter({
      bucket: "vault",
      region: "us-west-2",
      credentials: () => ({ accessKeyId: "key", secretAccessKey: "secret" }),
      publicBaseUrl: "https://cdn.example.test/",
      fetch: fetchImpl,
      now: () => AWS_EXAMPLE_NOW,
    });
    expect(await adapter.head("missing")).toBeUndefined();
    const head = await adapter.head("present");
    expect(head).toMatchObject({ key: "present", size: 3, contentType: "image/png", etag: '"abc"' });
    const got = await adapter.get("present");
    expect(new TextDecoder().decode(got?.body)).toBe("png");
    expect(got?.meta.size).toBe(3);
    const put = await adapter.put("new", new TextEncoder().encode("xy"), {
      contentType: "text/plain",
      cacheControl: "public, max-age=1",
    });
    expect(put).toMatchObject({ key: "new", size: 2, contentType: "text/plain", etag: '"x"' });
    await adapter.delete("present");
    expect(adapter.publicUrl("a/b")).toBe("https://cdn.example.test/a/b");
    expect((await adapter.health()).available).toBe(true);

    const putCall = calls.find((call) => call.method === "PUT");
    expect(putCall?.url).toBe("https://vault.s3.us-west-2.amazonaws.com/new");
    expect(putCall?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=key\/20130524\/us-west-2\/s3\/aws4_request, SignedHeaders=cache-control;content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/u,
    );
    expect(putCall?.headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(putCall?.headers.host).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD", "GET", "PUT", "DELETE", "HEAD"]);
  });

  it("surfaces unexpected provider statuses", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("denied", { status: 403, statusText: "Forbidden" }));
    const adapter = createS3StorageAdapter({
      bucket: "vault",
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "key", secretAccessKey: "secret" },
      fetch: fetchImpl,
    });
    await expect(adapter.head("x")).rejects.toThrow("s3 head failed with 403 Forbidden");
    await expect(adapter.delete("x")).rejects.toThrow("s3 delete failed with 403");
    expect((await adapter.health()).available).toBe(false);
  });

  it("validates options and keys", () => {
    expect(() =>
      createS3StorageAdapter({
        bucket: "Bad Bucket",
        region: "auto",
        credentials: { accessKeyId: "k", secretAccessKey: "s" },
      }),
    ).toThrow(S3StorageError);
    expect(() =>
      createS3StorageAdapter({
        bucket: "vault",
        region: "",
        credentials: { accessKeyId: "k", secretAccessKey: "s" },
      }),
    ).toThrow(S3StorageError);
    expect(() =>
      createS3StorageAdapter({
        bucket: "vault",
        region: "auto",
        credentials: { accessKeyId: "k" } as never,
      }),
    ).toThrow(S3StorageError);
    expect(() =>
      createS3StorageAdapter({
        bucket: "vault",
        region: "auto",
        endpoint: "not a url",
        credentials: { accessKeyId: "k", secretAccessKey: "s" },
      }),
    ).toThrow(S3StorageError);
    const adapter = createS3StorageAdapter({
      bucket: "vault",
      region: "auto",
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
    });
    expect(() => adapter.publicUrl("/leading")).toThrow(S3StorageError);
    expect(() => adapter.publicUrl("")).toThrow(S3StorageError);
  });
});
