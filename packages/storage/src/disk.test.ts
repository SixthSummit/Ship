import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageAdapterConformance } from "@sixthsummit/ship-testing/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDiskStorageAdapter,
  createDiskStorageHandler,
  type DiskStorageAdapter,
  DiskStorageError,
} from "./disk.js";

const SECRET = "disk-adapter-test-secret-0123456789";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ship-storage-disk-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let sequence = 0;
function adapter(overrides: Partial<Parameters<typeof createDiskStorageAdapter>[0]> = {}) {
  sequence += 1;
  return createDiskStorageAdapter({
    rootDir: join(root, `store-${sequence}`),
    baseUrl: "http://localhost:3000/storage",
    secret: SECRET,
    ...overrides,
  });
}

describe("createDiskStorageAdapter", () => {
  for (const check of storageAdapterConformance(() => adapter(), {
    performUpload: async (created, signed, body, headers) => {
      const response = await createDiskStorageHandler(created as DiskStorageAdapter)(
        new Request(signed.url, { method: "PUT", headers, body: body as BodyInit }),
      );
      return response.status;
    },
  })) {
    it(`conformance: ${check.name}`, async () => {
      await check.run();
    });
  }

  it("serves signed downloads and public objects, and refuses the rest", async () => {
    const disk = adapter();
    const handler = createDiskStorageHandler(disk);
    await disk.put("photos/a.png", new TextEncoder().encode("png"), { contentType: "image/png" });
    const signed = await disk.signDownload("photos/a.png", {
      expiresAt: new Date(Date.now() + 60_000),
    });
    const download = await handler(new Request(signed));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(await download.text()).toBe("png");

    const tampered = new URL(signed);
    tampered.searchParams.set("exp", String(Date.now() + 120_000));
    expect((await handler(new Request(tampered.toString()))).status).toBe(403);

    const expired = await disk.signDownload("photos/a.png", {
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect((await handler(new Request(expired))).status).toBe(403);

    const publicUrl = disk.publicUrl("photos/a.png");
    const served = await handler(new Request(publicUrl));
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000");
    expect((await handler(new Request(disk.publicUrl("photos/missing.png")))).status).toBe(404);
    expect((await handler(new Request(publicUrl, { method: "DELETE" }))).status).toBe(405);
    expect(
      (await handler(new Request("http://localhost:3000/elsewhere/public/photos/a.png"))).status,
    ).toBe(404);
  });

  it("refuses a signed upload whose body size differs from the grant", async () => {
    const disk = adapter();
    const handler = createDiskStorageHandler(disk);
    const signed = await disk.signUpload({
      key: "uploads/sized",
      contentType: "text/plain",
      size: 2,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await handler(
      new Request(signed.url, { method: "PUT", headers: signed.headers, body: "three" }),
    );
    expect(response.status).toBe(400);
    expect(await disk.head("uploads/sized")).toBeUndefined();
  });

  it("rejects keys that could escape the root", async () => {
    const disk = adapter();
    for (const key of ["../etc/passwd", "/abs", "a//b", "a/../b", ".hidden", ""]) {
      await expect(disk.head(key)).rejects.toMatchObject({ code: "SHIP_STORAGE_DISK_KEY_INVALID" });
    }
    expect(() => disk.publicUrl("..")).toThrow(DiskStorageError);
  });

  it("validates its options", () => {
    expect(() => adapter({ secret: "short" })).toThrow(
      expect.objectContaining({ code: "SHIP_STORAGE_DISK_OPTIONS_INVALID" }) as DiskStorageError,
    );
    expect(() => adapter({ baseUrl: "storage" })).toThrow(DiskStorageError);
    expect(() => adapter({ baseUrl: "http://localhost/storage?x=1" })).toThrow(DiskStorageError);
    expect(() => adapter({ rootDir: "" })).toThrow(DiskStorageError);
  });
});
