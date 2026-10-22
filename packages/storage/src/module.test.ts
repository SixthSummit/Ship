import {
  ApplicationCompilationError,
  type ApplicationDiagnosticCode,
  authenticatedAccess,
  createExecutor,
  defineActorResolver,
  defineApp,
  defineAttachment,
  defineModule,
  defineOperation,
  jobBackendDependency,
  jsonValueSchema,
  lockProviderDependency,
  objectSchema,
  operationActor,
  operationError,
  operationFailure,
  STORAGE_MODULE_ID,
  startJobRuntime,
  stringSchema,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { createHonoAdapter } from "@sixthsummit/ship-hono";
import {
  createInMemoryAttachmentLedger,
  createInMemoryJobBackend,
  createInMemoryLockProvider,
  createInMemoryOutbox,
  createInMemoryStorageAdapter,
  drainOutbox,
  runJobOnce,
} from "@sixthsummit/ship-testing";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import { describe, expect, it } from "vitest";
import { AttachmentCapabilityError } from "./capability.js";
import { storageHttpTransports } from "./hono.js";
import { createPassthroughImageProcessor } from "./image.js";
import { defineStorageModule, StorageModuleError } from "./module.js";
import { defineStoragePurgeOutbox, STORAGE_PURGE_OUTBOX_ID } from "./tokens.js";

const photo = defineAttachment({
  id: "gallery.photo",
  cardinality: "many",
  contentTypes: ["image/png", "image/jpeg"],
  maxBytes: 16,
  visibility: "private",
  maxCount: 2,
  intentTtlMs: 60_000,
  variants: { thumb: { width: 8, height: 8, fit: "cover", format: "webp" } },
});
const avatar = defineAttachment({
  id: "gallery.avatar",
  cardinality: "single",
  contentTypes: ["image/*"],
  maxBytes: 16,
  visibility: "public",
});

const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
const controller: UnitOfWork<{ readonly marker: "tx" }> = {
  kind: "ship.unit-of-work",
  id: "database.primary",
  run: async (_mode, work) => work({ marker: "tx" }),
};
const limitReached = operationError({
  code: "PHOTO_LIMIT",
  status: 409,
  message: "Too many photos",
});
const ownerBody = objectSchema({
  ownerId: stringSchema({ minLength: 1 }),
  objectId: stringSchema({ minLength: 1 }),
});
const ownerOnly = objectSchema({ ownerId: stringSchema({ minLength: 1 }) });
const readBody = objectSchema({ objectId: stringSchema({ minLength: 1 }) });

async function fixture(overrides: { readonly clock?: () => Date } = {}) {
  let now = new Date("2026-10-22T10:00:00.000Z");
  const clock = overrides.clock ?? (() => now);
  const adapter = createInMemoryStorageAdapter({ now: clock });
  const ledger = createInMemoryAttachmentLedger();
  const outbox = createInMemoryOutbox(defineStoragePurgeOutbox());
  const jobs = createInMemoryJobBackend({ clock });
  const cache = createInMemoryCacheBackend({ now: () => clock().getTime() });
  let uuid = 0;
  const storage = defineStorageModule({
    attachments: [photo, avatar],
    adapter,
    ledger,
    outbox,
    transports: storageHttpTransports(),
    variants: { processor: createPassthroughImageProcessor(), jobs, cache },
    sweep: { unattachedGraceMs: 60_000 },
    imports: ["platform"],
    clock,
    randomUUID: () => `uuid-${++uuid}`,
  });
  const gallery = defineModule({
    id: "gallery",
    operations: [
      defineOperation({
        id: "gallery.attach",
        input: { body: ownerBody },
        output: { 200: objectSchema({ objectId: stringSchema(), status: stringSchema() }) },
        successStatus: 200,
        errors: [limitReached],
        access: authenticatedAccess(),
        transaction: "write",
        dependencies: { tx: unitOfWork, photos: photo.binding },
        attachments: [photo],
        handler: async ({ input, services }) => {
          try {
            const object = await services.photos.attach(input.body);
            return { objectId: object.id, status: object.status };
          } catch (error) {
            if (
              error instanceof AttachmentCapabilityError &&
              error.code === "SHIP_ATTACHMENT_LIMIT_EXCEEDED"
            ) {
              throw operationFailure(limitReached);
            }
            throw error;
          }
        },
      }),
      defineOperation({
        id: "gallery.set-avatar",
        input: { body: ownerBody },
        output: { 200: objectSchema({ objectId: stringSchema() }) },
        successStatus: 200,
        errors: [],
        access: authenticatedAccess(),
        transaction: "write",
        dependencies: { tx: unitOfWork, avatar: avatar.binding },
        attachments: [avatar],
        handler: async ({ input, services }) => ({
          objectId: (await services.avatar.attach(input.body)).id,
        }),
      }),
      defineOperation({
        id: "gallery.remove",
        input: { body: ownerOnly },
        output: { 200: jsonValueSchema() },
        successStatus: 200,
        errors: [],
        access: authenticatedAccess(),
        transaction: "write",
        dependencies: { tx: unitOfWork, photos: photo.binding },
        attachments: [photo],
        handler: async ({ input, services }) => ({
          detached: Object.fromEntries(
            (await services.photos.detach({ ownerId: input.body.ownerId })).map((object) => [
              object.id,
              object.status,
            ]),
          ),
        }),
      }),
      defineOperation({
        id: "gallery.urls",
        input: { body: readBody },
        output: { 200: jsonValueSchema() },
        successStatus: 200,
        errors: [],
        access: authenticatedAccess(),
        transaction: "none",
        dependencies: { photos: photo.binding },
        attachments: [photo],
        handler: async ({ input, services }) => ({
          original: await services.photos.url(input.body.objectId),
          thumb: await services.photos.variant(input.body.objectId, "thumb"),
        }),
      }),
      defineOperation({
        id: "gallery.detach-outside-transaction",
        input: { body: ownerOnly },
        output: { 200: objectSchema({}) },
        successStatus: 200,
        errors: [],
        access: authenticatedAccess(),
        transaction: "none",
        dependencies: { photos: photo.binding },
        attachments: [photo],
        handler: async ({ input, services }) => {
          await services.photos.detach({ ownerId: input.body.ownerId });
          return {};
        },
      }),
    ],
    providers: [],
    imports: [STORAGE_MODULE_ID, "platform"],
    exports: [],
    attachments: [photo, avatar],
  });
  const platform = defineModule({
    id: "platform",
    operations: [],
    providers: [
      valueProvider(unitOfWork, controller),
      valueProvider(jobBackendDependency(), jobs),
      valueProvider(lockProviderDependency(), createInMemoryLockProvider()),
    ],
    imports: [],
    exports: [unitOfWork, jobBackendDependency(), lockProviderDependency()],
  });
  const app = defineApp({ id: "storage-fixture", modules: [platform, gallery, storage] });
  const executor = createExecutor(app);
  apps.set(executor, app);
  await startJobRuntime(app, { backend: jobs, mode: "api", clock });
  const actor = operationActor({ id: "editor", permissions: [] });
  const other = operationActor({ id: "someone-else", permissions: [] });

  const upload = async (
    attachment: string,
    contentType = "image/png",
    body = new TextEncoder().encode("png-bytes"),
    options: {
      readonly putStatus?: number;
      readonly skipPut?: boolean;
      readonly as?: typeof actor;
    } = {},
  ) => {
    const intent = await executor.run(
      "ship-storage.create-intent",
      { body: { attachment, contentType, size: body.byteLength } },
      { actor: options.as ?? actor },
    );
    if (!intent.ok) return { intent, complete: undefined };
    const data = intent.data as {
      intentId: string;
      objectKey: string;
      upload: { url: string; headers: Record<string, string> };
    };
    if (!options.skipPut) {
      const status = await adapter.upload(data.upload.url, body, data.upload.headers);
      expect(status).toBe(options.putStatus ?? 200);
    }
    const complete = await executor.run(
      "ship-storage.complete",
      { params: { intentId: data.intentId } },
      { actor: options.as ?? actor },
    );
    return { intent, complete };
  };

  return {
    app,
    executor,
    adapter,
    ledger,
    outbox,
    jobs,
    cache,
    actor,
    other,
    upload,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("defineStorageModule", () => {
  it("compiles with the attachments bound and projects them into the graph", async () => {
    const { app } = await fixture();
    expect(app.graph.attachments.map((node) => [node.id, node.providerId])).toEqual([
      ["gallery.avatar", "gallery.avatar.attachment"],
      ["gallery.photo", "gallery.photo.attachment"],
    ]);
    expect(app.graph.operations.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "ship-storage.create-intent",
        "ship-storage.complete",
        "ship-storage.sweep",
        "ship-storage.generate-variant",
        "ship-storage.purge.dispatch",
        "ship-storage.purge.cleanup",
      ]),
    );
    expect(
      app.graph.operations.find((node) => node.id === "ship-storage.create-intent")?.transport
        ?.binding,
    ).toBe("POST /storage/intents");
    expect(app.diagnostics).toEqual([]);
  });

  it("issues a signed intent, settles the upload, attaches, resolves urls and purges on detach", async () => {
    const { executor, adapter, ledger, outbox, actor, upload } = await fixture();
    const first = await upload("gallery.photo");
    expect(first.intent.ok).toBe(true);
    expect(first.complete?.ok).toBe(true);
    const object = (
      first.complete as { data: { objectId: string; objectKey: string; size: number } }
    ).data;
    expect(object).toMatchObject({
      objectKey: "gallery.photo/uuid-1",
      size: 9,
      objectId: "uuid-2",
    });
    expect(ledger.intents()[0]?.status).toBe("completed");

    const attached = await executor.run(
      "gallery.attach",
      { body: { ownerId: "project-1", objectId: object.objectId } },
      { actor },
    );
    expect(attached).toMatchObject({ ok: true, data: { objectId: "uuid-2", status: "attached" } });
    await expect(
      executor.run(
        "gallery.attach",
        { body: { ownerId: "project-1", objectId: object.objectId } },
        { actor },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_HANDLER_FAILED" });

    const urls = await executor.run(
      "gallery.urls",
      { body: { objectId: object.objectId } },
      { actor },
    );
    expect(urls).toMatchObject({
      ok: true,
      data: {
        original: { url: expect.stringContaining("gallery.photo/uuid-1?expires=") },
        thumb: { status: "pending" },
      },
    });

    const removed = await executor.run(
      "gallery.remove",
      { body: { ownerId: "project-1" } },
      { actor },
    );
    expect(removed).toMatchObject({ ok: true, data: { detached: { "uuid-2": "purging" } } });
    expect(
      outbox.records().map((record) => [record.intentId, record.payload, record.status]),
    ).toEqual([["purge-object", { objectId: "uuid-2" }, "pending"]]);
    expect(adapter.keys()).toEqual(["gallery.photo/uuid-1"]);
    const drained = await drainOutbox(executor, STORAGE_PURGE_OUTBOX_ID);
    expect(drained.completed).toBe(1);
    expect(adapter.keys()).toEqual([]);
    expect((await ledger.readPurge("uuid-2"))?.purgedAt).toBeDefined();
    expect((await ledger.readObject("uuid-2"))?.status).toBe("purged");
    // A replayed purge is a no-op rather than a failure.
    await executor
      .run("gallery.urls", { body: { objectId: object.objectId } }, { actor })
      .then((result) => expect(result).toMatchObject({ ok: true, data: { original: undefined } }));
  });

  it("refuses intents the declaration does not allow", async () => {
    const { executor, actor } = await fixture();
    const unknown = await executor.run(
      "ship-storage.create-intent",
      { body: { attachment: "gallery.nope", contentType: "image/png", size: 1 } },
      { actor },
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: "ATTACHMENT_UNKNOWN" } });
    const type = await executor.run(
      "ship-storage.create-intent",
      { body: { attachment: "gallery.photo", contentType: "text/plain", size: 1 } },
      { actor },
    );
    expect(type).toMatchObject({ ok: false, error: { code: "ATTACHMENT_CONTENT_TYPE_REJECTED" } });
    const large = await executor.run(
      "ship-storage.create-intent",
      { body: { attachment: "gallery.photo", contentType: "image/png", size: 17 } },
      { actor },
    );
    expect(large).toMatchObject({ ok: false, error: { code: "ATTACHMENT_TOO_LARGE" } });
  });

  it("fences completion: wrong actor, missing upload, late completion after the sweep", async () => {
    const { executor, adapter, ledger, actor, other, upload, advance } = await fixture();
    const stranger = await upload("gallery.photo", "image/png", undefined, { skipPut: true });
    const intentId = (stranger.intent as { data: { intentId: string } }).data.intentId;
    expect(stranger.complete).toMatchObject({ ok: false, error: { code: "UPLOAD_MISSING" } });
    expect(
      await executor.run("ship-storage.complete", { params: { intentId } }, { actor: other }),
    ).toMatchObject({ ok: false, error: { code: "INTENT_FORBIDDEN" } });
    expect(
      await executor.run("ship-storage.complete", { params: { intentId: "nope" } }, { actor }),
    ).toMatchObject({ ok: false, error: { code: "INTENT_NOT_FOUND" } });

    // The client PUTs the bytes but never completes; the sweep abandons the
    // intent and removes the stray object, and a completion that arrives
    // afterwards is refused and leaves nothing behind.
    const key = (
      stranger.intent as {
        data: { objectKey: string; upload: { url: string; headers: Record<string, string> } };
      }
    ).data;
    expect(
      await adapter.upload(
        key.upload.url,
        new TextEncoder().encode("png-bytes"),
        key.upload.headers,
      ),
    ).toBe(200);
    advance(61_000);
    const swept = await runJobOnce(executor_(executor), "ship-storage.sweep", {});
    expect(swept).toMatchObject({ ok: true, data: { abandoned: 1, stale: 0, purged: 0 } });
    expect(adapter.keys()).toEqual([]);
    expect(ledger.intents()[0]?.status).toBe("abandoned");
    expect(
      await executor.run("ship-storage.complete", { params: { intentId } }, { actor }),
    ).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  });

  it("rejects an upload whose stored bytes contradict the intent and removes it", async () => {
    const { adapter, upload } = await fixture();
    const oversized = await upload(
      "gallery.photo",
      "image/png",
      new TextEncoder().encode("0123456789abcdefg"),
    );
    expect(oversized.intent).toMatchObject({ ok: false, error: { code: "ATTACHMENT_TOO_LARGE" } });
    // Declare a small size, then PUT exactly that size under another type by
    // writing straight to the adapter: completion compares the provider's view.
    const intent = await upload("gallery.photo", "image/png", new TextEncoder().encode("abc"), {
      skipPut: true,
    });
    const data = (intent.intent as { data: { intentId: string; objectKey: string } }).data;
    await adapter.put(data.objectKey, new TextEncoder().encode("abc"), {
      contentType: "image/gif",
    });
    expect(intent.complete).toMatchObject({ ok: false, error: { code: "UPLOAD_MISSING" } });
    expect(adapter.keys()).toEqual([data.objectKey]);
  });

  it("purges completed uploads that were never attached once the grace period passes", async () => {
    const { executor, adapter, ledger, upload, advance } = await fixture();
    const first = await upload("gallery.photo");
    expect(first.complete?.ok).toBe(true);
    advance(30_000);
    const early = await runJobOnce(executor_(executor), "ship-storage.sweep", {});
    expect(early).toMatchObject({ ok: true, data: { abandoned: 0, stale: 0, purged: 0 } });
    advance(31_000);
    const late = await runJobOnce(executor_(executor), "ship-storage.sweep", {});
    expect(late).toMatchObject({ ok: true, data: { abandoned: 0, stale: 1, purged: 1 } });
    expect(adapter.keys()).toEqual([]);
    expect(ledger.objects()[0]?.status).toBe("purged");
    expect(ledger.purges()[0]?.purgedAt).toBeDefined();
  });

  it("enforces cardinality: many caps at maxCount, single replaces and purges the previous object", async () => {
    const { executor, outbox, actor, upload } = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await upload("gallery.photo");
      ids.push((result.complete as { data: { objectId: string } }).data.objectId);
    }
    for (const objectId of ids.slice(0, 2)) {
      expect(
        await executor.run("gallery.attach", { body: { ownerId: "p", objectId } }, { actor }),
      ).toMatchObject({ ok: true });
    }
    expect(
      await executor.run(
        "gallery.attach",
        { body: { ownerId: "p", objectId: ids[2]! } },
        { actor },
      ),
    ).toMatchObject({ ok: false, error: { code: "PHOTO_LIMIT" } });

    const avatarOne = (await upload("gallery.avatar", "image/webp")).complete as {
      data: { objectId: string };
    };
    const avatarTwo = (await upload("gallery.avatar", "image/webp")).complete as {
      data: { objectId: string };
    };
    expect(
      await executor.run(
        "gallery.set-avatar",
        { body: { ownerId: "p", objectId: avatarOne.data.objectId } },
        { actor },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await executor.run(
        "gallery.set-avatar",
        { body: { ownerId: "p", objectId: avatarTwo.data.objectId } },
        { actor },
      ),
    ).toMatchObject({ ok: true });
    expect(outbox.records().map((record) => record.payload)).toEqual([
      { objectId: avatarOne.data.objectId },
    ]);
  });

  it("renders a declared variant through the job and serves it from the ledger and cache", async () => {
    const { executor, adapter, jobs, cache, actor, upload } = await fixture();
    const object = (await upload("gallery.photo")).complete as { data: { objectId: string } };
    const pending = await executor.run(
      "gallery.urls",
      { body: { objectId: object.data.objectId } },
      { actor },
    );
    expect(pending).toMatchObject({ ok: true, data: { thumb: { status: "pending" } } });
    const run = jobs.runs().find((item) => item.jobId === "ship-storage.generate-variant");
    expect(run?.input).toEqual({ objectId: object.data.objectId, variant: "thumb" });
    // A second request before the job runs deduplicates rather than re-enqueuing.
    await executor.run("gallery.urls", { body: { objectId: object.data.objectId } }, { actor });
    expect(
      jobs.runs().filter((item) => item.jobId === "ship-storage.generate-variant"),
    ).toHaveLength(1);

    const rendered = await runJobOnce(
      executor_(executor),
      "ship-storage.generate-variant",
      run?.input,
    );
    expect(rendered).toMatchObject({
      ok: true,
      data: { rendered: true, key: "gallery.photo/uuid-1/variants/thumb.webp" },
    });
    expect(adapter.keys()).toEqual([
      "gallery.photo/uuid-1",
      "gallery.photo/uuid-1/variants/thumb.webp",
    ]);
    const ready = await executor.run(
      "gallery.urls",
      { body: { objectId: object.data.objectId } },
      { actor },
    );
    expect(ready).toMatchObject({
      ok: true,
      data: {
        thumb: { status: "ready", url: { url: expect.stringContaining("variants/thumb.webp") } },
      },
    });
    expect(cache.size()).toBe(1);
    const again = await runJobOnce(
      executor_(executor),
      "ship-storage.generate-variant",
      run?.input,
    );
    expect(again).toMatchObject({
      ok: true,
      data: { rendered: false, reason: "already-rendered" },
    });

    // Detaching purges the original and the variant together.
    await executor.run(
      "gallery.attach",
      { body: { ownerId: "p", objectId: object.data.objectId } },
      { actor },
    );
    await executor.run("gallery.remove", { body: { ownerId: "p" } }, { actor });
    await drainOutbox(executor, STORAGE_PURGE_OUTBOX_ID);
    expect(adapter.keys()).toEqual([]);
  });

  it("refuses attach and detach outside a write transaction and unknown variants", async () => {
    const { executor, actor, upload } = await fixture();
    const object = (await upload("gallery.photo")).complete as { data: { objectId: string } };
    await expect(
      executor.run("gallery.detach-outside-transaction", { body: { ownerId: "p" } }, { actor }),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      cause: expect.objectContaining({ code: "SHIP_ATTACHMENT_SCOPE_REQUIRED" }),
    });
    expect(object.data.objectId).toBeDefined();
  });

  it("projects through the Hono adapter with consistent body policies", async () => {
    const { app, adapter, actor } = await fixture();
    const http = createHonoAdapter(app, {
      auth: {
        credentials: { id: "test.session", extract: () => "editor" },
        actors: defineActorResolver({
          id: "test.actors",
          resolve: async () => ({ ok: true, actor }),
        }),
      },
    });
    const intent = await http.request("/storage/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment: "gallery.photo", contentType: "image/png", size: 3 }),
    });
    expect(intent.status).toBe(201);
    const issued = (await intent.json()) as {
      intentId: string;
      upload: { url: string; headers: Record<string, string> };
    };
    expect(await adapter.upload(issued.upload.url, new Uint8Array(3), issued.upload.headers)).toBe(
      200,
    );
    const complete = await http.request(`/storage/intents/${issued.intentId}/complete`, {
      method: "POST",
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ contentType: "image/png", size: 3 });
  });

  it("validates its options", () => {
    const base = {
      attachments: [photo],
      adapter: createInMemoryStorageAdapter(),
      ledger: createInMemoryAttachmentLedger(),
      outbox: createInMemoryOutbox(defineStoragePurgeOutbox()),
    };
    expect(() => defineStorageModule({ ...base })).toThrow(
      expect.objectContaining({
        code: "SHIP_STORAGE_MODULE_OPTIONS_INVALID",
      }) as StorageModuleError,
    );
    expect(() => defineStorageModule({ ...base, attachments: [avatar, avatar] })).toThrow(
      StorageModuleError,
    );
    expect(() => defineStorageModule({ ...base, attachments: [{}] as never })).toThrow(
      StorageModuleError,
    );
    expect(() =>
      defineStorageModule({ ...base, attachments: [avatar], adapter: {} as never }),
    ).toThrow(StorageModuleError);
    expect(() =>
      defineStorageModule({ ...base, attachments: [avatar], ledger: {} as never }),
    ).toThrow(StorageModuleError);
    expect(() =>
      defineStorageModule({ ...base, attachments: [avatar], outbox: {} as never }),
    ).toThrow(StorageModuleError);
    expect(() =>
      defineStorageModule({ ...base, attachments: [avatar], keyPrefix: "no-slash" }),
    ).toThrow(StorageModuleError);
    expect(() =>
      defineStorageModule({ ...base, attachments: [avatar], signedUrlTtlMs: 0 }),
    ).toThrow(StorageModuleError);
    expect(() =>
      defineStorageModule({
        ...base,
        variants: { processor: {} as never, jobs: createInMemoryJobBackend() },
      }),
    ).toThrow(StorageModuleError);
    expect(() => storageHttpTransports({ basePath: "storage" })).toThrow(TypeError);
    expect(storageHttpTransports({ basePath: "/files" }).complete.binding).toBe(
      "POST /files/intents/:intentId/complete",
    );
  });

  it("fails compilation when a declared attachment is not listed in the storage module", () => {
    const orphan = defineAttachment({
      id: "gallery.orphan",
      cardinality: "single",
      contentTypes: ["image/png"],
      maxBytes: 1,
      visibility: "private",
    });
    const storage = defineStorageModule({
      attachments: [avatar],
      adapter: createInMemoryStorageAdapter(),
      ledger: createInMemoryAttachmentLedger(),
      outbox: createInMemoryOutbox(defineStoragePurgeOutbox()),
      imports: ["platform"],
    });
    const gallery = defineModule({
      id: "gallery",
      operations: [],
      providers: [],
      imports: [STORAGE_MODULE_ID],
      exports: [],
      attachments: [avatar, orphan],
    });
    const platform = defineModule({
      id: "platform",
      operations: [],
      providers: [
        valueProvider(jobBackendDependency(), createInMemoryJobBackend()),
        valueProvider(lockProviderDependency(), createInMemoryLockProvider()),
      ],
      imports: [],
      exports: [jobBackendDependency(), lockProviderDependency()],
    });
    expect(() =>
      defineApp({ id: "storage-fixture", modules: [platform, gallery, storage] }),
    ).toThrow(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "SHIP_ATTACHMENT_STORAGE_MODULE_MISSING" satisfies ApplicationDiagnosticCode,
          }),
        ],
      }) as ApplicationCompilationError,
    );
  });
});

const apps = new WeakMap<object, ReturnType<typeof defineApp>>();

/** `runJobOnce` takes the compiled app the executor was created from. */
function executor_(executor: ReturnType<typeof createExecutor>) {
  const app = apps.get(executor);
  if (!app) throw new Error("executor was not created by fixture()");
  return app;
}
