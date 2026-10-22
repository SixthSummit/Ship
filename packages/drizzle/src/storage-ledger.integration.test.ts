import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDrizzleAttachmentLedger,
  shipStorageIntentsTable,
  shipStorageObjectsTable,
  shipStoragePurgesTable,
} from "./storage-ledger.js";
import { createDrizzleUnitOfWork } from "./unit-of-work.js";

const intents = shipStorageIntentsTable();
const objects = shipStorageObjectsTable();
const purges = shipStoragePurgesTable();
const schema = { intents, objects, purges };

const at = new Date("2026-10-22T10:00:00.000Z");
const INTENT_A = "11111111-1111-4111-8111-111111111111";
const INTENT_B = "22222222-2222-4222-8222-222222222222";
const OBJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OBJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("createDrizzleAttachmentLedger", () => {
  let database: PostgresTestDb<typeof schema>;
  let ledger: ReturnType<typeof createDrizzleAttachmentLedger>;

  beforeAll(async () => {
    database = await setupPostgresTestDb(schema);
    ledger = createDrizzleAttachmentLedger({ database: database.db, intents, objects, purges });
  });

  afterAll(async () => {
    await database.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(database);
  });

  async function pendingIntent(id: string, expiresInMs = 60_000) {
    return ledger.createIntent({
      id,
      attachmentId: "gallery.photo",
      key: `gallery.photo/${id}`,
      contentType: "image/png",
      size: 3,
      actorId: "editor",
      createdAt: at,
      expiresAt: new Date(at.getTime() + expiresInMs),
    });
  }

  it("completes a pending intent exactly once and fences a late completion", async () => {
    await pendingIntent(INTENT_A);
    const settled = await ledger.completeIntent({
      intentId: INTENT_A,
      objectId: OBJECT_A,
      size: 3,
      contentType: "image/png",
      completedAt: at,
    });
    expect(settled?.intent.status).toBe("completed");
    expect(settled?.object).toMatchObject({
      id: OBJECT_A,
      key: `gallery.photo/${INTENT_A}`,
      status: "uploaded",
      uploadedBy: "editor",
      variants: {},
    });
    expect(
      await ledger.completeIntent({
        intentId: INTENT_A,
        objectId: OBJECT_B,
        size: 3,
        contentType: "image/png",
        completedAt: at,
      }),
    ).toBeUndefined();
    expect((await ledger.readIntent(INTENT_A))?.objectId).toBe(OBJECT_A);
    // The object insert and the intent update are one transaction: no second object.
    const [{ count }] = await database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(objects);
    expect(count).toBe(1);
  });

  it("abandons expired intents once across concurrent sweepers", async () => {
    await pendingIntent(INTENT_A, 1_000);
    await pendingIntent(INTENT_B, 120_000);
    const later = new Date(at.getTime() + 5_000);
    const [first, second] = await Promise.all([
      ledger.claimExpiredIntents(later, 10),
      ledger.claimExpiredIntents(later, 10),
    ]);
    expect([...first, ...second].map((intent) => intent.id)).toEqual([INTENT_A]);
    expect((await ledger.readIntent(INTENT_A))?.status).toBe("abandoned");
    expect((await ledger.readIntent(INTENT_B))?.status).toBe("pending");
    expect(
      await ledger.completeIntent({
        intentId: INTENT_A,
        objectId: OBJECT_A,
        size: 3,
        contentType: "image/png",
        completedAt: later,
      }),
    ).toBeUndefined();
  });

  it("attaches and detaches inside the unit of work and rolls back with it", async () => {
    await pendingIntent(INTENT_A);
    await ledger.completeIntent({
      intentId: INTENT_A,
      objectId: OBJECT_A,
      size: 3,
      contentType: "image/png",
      completedAt: at,
    });
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database: database.db,
      create: () => ({ marker: "tx" as const }),
    });

    await expect(
      unitOfWork.run("write", async (scope) => {
        const attached = await ledger.attach(scope, {
          attachmentId: "gallery.photo",
          ownerId: "project-1",
          objectId: OBJECT_A,
          attachedAt: at,
        });
        expect(attached?.status).toBe("attached");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await ledger.readObject(OBJECT_A))?.status).toBe("uploaded");

    await unitOfWork.run("write", async (scope) => {
      await ledger.attach(scope, {
        attachmentId: "gallery.photo",
        ownerId: "project-1",
        objectId: OBJECT_A,
        attachedAt: at,
      });
    });
    expect((await ledger.listObjects("gallery.photo", "project-1")).map((item) => item.id)).toEqual(
      [OBJECT_A],
    );
    expect(
      await ledger.attach(undefined, {
        attachmentId: "gallery.photo",
        ownerId: "project-2",
        objectId: OBJECT_A,
        attachedAt: at,
      }),
    ).toBeUndefined();

    await ledger.recordVariant(OBJECT_A, "thumb", {
      key: `gallery.photo/${INTENT_A}/variants/thumb.webp`,
      contentType: "image/webp",
      size: 1,
    });
    await expect(
      unitOfWork.run("write", async (scope) => {
        const detached = await ledger.detach(scope, {
          attachmentId: "gallery.photo",
          ownerId: "project-1",
          requestedAt: at,
        });
        expect(detached.map((item) => item.status)).toEqual(["purging"]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await ledger.readObject(OBJECT_A))?.status).toBe("attached");
    expect(await ledger.readPurge(OBJECT_A)).toBeUndefined();

    await unitOfWork.run("write", async (scope) => {
      await ledger.detach(scope, {
        attachmentId: "gallery.photo",
        ownerId: "project-1",
        objectId: OBJECT_A,
        requestedAt: at,
      });
    });
    const purge = await ledger.readPurge(OBJECT_A);
    expect(purge?.keys).toEqual([
      `gallery.photo/${INTENT_A}`,
      `gallery.photo/${INTENT_A}/variants/thumb.webp`,
    ]);
    expect(await ledger.listObjects("gallery.photo", "project-1")).toEqual([]);
    expect(await ledger.markPurged(OBJECT_A, at)).toBe(true);
    expect(await ledger.markPurged(OBJECT_A, at)).toBe(false);
    expect((await ledger.readObject(OBJECT_A))?.status).toBe("purged");
    expect((await ledger.readPurge(OBJECT_A))?.attempts).toBe(1);
  });

  it("claims stale uploads with a purge row and reports owed purges", async () => {
    await pendingIntent(INTENT_A);
    await pendingIntent(INTENT_B);
    for (const [intentId, objectId] of [
      [INTENT_A, OBJECT_A],
      [INTENT_B, OBJECT_B],
    ] as const) {
      await ledger.completeIntent({
        intentId,
        objectId,
        size: 3,
        contentType: "image/png",
        completedAt: at,
      });
    }
    await ledger.attach(undefined, {
      attachmentId: "gallery.photo",
      ownerId: "p",
      objectId: OBJECT_B,
      attachedAt: at,
    });
    const stale = await ledger.claimStaleObjects(new Date(at.getTime() + 1), 10);
    expect(stale.map((item) => item.id)).toEqual([OBJECT_A]);
    expect(await ledger.claimStaleObjects(new Date(at.getTime() + 1), 10)).toEqual([]);
    expect((await ledger.readPurge(OBJECT_A))?.keys).toEqual([`gallery.photo/${INTENT_A}`]);
    expect(await ledger.health()).toEqual({ available: true, detail: "1 purges owed" });
  });
});
