import {
  type AttachmentCapability,
  cacheBackendDependency,
  channelPublisherProvider,
  defineApp,
  defineAttachment,
  defineChannel,
  defineModule,
  defineOperation,
  defineOutbox,
  defineOutboxDispatcher,
  defineRichText,
  defineRichTextExtension,
  effectDependency,
  idempotencyStoreDependency,
  outboxIntent,
  publicAccess,
  type RealtimePublishBackend,
  type RichTextCapability,
  type RuntimeSchema,
  STORAGE_MODULE_ID,
  valueProvider,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { projectClientContract } from "./project.js";
import { ContractProjectionError, contractSchema } from "./schema.js";

describe("projectClientContract", () => {
  it("projects a deterministic, immutable, handler-free client contract", () => {
    const operation = defineOperation({
      id: "accounts.read",
      transport: http.get("/accounts/:accountId"),
      input: { params: z.object({ accountId: z.string().uuid() }) },
      output: { 200: z.object({ accountId: z.string().uuid(), name: z.string() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ accountId: input.params.accountId, name: "Ada" }),
    });
    const module = defineModule({
      id: "accounts",
      operations: [operation],
      providers: [],
      imports: [],
      exports: [],
    });
    const app = defineApp({ id: "contract-fixture", modules: [module] });

    const first = projectClientContract(app);
    const second = projectClientContract(app);

    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.operations[0]).toMatchObject({
      id: "accounts.read",
      input: {
        params: {
          vendor: "zod",
          jsonSchema: { type: "object", required: ["accountId"] },
        },
      },
      success: [{ status: 200, vendor: "zod" }],
      access: { kind: "public" },
      transport: {
        kind: "http",
        binding: "GET /accounts/:accountId",
      },
    });
    expect(JSON.stringify(first)).not.toContain("handler");
    expect(JSON.stringify(first)).not.toContain("dependencies");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operations[0].input.params.jsonSchema)).toBe(true);
  });

  it("produces the same contract when module declaration order changes", () => {
    const alpha = moduleWithOperation("alpha.read", "/alpha");
    const beta = moduleWithOperation("beta.read", "/beta");
    const forward = projectClientContract(defineApp({ id: "ordered", modules: [alpha, beta] }));
    const reversed = projectClientContract(defineApp({ id: "ordered", modules: [beta, alpha] }));

    expect(reversed).toEqual(forward);
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it("changes the fingerprint when a wire contract changes", () => {
    const first = projectClientContract(
      defineApp({ id: "fingerprint", modules: [moduleWithOperation("alpha.read", "/alpha")] }),
    );
    const second = projectClientContract(
      defineApp({ id: "fingerprint", modules: [moduleWithOperation("alpha.read", "/alpha-v2")] }),
    );

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("rejects schemas that have no safe projection with a stable location", () => {
    const unsupported = standardSchema("custom", (value) => ({ value }));
    const operation = defineOperation({
      id: "custom.read",
      transport: http.get("/custom"),
      input: {},
      output: { 200: unsupported },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => "ok",
    });
    const app = defineApp({
      id: "unsupported",
      modules: [
        defineModule({
          id: "custom",
          operations: [operation],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });

    expect(() => projectClientContract(app)).toThrowError(
      expect.objectContaining({
        name: "ContractProjectionError",
        code: "SHIP_CONTRACT_SCHEMA_UNSUPPORTED",
        operationId: "custom.read",
        path: "output.200",
      }),
    );
  });

  it("projects idempotency windows and framework outbox operations", () => {
    const store = idempotencyStoreDependency("platform.idempotency");
    const notifier = effectDependency<{ send(): Promise<void> }>("mail.notifier", {
      delivery: "immediate",
    });
    const outbox = defineOutbox({
      id: "mail.outbox",
      intents: {
        send: outboxIntent({ payload: z.object({}), effect: notifier, perform: () => undefined }),
      },
    });
    const dispatcher = defineOutboxDispatcher(outbox, {
      batchSize: 1,
      lease: { ms: 1 },
      retry: { attempts: 1, backoff: { initialMs: 0 } },
      deadLetter: true,
    });
    const operation = defineOperation({
      id: "mail.send",
      transport: http.post("/mail"),
      input: { body: z.object({ key: z.string() }) },
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      idempotency: { key: (input) => input.body.key, windowMs: 5_000, store },
      handler: () => ({ ok: true as const }),
    });
    const contract = projectClientContract(
      defineApp({
        id: "idempotent",
        modules: [
          defineModule({
            id: "mail",
            operations: [operation, ...dispatcher.operations],
            providers: [
              valueProvider(store, { kind: "ship.idempotency-store" } as never),
              valueProvider(outbox.writer, { kind: "ship.outbox-backend" } as never),
              valueProvider(notifier, { send: async () => undefined }),
            ],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );
    const byId = Object.fromEntries(contract.operations.map((item) => [item.id, item]));

    expect(byId["mail.send"]).toMatchObject({ idempotency: { windowMs: 5_000 } });
    expect(byId["mail.outbox.dispatch"]).toMatchObject({
      access: { kind: "system" },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            required: ["batchSize", "claimed", "completed", "deadLettered", "retried"],
          },
        },
      ],
    });
    expect(byId["mail.outbox.retry"]).toMatchObject({
      access: { kind: "permissions", permissions: ["ship.outbox:manage"] },
      input: { body: { vendor: "ship", jsonSchema: { required: ["recordId"] } } },
      errors: [{ code: "OUTBOX_RECORD_NOT_FOUND", status: 404 }],
    });
  });

  it("accepts explicit JSON Schema and codec metadata for non-JSON runtime values", () => {
    const dateSchema = contractSchema(z.date(), {
      jsonSchema: { type: "string", format: "date-time" },
      codec: "date.iso",
    });
    const operation = defineOperation({
      id: "clock.read",
      transport: http.get("/clock"),
      input: {},
      output: { 200: dateSchema },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => new Date("2026-09-04T00:00:00.000Z"),
    });
    const contract = projectClientContract(
      defineApp({
        id: "codec",
        modules: [
          defineModule({
            id: "clock",
            operations: [operation],
            providers: [],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );

    expect(contract.operations[0].success[0]).toMatchObject({
      codec: "date.iso",
      jsonSchema: { type: "string", format: "date-time" },
    });
  });

  it("projects the wire input before Zod defaults and transforms", () => {
    const query = z.object({
      limit: z.string().regex(/^\d+$/u).default("50").transform(Number),
      unassigned: z
        .enum(["true", "false"])
        .optional()
        .transform((value) => value === "true"),
    });
    const operation = defineOperation({
      id: "leads.list",
      transport: http.get("/leads"),
      input: { query },
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ total: input.query.limit }),
    });
    const contract = projectClientContract(
      defineApp({
        id: "normalized-input",
        modules: [
          defineModule({
            id: "leads",
            operations: [operation],
            providers: [],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );

    expect(contract.operations[0].input.query.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        limit: { type: "string", default: "50", pattern: "^\\d+$" },
        unassigned: { type: "string", enum: ["true", "false"] },
      },
    });
  });

  it.each([
    204, 205,
  ] as const)("projects %s and binary representations without pretending they are JSON", (status) => {
    const clear = defineOperation({
      id: "files.clear",
      transport: http.delete("/files"),
      input: {},
      output: { [status]: z.undefined() },
      successStatus: status,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => undefined,
    });
    const download = defineOperation({
      id: "files.download",
      transport: http.get("/files/archive", { response: "binary" }),
      input: {},
      output: { 200: z.instanceof(Uint8Array) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => new Uint8Array(),
    });
    const contract = projectClientContract(
      defineApp({
        id: "representations",
        modules: [
          defineModule({
            id: "files",
            operations: [clear, download],
            providers: [],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );

    expect(contract.operations[0].success[0].jsonSchema).toEqual({});
    expect(contract.operations[1].success[0].jsonSchema).toEqual({
      format: "binary",
      type: "string",
    });
  });

  it("validates explicit codec ids and JSON metadata", () => {
    expect(() =>
      contractSchema(z.string(), { jsonSchema: { type: "string" }, codec: "Date ISO" }),
    ).toThrowError(
      expect.objectContaining<Partial<ContractProjectionError>>({
        code: "SHIP_CONTRACT_CODEC_INVALID",
      }),
    );
    expect(() =>
      contractSchema(z.string(), {
        jsonSchema: { type: "number", maximum: Number.POSITIVE_INFINITY },
      }),
    ).toThrow("finite");
    expect(() => contractSchema({} as never, { jsonSchema: {} })).toThrowError(
      expect.objectContaining<Partial<ContractProjectionError>>({
        code: "SHIP_CONTRACT_SCHEMA_INVALID",
      }),
    );
  });
});

describe("projectClientContract channels", () => {
  const backend: RealtimePublishBackend = {
    kind: "ship.realtime-backend",
    id: "fixture",
    publish: async () => undefined,
    health: async () => ({ ok: true, adapter: "fixture" }),
    close: async () => undefined,
  };

  it("projects channels and operation publications without transport detail", () => {
    const activity = defineChannel({
      id: "accounts.activity",
      scope: "actor",
      payload: z.object({ accountId: z.string().uuid() }),
      presence: true,
      coalesce: { windowMs: 10, key: (value) => value.accountId },
      slowSubscriber: "disconnect",
    });
    const board = defineChannel({
      id: "accounts.board",
      scope: "resource",
      payload: contractSchema(
        standardSchema("custom", (value) => ({ value })),
        {
          jsonSchema: { type: "object" },
        },
      ),
      authorizeSubscription: () => true,
    });
    const touch = defineOperation({
      id: "accounts.touch",
      transport: http.post("/accounts/:accountId/touch"),
      input: { params: z.object({ accountId: z.string().uuid() }) },
      output: { 202: z.object({ accepted: z.literal(true) }) },
      successStatus: 202,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { activity: activity.publication },
      publishes: [activity],
      handler: () => ({ accepted: true as const }),
    });
    const app = defineApp({
      id: "contract-channels",
      modules: [
        defineModule({
          id: "accounts",
          operations: [touch],
          providers: [channelPublisherProvider(activity, backend)],
          imports: [],
          exports: [],
          channels: [board, activity],
        }),
      ],
    });

    const contract = projectClientContract(app);
    expect(Object.keys(contract.channels)).toEqual(["accounts.activity", "accounts.board"]);
    expect(contract.channels["accounts.activity"]).toEqual({
      scope: "actor",
      payload: {
        vendor: "zod",
        jsonSchema: expect.objectContaining({ type: "object", required: ["accountId"] }),
      },
      presence: true,
    });
    expect(contract.channels["accounts.board"]).toEqual({
      scope: "resource",
      payload: { vendor: "custom", jsonSchema: { type: "object" } },
      presence: false,
    });
    expect(contract.operations[0]?.publishes).toEqual(["accounts.activity"]);
    expect(Object.isFrozen(contract.channels["accounts.activity"]?.payload.jsonSchema)).toBe(true);
    const serialized = JSON.stringify(contract);
    for (const forbidden of [
      "coalesce",
      "slowSubscriber",
      "authorizeSubscription",
      "publication",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/room|namespace|socket|ack/iu);
    expect(projectClientContract(app).fingerprint).toBe(contract.fingerprint);
  });

  it("reports the channel id when a payload schema cannot be projected", () => {
    const opaque = defineChannel({
      id: "accounts.opaque",
      scope: "actor",
      payload: standardSchema("custom", (value) => ({ value })),
    });
    const app = defineApp({
      id: "contract-channels",
      modules: [
        defineModule({
          id: "accounts",
          operations: [],
          providers: [],
          imports: [],
          exports: [],
          channels: [opaque],
        }),
      ],
    });
    let caught: unknown;
    try {
      projectClientContract(app);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractProjectionError);
    expect(caught).toMatchObject({ channelId: "accounts.opaque", path: "payload" });
    expect((caught as ContractProjectionError).operationId).toBeUndefined();
  });
});

function moduleWithOperation(id: `${string}.read`, path: `/${string}`) {
  const operation = defineOperation({
    id,
    transport: http.get(path),
    input: {},
    output: { 200: z.object({ ok: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: () => ({ ok: true as const }),
  });
  return defineModule({
    id: id.split(".", 1)[0],
    operations: [operation],
    providers: [],
    imports: [],
    exports: [],
  });
}

function standardSchema(
  vendor: string,
  validate: RuntimeSchema["~standard"]["validate"],
): RuntimeSchema {
  return { "~standard": { version: 1, vendor, validate } };
}

describe("projectClientContract cache policy", () => {
  it("projects the declared cache policy and the tags a write invalidates", () => {
    const cacheToken = cacheBackendDependency("platform.cache");
    const read = defineOperation({
      id: "accounts.summary",
      transport: http.get("/accounts/summary"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 20_000, scope: "public", tags: ["accounts"] },
      handler: () => ({ total: 1 }),
    });
    const app = defineApp({
      id: "contract-fixture",
      modules: [
        defineModule({
          id: "accounts",
          operations: [read],
          providers: [valueProvider(cacheToken, createInMemoryCacheBackend())],
          imports: [],
          exports: [],
        }),
      ],
    });

    const contract = projectClientContract(app);
    expect(contract.operations[0]?.cache).toEqual({
      ttlMs: 20_000,
      scope: "public",
      tags: ["accounts"],
      cacheControl: "public, max-age=20",
    });
  });

  it("omits cache metadata for an operation that declares none", () => {
    const read = defineOperation({
      id: "accounts.read",
      transport: http.get("/accounts"),
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ total: 1 }),
    });
    const app = defineApp({
      id: "contract-fixture",
      modules: [
        defineModule({
          id: "accounts",
          operations: [read],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    expect(projectClientContract(app).operations[0]).not.toHaveProperty("cache");
  });
});

describe("projectClientContract attachments", () => {
  it("projects the upload policy of declared attachments without provider detail", () => {
    const photo = defineAttachment({
      id: "gallery.photo",
      cardinality: "many",
      contentTypes: ["image/png", "image/jpeg"],
      maxBytes: 5_000_000,
      visibility: "private",
      maxCount: 12,
      variants: { thumb: { width: 200, height: 200, fit: "cover", format: "webp" } },
    });
    const capability: AttachmentCapability = {
      kind: "ship.attachment-capability",
      attachmentId: photo.id,
      withScope: () => {
        throw new Error("unused");
      },
    };
    const add = defineOperation({
      id: "gallery.add",
      transport: http.post("/gallery/:ownerId/photos"),
      input: {
        params: z.object({ ownerId: z.string() }),
        body: z.object({ objectId: z.string().uuid() }),
      },
      output: { 201: z.object({ attached: z.literal(true) }) },
      successStatus: 201,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { photos: photo.binding },
      attachments: [photo],
      handler: () => ({ attached: true as const }),
    });
    const app = defineApp({
      id: "contract-attachments",
      modules: [
        defineModule({
          id: "gallery",
          operations: [add],
          providers: [],
          imports: [STORAGE_MODULE_ID],
          exports: [],
          attachments: [photo],
        }),
        defineModule({
          id: STORAGE_MODULE_ID,
          operations: [],
          providers: [valueProvider(photo.binding, capability)],
          imports: [],
          exports: [photo.binding],
        }),
      ],
    });

    const contract = projectClientContract(app);
    expect(contract.attachments).toEqual({
      "gallery.photo": {
        cardinality: "many",
        contentTypes: ["image/jpeg", "image/png"],
        maxBytes: 5_000_000,
        visibility: "private",
        maxCount: 12,
        variants: ["thumb"],
      },
    });
    expect(contract.operations[0]?.attachments).toEqual(["gallery.photo"]);
    const serialized = JSON.stringify(contract);
    for (const forbidden of ["providerId", "intentTtlMs", "gallery.photo.attachment", "disk"]) {
      expect(serialized).not.toContain(forbidden);
    }
    const withoutAttachments = projectClientContract(
      defineApp({
        id: "contract-attachments",
        modules: [
          defineModule({ id: "gallery", operations: [], providers: [], imports: [], exports: [] }),
        ],
      }),
    );
    expect(withoutAttachments.attachments).toEqual({});
    expect(withoutAttachments.fingerprint).not.toBe(contract.fingerprint);
  });
});

describe("projectClientContract rich text", () => {
  it("projects the schema version, attachment, limits and extension specs without renderers", () => {
    const image = defineAttachment({
      id: "documents.image",
      cardinality: "many",
      contentTypes: ["image/png"],
      maxBytes: 1_000_000,
      visibility: "private",
    });
    const mergeField = defineRichTextExtension({
      name: "merge-field",
      nodes: {
        mergeField: {
          spec: {
            group: "inline",
            atom: true,
            attrs: { key: { type: "string", required: true, maxLength: 64 } },
          },
          renderHtml: () => "<span>SERVER_ONLY_HTML</span>",
          renderText: () => "SERVER_ONLY_TEXT",
        },
      },
    });
    const body = defineRichText({
      id: "documents.body",
      attachment: image,
      extensions: [mergeField],
      maxBytes: 1024,
    });
    const capability: RichTextCapability = {
      kind: "ship.rich-text-capability",
      fieldId: body.id,
      attachmentId: image.id,
      withScope: () => {
        throw new Error("unused");
      },
    };
    const attachmentCapability: AttachmentCapability = {
      kind: "ship.attachment-capability",
      attachmentId: image.id,
      withScope: () => {
        throw new Error("unused");
      },
    };
    const save = defineOperation({
      id: "documents.save",
      transport: http.put("/documents/:id"),
      input: { params: z.object({ id: z.string() }), body: z.object({ document: z.unknown() }) },
      output: { 200: z.object({ saved: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { body: body.binding },
      handler: () => ({ saved: true as const }),
    });
    const app = defineApp({
      id: "contract-rich-text",
      modules: [
        defineModule({
          id: "documents",
          operations: [save],
          providers: [valueProvider(body.binding, capability)],
          imports: [STORAGE_MODULE_ID],
          exports: [],
          attachments: [image],
          richText: [body],
        }),
        defineModule({
          id: STORAGE_MODULE_ID,
          operations: [],
          providers: [valueProvider(image.binding, attachmentCapability)],
          imports: [],
          exports: [image.binding],
        }),
      ],
    });

    const contract = projectClientContract(app);
    expect(contract.richText).toEqual({
      "documents.body": {
        schemaVersion: 1,
        attachment: "documents.image",
        maxBytes: 1024,
        maxDepth: 32,
        extensions: [
          {
            name: "merge-field",
            nodes: {
              mergeField: {
                group: "inline",
                atom: true,
                attrs: { key: { type: "string", required: true, maxLength: 64 } },
              },
            },
            marks: {},
          },
        ],
      },
    });
    expect(contract.operations[0]?.richText).toEqual(["documents.body"]);
    const serialized = JSON.stringify(contract);
    for (const forbidden of [
      "SERVER_ONLY",
      "renderHtml",
      "documents.body.rich-text",
      "onInvalid",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const withoutRichText = projectClientContract(
      defineApp({
        id: "contract-rich-text",
        modules: [
          defineModule({
            id: "documents",
            operations: [],
            providers: [],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );
    expect(withoutRichText.richText).toBeUndefined();
  });
});
