import { describe, expect, it, vi } from "vitest";
import { createGcsStorageAdapter, type GcsClientLike, GcsStorageError } from "./gcs.js";

function fakeClient(objects = new Map<string, { body: Uint8Array; contentType: string }>()) {
  const signed: unknown[] = [];
  const client: GcsClientLike = {
    bucket: (name) => ({
      exists: async () => [name === "present"] as const,
      file: (key) => ({
        getSignedUrl: async (config) => {
          signed.push({ key, ...config });
          return [
            `https://storage.googleapis.com/${name}/${key}?X-Goog-Signature=sig-${signed.length}`,
          ] as const;
        },
        getMetadata: async () => {
          const stored = objects.get(key);
          if (!stored) throw Object.assign(new Error("not found"), { code: 404 });
          return [
            {
              size: String(stored.body.byteLength),
              contentType: stored.contentType,
              etag: "etag",
              updated: "2026-10-22T10:00:00.000Z",
            },
          ] as const;
        },
        download: async () => {
          const stored = objects.get(key);
          if (!stored) throw Object.assign(new Error("not found"), { code: 404 });
          return [stored.body] as const;
        },
        save: async (data, options) => {
          objects.set(key, { body: data, contentType: options.contentType });
        },
        delete: async () => {
          objects.delete(key);
        },
        publicUrl: () => `https://storage.googleapis.com/${name}/${key}`,
      }),
    }),
  };
  return { client, objects, signed };
}

describe("createGcsStorageAdapter", () => {
  it("signs v4 upload and download urls through the injected client", async () => {
    const { client, signed } = fakeClient();
    const adapter = createGcsStorageAdapter({ client, bucket: "present" });
    const expiresAt = new Date("2026-10-22T11:00:00.000Z");
    const upload = await adapter.signUpload({
      key: "gallery.photo/1",
      contentType: "image/png",
      size: 3,
      expiresAt,
    });
    expect(upload).toEqual({
      url: "https://storage.googleapis.com/present/gallery.photo/1?X-Goog-Signature=sig-1",
      method: "PUT",
      headers: { "content-type": "image/png" },
      expiresAt,
    });
    await adapter.signDownload("gallery.photo/1", { expiresAt });
    expect(signed).toEqual([
      {
        key: "gallery.photo/1",
        version: "v4",
        action: "write",
        expires: expiresAt,
        contentType: "image/png",
      },
      { key: "gallery.photo/1", version: "v4", action: "read", expires: expiresAt },
    ]);
  });

  it("maps metadata, downloads, saves, deletes and health", async () => {
    const { client, objects } = fakeClient();
    const adapter = createGcsStorageAdapter({
      client,
      bucket: "present",
      publicBaseUrl: "https://cdn.example.test",
      now: () => new Date("2026-10-22T10:00:00.000Z"),
    });
    expect(await adapter.head("missing")).toBeUndefined();
    expect(await adapter.get("missing")).toBeUndefined();
    const written = await adapter.put("a/b", new TextEncoder().encode("abc"), {
      contentType: "text/plain",
    });
    expect(written).toMatchObject({ key: "a/b", size: 3, contentType: "text/plain" });
    expect(await adapter.head("a/b")).toEqual({
      key: "a/b",
      size: 3,
      contentType: "text/plain",
      etag: "etag",
      lastModified: new Date("2026-10-22T10:00:00.000Z"),
    });
    expect(new TextDecoder().decode((await adapter.get("a/b"))?.body)).toBe("abc");
    await adapter.delete("a/b");
    await adapter.delete("a/b");
    expect(objects.size).toBe(0);
    expect(adapter.publicUrl("a/b c")).toBe("https://cdn.example.test/a/b%20c");
    expect((await adapter.health()).available).toBe(true);
    expect((await createGcsStorageAdapter({ client, bucket: "absent" }).health()).available).toBe(
      false,
    );
  });

  it("rethrows provider errors other than not-found", async () => {
    const client: GcsClientLike = {
      bucket: () => ({
        exists: async () => {
          throw new Error("network");
        },
        file: () => ({
          getSignedUrl: vi.fn(),
          getMetadata: async () => {
            throw Object.assign(new Error("denied"), { code: 403 });
          },
          download: vi.fn(),
          save: vi.fn(),
          delete: vi.fn(),
          publicUrl: () => "",
        }),
      }),
    };
    const adapter = createGcsStorageAdapter({ client, bucket: "present" });
    await expect(adapter.head("x")).rejects.toThrow("denied");
    expect(await adapter.health()).toEqual({ available: false, detail: "network" });
  });

  it("validates options and keys", () => {
    expect(() => createGcsStorageAdapter({ client: {} as never, bucket: "present" })).toThrow(
      GcsStorageError,
    );
    expect(() => createGcsStorageAdapter({ client: fakeClient().client, bucket: "B" })).toThrow(
      GcsStorageError,
    );
    expect(() =>
      createGcsStorageAdapter({
        client: fakeClient().client,
        bucket: "present",
        publicBaseUrl: "nope",
      }),
    ).toThrow(GcsStorageError);
    const adapter = createGcsStorageAdapter({ client: fakeClient().client, bucket: "present" });
    expect(() => adapter.publicUrl("/x")).toThrow(GcsStorageError);
  });
});
