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
  defineAttachment,
  type ScopedAttachmentCapability,
  STORAGE_MODULE_ID,
} from "./attachment.js";
import { type DependencyBindings, type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor } from "./executor.js";
import { defineModule, InvalidModuleDefinitionError } from "./module.js";
import { defineOperation } from "./operation.js";
import { defineProvider, valueProvider } from "./provider.js";
import {
  type AnyRichText,
  DEFAULT_RICH_TEXT_LINK_REL,
  DEFAULT_RICH_TEXT_MAX_BYTES,
  DEFAULT_RICH_TEXT_MAX_DEPTH,
  defineRichText,
  defineRichTextExtension,
  InvalidRichTextDefinitionError,
  isRichText,
  isRichTextCapability,
  isRichTextDependencyToken,
  isRichTextExtension,
  RICH_TEXT_SCHEMA_VERSION,
  type RichTextCapability,
  type RichTextDefinitionDiagnosticCode,
  richTextForBinding,
  type ScopedRichTextCapability,
} from "./rich-text.js";

function image(id = "documents.image") {
  return defineAttachment({
    id,
    cardinality: "many",
    contentTypes: ["image/png", "image/jpeg"],
    maxBytes: 5_000_000,
    visibility: "private",
  });
}

const mergeField = defineRichTextExtension({
  name: "merge-field",
  nodes: {
    mergeField: {
      spec: {
        group: "inline",
        atom: true,
        attrs: { key: { type: "string", required: true, maxLength: 64 } },
      },
      renderHtml: (node, { attribute }) =>
        `<span data-merge-field="${attribute(node.attrs?.key)}"></span>`,
      renderText: (node) => `{{${String(node.attrs?.key ?? "")}}}`,
    },
  },
});

function fakeRichTextCapability(
  fieldId: string,
  attachmentId?: string,
): RichTextCapability & {
  readonly scopes: { scope: object | undefined; attachments: string | undefined }[];
} {
  const scopes: { scope: object | undefined; attachments: string | undefined }[] = [];
  const scoped = { fieldId, schemaVersion: RICH_TEXT_SCHEMA_VERSION } as ScopedRichTextCapability;
  return {
    kind: "ship.rich-text-capability",
    fieldId,
    ...(attachmentId ? { attachmentId } : {}),
    scopes,
    withScope: (scope, attachments) => {
      scopes.push({ scope, attachments: attachments?.attachmentId });
      return scoped;
    },
  };
}

function fakeAttachmentCapability(attachmentId: string): AttachmentCapability {
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
  return { kind: "ship.attachment-capability", attachmentId, withScope: () => scoped };
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
    compileApp({ id: "rich-text-fixture", modules });
    return [];
  } catch (error) {
    if (error instanceof ApplicationCompilationError) {
      return error.diagnostics.map((item) => item.code);
    }
    throw error;
  }
}

function storageModule(attachment: AnyAttachment) {
  return defineModule({
    id: STORAGE_MODULE_ID,
    operations: [],
    providers: [valueProvider(attachment.binding, fakeAttachmentCapability(attachment.id))],
    imports: [],
    exports: [attachment.binding],
  });
}

describe("defineRichText", () => {
  it("freezes a declaration with defaults, the current schema version and a binding token", () => {
    const attachment = image();
    const field = defineRichText({ id: "documents.body", attachment, extensions: [mergeField] });
    expect(field).toMatchObject({
      kind: "ship.rich-text",
      id: "documents.body",
      schemaVersion: RICH_TEXT_SCHEMA_VERSION,
      attachment,
      extensions: [mergeField],
      maxBytes: DEFAULT_RICH_TEXT_MAX_BYTES,
      maxDepth: DEFAULT_RICH_TEXT_MAX_DEPTH,
      links: { rel: DEFAULT_RICH_TEXT_LINK_REL },
      onInvalid: "reject",
      migrations: [],
      binding: { kind: "ship.dependency", id: "documents.body.rich-text", scope: "rich-text" },
    });
    expect(Object.isFrozen(field)).toBe(true);
    expect(isRichText(field)).toBe(true);
    expect(isRichTextDependencyToken(field.binding)).toBe(true);
    expect(richTextForBinding(field.binding)).toBe(field);
    expect(richTextForBinding(attachment.binding)).toBeUndefined();
    expect(isRichTextCapability(fakeRichTextCapability("documents.body"))).toBe(true);
    expect(isRichTextCapability({ kind: "ship.rich-text-capability" })).toBe(false);
  });

  it("keeps text-only fields free of any attachment and sorts migrations", () => {
    const field = defineRichText({
      id: "templates.body",
      links: { rel: "nofollow", target: "_blank" },
      onInvalid: "sanitize",
      maxBytes: 1024,
      migrations: [{ from: 0, to: 1, migrate: (document) => document }],
    });
    expect(field.attachment).toBeUndefined();
    expect("attachment" in field).toBe(false);
    expect(field.links).toEqual({ rel: "nofollow", target: "_blank" });
    expect(field.onInvalid).toBe("sanitize");
    expect(field.migrations.map((migration) => migration.from)).toEqual([0]);
  });

  it.each<[RichTextDefinitionDiagnosticCode, Record<string, unknown>]>([
    ["SHIP_RICH_TEXT_ID_INVALID", { id: "body" }],
    ["SHIP_RICH_TEXT_ID_INVALID", { id: "Documents.Body" }],
    ["SHIP_RICH_TEXT_ATTACHMENT_INVALID", { id: "documents.body", attachment: { id: "x" } }],
    ["SHIP_RICH_TEXT_EXTENSION_INVALID", { id: "documents.body", extensions: [{ name: "x" }] }],
    [
      "SHIP_RICH_TEXT_EXTENSION_DUPLICATE",
      { id: "documents.body", extensions: [mergeField, mergeField] },
    ],
    ["SHIP_RICH_TEXT_MAX_BYTES_INVALID", { id: "documents.body", maxBytes: 0 }],
    ["SHIP_RICH_TEXT_MAX_DEPTH_INVALID", { id: "documents.body", maxDepth: 1 }],
    ["SHIP_RICH_TEXT_LINKS_INVALID", { id: "documents.body", links: { target: "_top" } }],
    ["SHIP_RICH_TEXT_LINKS_INVALID", { id: "documents.body", links: { rel: "no<follow" } }],
    ["SHIP_RICH_TEXT_ON_INVALID_INVALID", { id: "documents.body", onInvalid: "drop" }],
    [
      "SHIP_RICH_TEXT_MIGRATION_INVALID",
      { id: "documents.body", migrations: [{ from: 0, to: 2, migrate: () => ({}) }] },
    ],
    [
      "SHIP_RICH_TEXT_MIGRATION_INVALID",
      {
        id: "documents.body",
        migrations: [
          { from: 0, to: 1, migrate: () => ({}) },
          { from: 0, to: 1, migrate: () => ({}) },
        ],
      },
    ],
    ["SHIP_RICH_TEXT_DEFINITION_INVALID", null as never],
  ])("rejects %s", (code, definition) => {
    expect(() => defineRichText(definition as never)).toThrow(
      expect.objectContaining({ code }) as InvalidRichTextDefinitionError,
    );
  });
});

describe("defineRichTextExtension", () => {
  it("freezes nodes and marks with their specs", () => {
    expect(isRichTextExtension(mergeField)).toBe(true);
    expect(Object.isFrozen(mergeField.nodes.mergeField?.spec)).toBe(true);
    expect(mergeField.nodes.mergeField?.spec.attrs?.key).toEqual({
      type: "string",
      required: true,
      maxLength: 64,
    });
    expect(isRichTextExtension({ kind: "ship.rich-text-extension", name: "Bad Name" })).toBe(false);
  });

  it.each<[RichTextDefinitionDiagnosticCode, unknown]>([
    ["SHIP_RICH_TEXT_EXTENSION_INVALID", null],
    ["SHIP_RICH_TEXT_EXTENSION_NAME_INVALID", { name: "MergeField" }],
    ["SHIP_RICH_TEXT_EXTENSION_INVALID", { name: "empty" }],
    ["SHIP_RICH_TEXT_EXTENSION_INVALID", { name: "bad", nodes: [] }],
    [
      "SHIP_RICH_TEXT_EXTENSION_NODE_RESERVED",
      { name: "bad", nodes: { paragraph: mergeField.nodes.mergeField } },
    ],
    [
      "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID",
      { name: "bad", nodes: { "merge-field": mergeField.nodes.mergeField } },
    ],
    [
      "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID",
      { name: "bad", nodes: { x: { spec: { group: "table" }, renderHtml() {}, renderText() {} } } },
    ],
    [
      "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID",
      {
        name: "bad",
        nodes: {
          x: { spec: { group: "inline", content: "1nope" }, renderHtml() {}, renderText() {} },
        },
      },
    ],
    [
      "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID",
      {
        name: "bad",
        nodes: {
          x: {
            spec: { group: "inline", attrs: { k: { type: "date" } } },
            renderHtml() {},
            renderText() {},
          },
        },
      },
    ],
    [
      "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID",
      { name: "bad", nodes: { x: { spec: { group: "inline" }, renderHtml() {} } } },
    ],
    [
      "SHIP_RICH_TEXT_EXTENSION_MARK_RESERVED",
      { name: "bad", marks: { bold: { spec: {}, renderHtml() {} } } },
    ],
    ["SHIP_RICH_TEXT_EXTENSION_MARK_INVALID", { name: "bad", marks: { hl: { spec: {} } } }],
    [
      "SHIP_RICH_TEXT_EXTENSION_MARK_INVALID",
      {
        name: "bad",
        marks: { hl: { spec: { attrs: { "bad-name": { type: "string" } } }, renderHtml() {} } },
      },
    ],
  ])("rejects %s", (code, definition) => {
    expect(() => defineRichTextExtension(definition as never)).toThrow(
      expect.objectContaining({ code }) as InvalidRichTextDefinitionError,
    );
  });
});

describe("rich text declarations on modules", () => {
  it("rejects foreign values and duplicates", () => {
    const field = defineRichText({ id: "documents.body" });
    expect(() =>
      defineModule({
        id: "documents",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        richText: [{ id: "documents.body" }] as never,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "SHIP_MODULE_RICH_TEXT_INVALID",
      }) as InvalidModuleDefinitionError,
    );
    expect(() =>
      defineModule({
        id: "documents",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        richText: [field, field],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "SHIP_MODULE_RICH_TEXT_DUPLICATE",
      }) as InvalidModuleDefinitionError,
    );
  });

  it("compiles a bound field and projects the specs without renderers or provider detail", () => {
    const attachment = image();
    const field = defineRichText({ id: "documents.body", attachment, extensions: [mergeField] });
    const documents = defineModule({
      id: "documents",
      operations: [
        operation("documents.save", { dependencies: { body: field.binding }, transaction: "none" }),
      ],
      providers: [valueProvider(field.binding, fakeRichTextCapability(field.id, attachment.id))],
      imports: [STORAGE_MODULE_ID],
      exports: [],
      attachments: [attachment],
      richText: [field],
    });
    const app = defineApp({
      id: "rich-text-fixture",
      modules: [documents, storageModule(attachment)],
    });
    expect(app.graph.richText).toEqual([
      {
        id: "documents.body",
        moduleId: "documents",
        schemaVersion: RICH_TEXT_SCHEMA_VERSION,
        attachmentId: "documents.image",
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
        maxBytes: DEFAULT_RICH_TEXT_MAX_BYTES,
        maxDepth: DEFAULT_RICH_TEXT_MAX_DEPTH,
        onInvalid: "reject",
        providerId: "documents.body.rich-text",
        operations: ["documents.save"],
      },
    ]);
    expect(JSON.stringify(app.graph.richText)).not.toContain("renderHtml");
    expect(app.graph.modules.find((node) => node.id === "documents")?.richText).toEqual([
      "documents.body",
    ]);
    const node = app.graph.operations.find((item) => item.id === "documents.save");
    expect(node?.richText).toEqual(["documents.body"]);
    expect(node?.dependencies).toEqual([
      { name: "body", providerId: "documents.body.rich-text", scope: "rich-text" },
    ]);
    expect(app.graph.providers.find((item) => item.id === "documents.body.rich-text")?.scope).toBe(
      "rich-text",
    );
  });

  it("reports duplicate, misnamed, attachment-less and unprovided declarations", () => {
    const attachment = image("elsewhere.image");
    const field = defineRichText({ id: "documents.body", attachment });
    const left = defineModule({
      id: "documents",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      richText: [field],
    });
    const right = defineModule({
      id: "archive",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      richText: [field],
    });
    const elsewhere = defineModule({
      id: "elsewhere",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      attachments: [attachment],
    });
    expect(diagnosticCodes([left, right, elsewhere, storageModule(attachment)])).toEqual<
      ApplicationDiagnosticCode[]
    >([
      "SHIP_RICH_TEXT_ATTACHMENT_UNDECLARED",
      "SHIP_RICH_TEXT_ID_DUPLICATE",
      "SHIP_RICH_TEXT_MODULE_ID_MISMATCH",
      "SHIP_RICH_TEXT_PROVIDER_MISSING",
    ]);
  });

  it("requires the binding operation to import the owner and reach the embedded attachment", () => {
    const attachment = image();
    const field = defineRichText({ id: "documents.body", attachment });
    const owner = defineModule({
      id: "documents",
      operations: [],
      providers: [valueProvider(field.binding, fakeRichTextCapability(field.id, attachment.id))],
      imports: [STORAGE_MODULE_ID],
      exports: [field.binding],
      attachments: [attachment],
      richText: [field],
    });
    const unimported = defineModule({
      id: "notes",
      operations: [operation("notes.save", { dependencies: { body: field.binding } })],
      providers: [],
      imports: [STORAGE_MODULE_ID],
      exports: [],
    });
    expect(diagnosticCodes([owner, unimported, storageModule(attachment)])).toEqual<
      ApplicationDiagnosticCode[]
    >(["SHIP_MODULE_IMPORT_REQUIRED", "SHIP_RICH_TEXT_IMPORT_REQUIRED"]);
    const withoutStorage = defineModule({
      id: "notes",
      operations: [operation("notes.save", { dependencies: { body: field.binding } })],
      providers: [],
      imports: ["documents"],
      exports: [],
    });
    expect(diagnosticCodes([owner, withoutStorage, storageModule(attachment)])).toEqual<
      ApplicationDiagnosticCode[]
    >(["SHIP_MODULE_IMPORT_REQUIRED"]);
    const foreign = defineModule({
      id: "notes",
      operations: [
        operation("notes.save", {
          dependencies: { body: defineRichText({ id: "documents.body" }).binding },
        }),
      ],
      providers: [],
      imports: ["documents", STORAGE_MODULE_ID],
      exports: [],
    });
    expect(diagnosticCodes([owner, foreign, storageModule(attachment)])).toContain(
      "SHIP_RICH_TEXT_UNDECLARED",
    );
  });

  it("requires a singleton capability provider", () => {
    const field = defineRichText({ id: "documents.body" });
    const owner = defineModule({
      id: "documents",
      operations: [],
      providers: [
        defineProvider({
          token: field.binding,
          lifetime: "operation",
          dependencies: {},
          create: () => fakeRichTextCapability(field.id),
        }),
      ],
      imports: [],
      exports: [],
      richText: [field],
    });
    expect(diagnosticCodes([owner])).toEqual<ApplicationDiagnosticCode[]>([
      "SHIP_RICH_TEXT_PROVIDER_LIFETIME_INVALID",
    ]);
  });
});

describe("executor rich text scoping", () => {
  const unitOfWork = unitOfWorkDependency<{ readonly marker: "tx" }>("database.primary");
  const controller: UnitOfWork<{ readonly marker: "tx" }> = {
    kind: "ship.unit-of-work",
    id: "database.primary",
    run: async (_mode, work) => work({ marker: "tx" }),
  };

  function application(capability: RichTextCapability, field: AnyRichText) {
    const attachment = field.attachment;
    const documents = defineModule({
      id: "documents",
      operations: [
        operation("documents.save", {
          dependencies: { tx: unitOfWork, body: field.binding },
          transaction: "write",
          handler: ({ services }) => ({
            scoped: (services.body as ScopedRichTextCapability).fieldId,
          }),
        }),
        operation("documents.render", {
          dependencies: { body: field.binding },
          transaction: "none",
          handler: ({ services }) => ({
            scoped: (services.body as ScopedRichTextCapability).fieldId,
          }),
        }),
      ],
      providers: [valueProvider(unitOfWork, controller), valueProvider(field.binding, capability)],
      imports: attachment ? [STORAGE_MODULE_ID] : [],
      exports: [],
      ...(attachment ? { attachments: [attachment] } : {}),
      richText: [field],
    });
    return defineApp({
      id: "rich-text-fixture",
      modules: attachment ? [documents, storageModule(attachment)] : [documents],
    });
  }

  it("hands handlers a capability bound to the transaction scope and to the scoped attachment capability", async () => {
    const attachment = image();
    const field = defineRichText({ id: "documents.body", attachment });
    const capability = fakeRichTextCapability(field.id, attachment.id);
    const executor = createExecutor(application(capability, field));
    const actor = operationActor({ id: "editor", permissions: [] });
    const write = await executor.run("documents.save", {}, { actor });
    expect(write).toMatchObject({ ok: true, data: { scoped: "documents.body" } });
    const read = await executor.run("documents.render", {}, { actor });
    expect(read).toMatchObject({ ok: true, data: { scoped: "documents.body" } });
    expect(capability.scopes).toEqual([
      { scope: { marker: "tx" }, attachments: "documents.image" },
      { scope: undefined, attachments: "documents.image" },
    ]);
  });

  it("passes no attachment capability to a text-only field", async () => {
    const field = defineRichText({ id: "documents.body" });
    const capability = fakeRichTextCapability(field.id);
    const executor = createExecutor(application(capability, field));
    await executor.run(
      "documents.render",
      {},
      { actor: operationActor({ id: "editor", permissions: [] }) },
    );
    expect(capability.scopes).toEqual([{ scope: undefined, attachments: undefined }]);
  });

  it("fails when the bound provider is not a capability for the declared field", async () => {
    const field = defineRichText({ id: "documents.body" });
    const executor = createExecutor(application(fakeRichTextCapability("other.body"), field));
    await expect(
      executor.run(
        "documents.render",
        {},
        { actor: operationActor({ id: "editor", permissions: [] }) },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_RICH_TEXT_CAPABILITY_INVALID" });
  });
});
