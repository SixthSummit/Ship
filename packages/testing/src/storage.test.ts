import { describe, expect, it } from "vitest";
import {
  createInMemoryAttachmentLedger,
  createInMemoryStorageAdapter,
  type InMemoryStorageAdapter,
  runStorageAdapterConformance,
  StorageConformanceError,
  storageAdapterConformance,
} from "./storage.js";

describe("createInMemoryStorageAdapter", () => {
  for (const check of storageAdapterConformance(() => createInMemoryStorageAdapter(), {
    performUpload: async (adapter, signed, body, headers) =>
      (adapter as InMemoryStorageAdapter).upload(signed.url, body, headers),
  })) {
    it(`conformance: ${check.name}`, async () => {
      await check.run();
    });
  }

  it("reports failures from the runner-agnostic suite", async () => {
    const broken = createInMemoryStorageAdapter();
    const results = await runStorageAdapterConformance(() => ({
      ...broken,
      head: async () => undefined,
    }));
    const failed = results.filter((result) => result.error);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.error).toBeInstanceOf(StorageConformanceError);
  });

  it("refuses a grant redeemed with the wrong size or after expiry", async () => {
    let now = new Date("2026-10-22T10:00:00.000Z");
    const adapter = createInMemoryStorageAdapter({ now: () => now });
    const signed = await adapter.signUpload({
      key: "a",
      contentType: "text/plain",
      size: 3,
      expiresAt: new Date(now.getTime() + 1_000),
    });
    expect(await adapter.upload(signed.url, new Uint8Array(2), signed.headers)).toBe(400);
    now = new Date(now.getTime() + 2_000);
    expect(await adapter.upload(signed.url, new Uint8Array(3), signed.headers)).toBe(403);
    expect(await adapter.upload("memory://upload/unknown", new Uint8Array(3), signed.headers)).toBe(
      403,
    );
    expect(adapter.keys()).toEqual([]);
  });
});

describe("createInMemoryAttachmentLedger", () => {
  const at = new Date("2026-10-22T10:00:00.000Z");

  it("moves an intent through completion, attachment, detachment and purge", async () => {
    const ledger = createInMemoryAttachmentLedger();
    const intent = await ledger.createIntent({
      id: "intent-1",
      attachmentId: "gallery.photo",
      key: "gallery.photo/intent-1",
      contentType: "image/png",
      size: 10,
      actorId: "editor",
      createdAt: at,
      expiresAt: new Date(at.getTime() + 60_000),
    });
    expect(intent.status).toBe("pending");
    const settled = await ledger.completeIntent({
      intentId: "intent-1",
      objectId: "object-1",
      size: 10,
      contentType: "image/png",
      completedAt: at,
    });
    expect(settled?.object.status).toBe("uploaded");
    expect(
      await ledger.completeIntent({
        intentId: "intent-1",
        objectId: "object-2",
        size: 10,
        contentType: "image/png",
        completedAt: at,
      }),
    ).toBeUndefined();
    expect(
      await ledger.attach(undefined, {
        attachmentId: "other",
        ownerId: "owner",
        objectId: "object-1",
        attachedAt: at,
      }),
    ).toBeUndefined();
    const attached = await ledger.attach(undefined, {
      attachmentId: "gallery.photo",
      ownerId: "owner",
      objectId: "object-1",
      attachedAt: at,
    });
    expect(attached?.status).toBe("attached");
    expect(
      (await ledger.listObjects(undefined, "gallery.photo", "owner")).map((item) => item.id),
    ).toEqual(["object-1"]);
    await ledger.recordVariant("object-1", "thumb", {
      key: "gallery.photo/intent-1/variants/thumb.webp",
      contentType: "image/webp",
      size: 3,
    });
    const detached = await ledger.detach(undefined, {
      attachmentId: "gallery.photo",
      ownerId: "owner",
      requestedAt: at,
    });
    expect(detached.map((item) => item.status)).toEqual(["purging"]);
    expect((await ledger.readPurge("object-1"))?.keys).toEqual([
      "gallery.photo/intent-1",
      "gallery.photo/intent-1/variants/thumb.webp",
    ]);
    expect(await ledger.markPurged("object-1", at)).toBe(true);
    expect(await ledger.markPurged("object-1", at)).toBe(false);
    expect((await ledger.readObject(undefined, "object-1"))?.status).toBe("purged");
    expect(await ledger.listObjects(undefined, "gallery.photo", "owner")).toEqual([]);
  });

  it("claims expired intents and stale uploads once", async () => {
    const ledger = createInMemoryAttachmentLedger();
    for (const id of ["a", "b"]) {
      await ledger.createIntent({
        id,
        attachmentId: "gallery.photo",
        key: `gallery.photo/${id}`,
        contentType: "image/png",
        size: 1,
        actorId: "editor",
        createdAt: at,
        expiresAt: new Date(at.getTime() + (id === "a" ? 1_000 : 60_000)),
      });
    }
    await ledger.completeIntent({
      intentId: "b",
      objectId: "object-b",
      size: 1,
      contentType: "image/png",
      completedAt: at,
    });
    const later = new Date(at.getTime() + 5_000);
    expect((await ledger.claimExpiredIntents(later, 10)).map((item) => item.id)).toEqual(["a"]);
    expect(await ledger.claimExpiredIntents(later, 10)).toEqual([]);
    expect((await ledger.claimStaleObjects(later, 10)).map((item) => item.id)).toEqual([
      "object-b",
    ]);
    expect(await ledger.claimStaleObjects(later, 10)).toEqual([]);
    expect((await ledger.health()).detail).toBe("1 purges owed");
  });
});
