import { describe, expect, it, vi } from "vitest";
import { authenticatedAccess } from "./access.js";
import { operationActor } from "./actor.js";
import {
  ApplicationCompilationError,
  type ApplicationDiagnosticCode,
  compileApp,
  defineApp,
} from "./application.js";
import {
  type AnyAttachment,
  type AttachmentCapability,
  type AttachmentDefinitionDiagnosticCode,
  attachmentAcceptsContentType,
  attachmentForBinding,
  DEFAULT_ATTACHMENT_INTENT_TTL_MS,
  defineAttachment,
  InvalidAttachmentDefinitionError,
  isAttachment,
  isAttachmentCapability,
  isAttachmentDependencyToken,
  isAttachmentLedger,
  isStorageAdapter,
  MAX_ATTACHMENT_COUNT,
  type ScopedAttachmentCapability,
  STORAGE_MODULE_ID,
} from "./attachment.js";
import { type DependencyBindings, type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor } from "./executor.js";
import { defineModule, InvalidModuleDefinitionError } from "./module.js";
import { defineOperation, InvalidOperationDefinitionError } from "./operation.js";
import { defineProvider, valueProvider } from "./provider.js";

function photo(id = "gallery.photo") {
  return defineAttachment({
    id,
    cardinality: "many",
    contentTypes: ["image/png", "image/jpeg"],
    maxBytes: 5_000_000,
    visibility: "private",
    maxCount: 12,
    variants: { thumb: { width: 200, height: 200, fit: "cover", format: "webp" } },
  });
}

function fakeCapability(attachmentId: string): AttachmentCapability & {
  readonly scopes: (object | undefined)[];
} {
  const scopes: (object | undefined)[] = [];
  const scoped: ScopedAttachmentCapability = {
    attachmentId,
    attach: vi.fn(async () => {
      throw new Error("unused");
    }),
    detach: vi.fn(async () => []),
    list: vi.fn(async () => []),
    read: vi.fn(async () => undefined),
    url: vi.fn(async () => undefined),
    variant: vi.fn(async () => undefined),
  };
  return {
    kind: "ship.attachment-capability",
    attachmentId,
    scopes,
    withScope: (scope) => {
      scopes.push(scope);
      return scoped;
    },
  };
}

function operation(
  id: string,
  options: {
    readonly dependencies?: DependencyBindings;
    readonly attachments?: readonly AnyAttachment[];
    readonly transaction?: "none" | "read" | "write";
    readonly handler?: (arguments_: { services: Record<string, unknown> }) => unknown;
  } = {},
) {
  return defineOperation({
    id,
    input: {},
    output: {
      200: { "~standard": { version: 1, vendor: "t", validate: (v: unknown) => ({ value: v }) } },
    },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: options.transaction ?? "none",
    dependencies: options.dependencies ?? {},
    ...(options.attachments ? { attachments: options.attachments } : {}),
    handler: (options.handler ?? (() => ({ ok: true }))) as never,
  });
}

function diagnosticCodes(modules: Parameters<typeof compileApp>[0]["modules"]) {
  try {
    compileApp({ id: "attachment-fixture", modules });
    return [];
  } catch (error) {
    if (error instanceof ApplicationCompilationError) {
      return error.diagnostics.map((item) => item.code);
    }
    throw error;
  }
}

describe("defineAttachment", () => {
  it("freezes a declaration with defaults and a binding token", () => {
    const attachment = photo();
    expect(isAttachment(attachment)).toBe(true);
    expect(Object.isFrozen(attachment)).toBe(true);
    expect(attachment.binding).toEqual({
      kind: "ship.dependency",
      id: "gallery.photo.attachment",
      scope: "attachment",
      attachmentId: "gallery.photo",
    });
    expect(isAttachmentDependencyToken(attachment.binding)).toBe(true);
    expect(attachmentForBinding(attachment.binding)).toBe(attachment);
    expect(attachment.intentTtlMs).toBe(DEFAULT_ATTACHMENT_INTENT_TTL_MS);
    expect(attachment.maxCount).toBe(12);
    expect(Object.keys(attachment.variants)).toEqual(["thumb"]);
  });

  it("forces a single attachment to one object and defaults many to the ceiling", () => {
    const single = defineAttachment({
      id: "profile.avatar",
      cardinality: "single",
      contentTypes: ["image/*"],
      maxBytes: 1,
      visibility: "public",
    });
    expect(single.maxCount).toBe(1);
    expect(single.variants).toEqual({});
    const many = defineAttachment({
      id: "docs.scan",
      cardinality: "many",
      contentTypes: ["application/pdf"],
      maxBytes: 1,
      visibility: "private",
    });
    expect(many.maxCount).toBe(MAX_ATTACHMENT_COUNT);
  });

  it.each<[AttachmentDefinitionDiagnosticCode, Record<string, unknown>]>([
    ["SHIP_ATTACHMENT_ID_INVALID", { id: "photo" }],
    ["SHIP_ATTACHMENT_CARDINALITY_INVALID", { cardinality: "some" }],
    ["SHIP_ATTACHMENT_CONTENT_TYPES_INVALID", { contentTypes: [] }],
    ["SHIP_ATTACHMENT_CONTENT_TYPES_INVALID", { contentTypes: ["image"] }],
    ["SHIP_ATTACHMENT_CONTENT_TYPES_INVALID", { contentTypes: ["image/png", "IMAGE/PNG"] }],
    ["SHIP_ATTACHMENT_MAX_BYTES_INVALID", { maxBytes: 0 }],
    ["SHIP_ATTACHMENT_VISIBILITY_INVALID", { visibility: "internal" }],
    ["SHIP_ATTACHMENT_MAX_COUNT_INVALID", { maxCount: 0 }],
    ["SHIP_ATTACHMENT_MAX_COUNT_INVALID", { maxCount: MAX_ATTACHMENT_COUNT + 1 }],
    ["SHIP_ATTACHMENT_MAX_COUNT_INVALID", { cardinality: "single", maxCount: 2 }],
    ["SHIP_ATTACHMENT_INTENT_TTL_INVALID", { intentTtlMs: -1 }],
    ["SHIP_ATTACHMENT_VARIANT_INVALID", { variants: { Thumb: { width: 1 } } }],
    ["SHIP_ATTACHMENT_VARIANT_INVALID", { variants: { thumb: {} } }],
    ["SHIP_ATTACHMENT_VARIANT_INVALID", { variants: { thumb: { width: 10, quality: 101 } } }],
    [
      "SHIP_ATTACHMENT_VARIANT_CONTENT_TYPE_INVALID",
      { contentTypes: ["image/png", "application/pdf"], variants: { thumb: { width: 10 } } },
    ],
  ])("rejects %s", (code, overrides) => {
    expect(() =>
      defineAttachment({
        id: "gallery.photo",
        cardinality: "many",
        contentTypes: ["image/png"],
        maxBytes: 10,
        visibility: "private",
        ...overrides,
      } as never),
    ).toThrow(expect.objectContaining({ code }) as InvalidAttachmentDefinitionError);
  });

  it("matches declared content types with wildcards and parameters", () => {
    const attachment = defineAttachment({
      id: "gallery.photo",
      cardinality: "many",
      contentTypes: ["image/*", "application/pdf"],
      maxBytes: 10,
      visibility: "private",
    });
    expect(attachmentAcceptsContentType(attachment, "image/png")).toBe(true);
    expect(attachmentAcceptsContentType(attachment, "IMAGE/WEBP; charset=binary")).toBe(true);
    expect(attachmentAcceptsContentType(attachment, "application/pdf")).toBe(true);
    expect(attachmentAcceptsContentType(attachment, "image/*")).toBe(false);
    expect(attachmentAcceptsContentType(attachment, "text/plain")).toBe(false);
    expect(attachmentAcceptsContentType(attachment, "")).toBe(false);
  });

  it("recognizes capability, adapter and ledger shapes", () => {
    expect(isAttachmentCapability(fakeCapability("gallery.photo"))).toBe(true);
    expect(isAttachmentCapability({ kind: "ship.attachment-capability" })).toBe(false);
    expect(isStorageAdapter({ kind: "ship.storage-adapter", provider: "x" })).toBe(false);
    expect(isAttachmentLedger({ kind: "ship.attachment-ledger" })).toBe(false);
  });
});

describe("attachment declarations on modules and operations", () => {
  it("rejects foreign values and duplicates", () => {
    const attachment = photo();
    expect(() =>
      defineModule({
        id: "gallery",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        attachments: [{ id: "gallery.photo" }] as never,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "SHIP_MODULE_ATTACHMENT_INVALID",
      }) as InvalidModuleDefinitionError,
    );
    expect(() =>
      defineModule({
        id: "gallery",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        attachments: [attachment, attachment],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "SHIP_MODULE_ATTACHMENT_DUPLICATE",
      }) as InvalidModuleDefinitionError,
    );
    expect(() => operation("gallery.add", { attachments: [{}] as never })).toThrow(
      expect.objectContaining({
        code: "SHIP_OPERATION_ATTACHMENT_INVALID",
      }) as InvalidOperationDefinitionError,
    );
    expect(() => operation("gallery.add", { attachments: [attachment, attachment] })).toThrow(
      expect.objectContaining({
        code: "SHIP_OPERATION_ATTACHMENT_DUPLICATE",
      }) as InvalidOperationDefinitionError,
    );
  });

  it("compiles a bound attachment and projects it without provider detail", () => {
    const attachment = photo();
    const storage = defineModule({
      id: STORAGE_MODULE_ID,
      operations: [],
      providers: [valueProvider(attachment.binding, fakeCapability(attachment.id))],
      imports: [],
      exports: [attachment.binding],
    });
    const gallery = defineModule({
      id: "gallery",
      operations: [
        operation("gallery.add", {
          dependencies: { photos: attachment.binding },
          attachments: [attachment],
          transaction: "none",
        }),
      ],
      providers: [],
      imports: [STORAGE_MODULE_ID],
      exports: [],
      attachments: [attachment],
    });
    const app = defineApp({ id: "attachment-fixture", modules: [gallery, storage] });
    expect(app.graph.attachments).toEqual([
      {
        id: "gallery.photo",
        moduleId: "gallery",
        cardinality: "many",
        contentTypes: ["image/jpeg", "image/png"],
        maxBytes: 5_000_000,
        visibility: "private",
        maxCount: 12,
        variants: ["thumb"],
        intentTtlMs: DEFAULT_ATTACHMENT_INTENT_TTL_MS,
        providerId: "gallery.photo.attachment",
        operations: ["gallery.add"],
      },
    ]);
    expect(app.graph.modules.find((node) => node.id === "gallery")?.attachments).toEqual([
      "gallery.photo",
    ]);
    const node = app.graph.operations.find((item) => item.id === "gallery.add");
    expect(node?.attachments).toEqual(["gallery.photo"]);
    expect(node?.dependencies).toEqual([
      { name: "photos", providerId: "gallery.photo.attachment", scope: "attachment" },
    ]);
    expect(app.graph.providers.find((item) => item.id === "gallery.photo.attachment")?.scope).toBe(
      "attachment",
    );
    expect(JSON.stringify(app.graph)).not.toContain("disk");
  });

  it("reports duplicate, misnamed and unbound declarations", () => {
    const attachment = photo();
    const left = defineModule({
      id: "gallery",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      attachments: [attachment],
    });
    const right = defineModule({
      id: "albums",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      attachments: [attachment],
    });
    expect(diagnosticCodes([left, right])).toEqual<ApplicationDiagnosticCode[]>([
      "SHIP_ATTACHMENT_ID_DUPLICATE",
      "SHIP_ATTACHMENT_MODULE_ID_MISMATCH",
      "SHIP_ATTACHMENT_STORAGE_MODULE_MISSING",
    ]);
  });

  it("requires the operation to both declare and bind, and the module to import the owner", () => {
    const attachment = photo();
    const capability = fakeCapability(attachment.id);
    const storage = defineModule({
      id: STORAGE_MODULE_ID,
      operations: [],
      providers: [valueProvider(attachment.binding, capability)],
      imports: [],
      exports: [attachment.binding],
    });
    const owner = defineModule({
      id: "gallery",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      attachments: [attachment],
    });
    const declaredOnly = defineModule({
      id: "albums",
      operations: [operation("albums.add", { attachments: [attachment] })],
      providers: [],
      imports: ["gallery", STORAGE_MODULE_ID],
      exports: [],
    });
    expect(diagnosticCodes([storage, owner, declaredOnly])).toEqual<ApplicationDiagnosticCode[]>([
      "SHIP_OPERATION_ATTACHMENT_UNBOUND",
    ]);
    const boundOnly = defineModule({
      id: "albums",
      operations: [operation("albums.add", { dependencies: { photos: attachment.binding } })],
      providers: [],
      imports: ["gallery", STORAGE_MODULE_ID],
      exports: [],
    });
    expect(diagnosticCodes([storage, owner, boundOnly])).toEqual<ApplicationDiagnosticCode[]>([
      "SHIP_OPERATION_ATTACHMENT_UNDECLARED",
    ]);
    const unimported = defineModule({
      id: "albums",
      operations: [
        operation("albums.add", {
          dependencies: { photos: attachment.binding },
          attachments: [attachment],
        }),
      ],
      providers: [],
      imports: [STORAGE_MODULE_ID],
      exports: [],
    });
    expect(diagnosticCodes([storage, owner, unimported])).toEqual<ApplicationDiagnosticCode[]>([
      "SHIP_ATTACHMENT_IMPORT_REQUIRED",
    ]);
    const foreign = defineModule({
      id: "albums",
      operations: [
        operation("albums.add", {
          dependencies: { photos: photo().binding },
          attachments: [photo()],
        }),
      ],
      providers: [],
      imports: ["gallery", STORAGE_MODULE_ID],
      exports: [],
    });
    expect(diagnosticCodes([storage, owner, foreign])).toContain("SHIP_ATTACHMENT_UNDECLARED");
  });

  it("requires a singleton capability provider", () => {
    const attachment = photo();
    const storage = defineModule({
      id: STORAGE_MODULE_ID,
      operations: [],
      providers: [
        defineProvider({
          token: attachment.binding,
          lifetime: "operation",
          dependencies: {},
          create: () => fakeCapability(attachment.id),
        }),
      ],
      imports: [],
      exports: [attachment.binding],
    });
    const owner = defineModule({
      id: "gallery",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      attachments: [attachment],
    });
    expect(diagnosticCodes([storage, owner])).toEqual<ApplicationDiagnosticCode[]>([
      "SHIP_ATTACHMENT_PROVIDER_LIFETIME_INVALID",
    ]);
  });
});

describe("executor attachment scoping", () => {
  const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
  const controller: UnitOfWork<{ readonly marker: "tx" }> = {
    kind: "ship.unit-of-work",
    id: "database.primary",
    run: async (_mode, work) => work({ marker: "tx" }),
  };

  function application(capability: AttachmentCapability, attachment: AnyAttachment) {
    const storage = defineModule({
      id: STORAGE_MODULE_ID,
      operations: [],
      providers: [valueProvider(attachment.binding, capability)],
      imports: [],
      exports: [attachment.binding],
    });
    const gallery = defineModule({
      id: "gallery",
      operations: [
        operation("gallery.attach", {
          dependencies: { tx: unitOfWork, photos: attachment.binding },
          attachments: [attachment],
          transaction: "write",
          handler: ({ services }) => ({
            scoped: (services.photos as ScopedAttachmentCapability).attachmentId,
          }),
        }),
        operation("gallery.list", {
          dependencies: { photos: attachment.binding },
          attachments: [attachment],
          transaction: "none",
          handler: ({ services }) => ({
            scoped: (services.photos as ScopedAttachmentCapability).attachmentId,
          }),
        }),
      ],
      providers: [valueProvider(unitOfWork, controller)],
      imports: [STORAGE_MODULE_ID],
      exports: [],
      attachments: [attachment],
    });
    return defineApp({ id: "attachment-fixture", modules: [gallery, storage] });
  }

  it("hands write operations a capability bound to the transaction scope", async () => {
    const attachment = photo();
    const capability = fakeCapability(attachment.id);
    const executor = createExecutor(application(capability, attachment));
    const actor = operationActor({ id: "editor", permissions: [] });
    const write = await executor.run("gallery.attach", {}, { actor });
    expect(write).toMatchObject({ ok: true, data: { scoped: "gallery.photo" } });
    expect(capability.scopes).toEqual([{ marker: "tx" }]);
    const read = await executor.run("gallery.list", {}, { actor });
    expect(read).toMatchObject({ ok: true, data: { scoped: "gallery.photo" } });
    expect(capability.scopes).toEqual([{ marker: "tx" }, undefined]);
  });

  it("fails when the bound provider is not a capability for the declared attachment", async () => {
    const attachment = photo();
    const executor = createExecutor(application(fakeCapability("other.photo"), attachment));
    await expect(
      executor.run(
        "gallery.list",
        {},
        { actor: operationActor({ id: "editor", permissions: [] }) },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_ATTACHMENT_CAPABILITY_INVALID" });
  });
});
