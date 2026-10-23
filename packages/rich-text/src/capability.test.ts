import {
  type AttachmentObject,
  defineAttachment,
  defineRichText,
  isRichTextCapability,
  type RichTextDocument,
  type RichTextNode,
  type ScopedAttachmentCapability,
} from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import { createRichTextCapability, richTextProvider } from "./capability.js";
import { RichTextCapabilityError } from "./errors.js";

const image = defineAttachment({
  id: "documents.image",
  cardinality: "many",
  contentTypes: ["image/*"],
  maxBytes: 1_000_000,
  visibility: "private",
});

function doc(...content: RichTextNode[]): RichTextDocument {
  return { schemaVersion: 1, type: "doc", content };
}
function p(...content: RichTextNode[]): RichTextNode {
  return { type: "paragraph", content };
}
function t(text: string, marks?: RichTextNode["marks"]): RichTextNode {
  return { type: "text", text, ...(marks ? { marks } : {}) };
}
function img(objectId: string, alt?: string): RichTextNode {
  return { type: "attachment", attrs: { objectId, ...(alt ? { alt } : {}) } };
}

/** A tiny in-memory stand-in for the storage module's scoped capability. */
function fakeAttachments(
  seed: readonly { id: string; status: AttachmentObject["status"]; ownerId?: string }[],
) {
  const objects = new Map<string, AttachmentObject>(
    seed.map((item) => [
      item.id,
      {
        id: item.id,
        attachmentId: image.id,
        key: `documents.image/${item.id}`,
        contentType: "image/png",
        size: 3,
        status: item.status,
        uploadedBy: "editor",
        ...(item.ownerId ? { ownerId: item.ownerId } : {}),
        createdAt: new Date(0),
        variants: {},
      },
    ]),
  );
  const scoped: ScopedAttachmentCapability = {
    attachmentId: image.id,
    attach: vi.fn(async ({ ownerId, objectId }) => {
      const object = objects.get(objectId);
      if (!object || object.status !== "uploaded") throw new Error(`unavailable ${objectId}`);
      const attached = { ...object, status: "attached" as const, ownerId };
      objects.set(objectId, attached);
      return attached;
    }),
    detach: vi.fn(async ({ ownerId, objectId }) => {
      const detached: AttachmentObject[] = [];
      for (const object of objects.values()) {
        if (object.ownerId !== ownerId || object.status !== "attached") continue;
        if (objectId !== undefined && object.id !== objectId) continue;
        const purging = { ...object, status: "purging" as const };
        objects.set(object.id, purging);
        detached.push(purging);
      }
      return detached;
    }),
    list: vi.fn(async (ownerId) =>
      [...objects.values()].filter(
        (object) => object.ownerId === ownerId && object.status === "attached",
      ),
    ),
    read: vi.fn(async (objectId) => objects.get(objectId)),
    url: vi.fn(async (objectId, options) => {
      const object = objects.get(objectId);
      if (!object || (object.status !== "uploaded" && object.status !== "attached")) {
        return undefined;
      }
      return {
        url: `https://cdn.test/${object.key}?ttl=${options?.expiresInMs ?? "default"}`,
        expiresAt: new Date(1),
      };
    }),
    variant: vi.fn(async () => undefined),
  };
  return { scoped, objects };
}

const field = defineRichText({ id: "documents.body", attachment: image });
const sanitizing = defineRichText({ id: "notes.body", attachment: image, onInvalid: "sanitize" });
const textOnly = defineRichText({
  id: "templates.body",
  migrations: [
    {
      from: 0,
      to: 1,
      migrate: (document) => ({
        ...document,
        content: document.content.map((node) =>
          node.type === "heading" ? { ...node, attrs: { level: 2 } } : node,
        ),
      }),
    },
  ],
});

describe("createRichTextCapability", () => {
  it("is a capability for the field that names its attachment", () => {
    const capability = createRichTextCapability(field);
    expect(isRichTextCapability(capability)).toBe(true);
    expect(capability).toMatchObject({
      fieldId: "documents.body",
      attachmentId: "documents.image",
    });
    expect("attachmentId" in createRichTextCapability(textOnly)).toBe(false);
    const provider = richTextProvider(field);
    expect(provider).toMatchObject({
      token: field.binding,
      lifetime: "singleton",
      dependencies: {},
    });
    expect(isRichTextCapability(provider.create({ services: {} }))).toBe(true);
  });

  it("validates, sanitizes, projects text and lists attachments without a scope", () => {
    const scoped = createRichTextCapability(field).withScope(undefined, undefined);
    expect(scoped).toMatchObject({ fieldId: "documents.body", schemaVersion: 1 });
    expect(scoped.validate(doc(p(t("hi")), img("a")))).toMatchObject({ ok: true });
    expect(scoped.validate(doc({ type: "script" }))).toMatchObject({ ok: false });
    expect(scoped.sanitize(doc({ type: "script" }, p(t("ok")))).document.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(scoped.text(doc(p(t("hi")), img("a", "Alt")))).toBe("hi\nAlt");
    expect(scoped.attachments(doc(img("a"), p(), img("b"), img("a")))).toEqual(["a", "b"]);
  });

  it("renders with signed URLs resolved at render time and never stores them", async () => {
    const { scoped: attachments } = fakeAttachments([
      { id: "a", status: "attached", ownerId: "acme/doc-1" },
      { id: "gone", status: "purged", ownerId: "acme/doc-1" },
    ]);
    const scoped = createRichTextCapability(field).withScope(undefined, attachments);
    const document = doc(p(t("see")), img("a", "chart"), img("gone"));
    expect(await scoped.render(document, { expiresInMs: 60_000 })).toBe(
      "<p>see</p>" +
        '<figure class="ship-attachment"><img src="https://cdn.test/documents.image/a?ttl=60000" alt="chart"></figure>' +
        '<figure class="ship-attachment ship-attachment--unavailable" data-object-id="gone"></figure>',
    );
    expect(JSON.stringify(document)).not.toContain("cdn.test");
    await expect(scoped.render(doc({ type: "script" }))).rejects.toMatchObject({
      code: "SHIP_RICH_TEXT_INVALID",
    });
    await expect(
      scoped.render({ schemaVersion: 0, type: "doc", content: [p()] }),
    ).rejects.toMatchObject({
      code: "SHIP_RICH_TEXT_INVALID",
      issues: [expect.objectContaining({ code: "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED" })],
    });
    const unconfigured = createRichTextCapability(field).withScope(undefined, undefined);
    await expect(unconfigured.render(doc(img("a")))).rejects.toMatchObject({
      code: "SHIP_RICH_TEXT_ATTACHMENTS_UNCONFIGURED",
    });
    expect(await unconfigured.render(doc(p(t("no embeds"))))).toBe("<p>no embeds</p>");
  });

  it("attaches newly referenced uploads and detaches dropped ones inside the write scope", async () => {
    const { scoped: attachments, objects } = fakeAttachments([
      { id: "old", status: "attached", ownerId: "acme/doc-1" },
      { id: "kept", status: "attached", ownerId: "acme/doc-1" },
      { id: "new", status: "uploaded" },
    ]);
    const scoped = createRichTextCapability(field).withScope({ tx: true }, attachments);
    const saved = await scoped.save({
      ownerId: "acme/doc-1",
      document: doc(p(t("v2")), img("kept"), img("new", "fresh")),
    });
    expect(saved).toEqual({
      document: doc(p(t("v2")), img("kept"), img("new", "fresh")),
      text: "v2\nfresh",
      attachmentIds: ["kept", "new"],
      attached: ["new"],
      detached: ["old"],
    });
    expect(objects.get("new")?.status).toBe("attached");
    expect(objects.get("new")?.ownerId).toBe("acme/doc-1");
    expect(objects.get("old")?.status).toBe("purging");
    expect(objects.get("kept")?.status).toBe("attached");
    expect(attachments.attach).toHaveBeenCalledTimes(1);
    expect(attachments.detach).toHaveBeenCalledWith({ ownerId: "acme/doc-1", objectId: "old" });
  });

  it("refuses objects that are unknown, purged or attached to another owner", async () => {
    const { scoped: attachments } = fakeAttachments([
      { id: "theirs", status: "attached", ownerId: "beta/doc-9" },
      { id: "purged", status: "purged" },
      { id: "mine", status: "uploaded" },
    ]);
    const scoped = createRichTextCapability(field).withScope({ tx: true }, attachments);
    await expect(
      scoped.save({
        ownerId: "acme/doc-1",
        document: doc(img("mine"), img("theirs"), img("purged"), img("nope")),
      }),
    ).rejects.toMatchObject({
      code: "SHIP_RICH_TEXT_INVALID",
      issues: [
        expect.objectContaining({
          code: "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE",
          path: ["content", 1, "attrs", "objectId"],
        }),
        expect.objectContaining({
          code: "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE",
          path: ["content", 2, "attrs", "objectId"],
        }),
        expect.objectContaining({
          code: "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE",
          path: ["content", 3, "attrs", "objectId"],
        }),
      ],
    });
    expect(attachments.attach).not.toHaveBeenCalled();
    // A sanitizing field drops them instead and attaches what is left.
    const lenient = createRichTextCapability(sanitizing).withScope({ tx: true }, attachments);
    const saved = await lenient.save({
      ownerId: "acme/doc-1",
      document: doc(img("mine"), img("theirs"), { type: "script" }),
    });
    expect(saved).toMatchObject({ document: doc(img("mine")), attached: ["mine"], detached: [] });
  });

  it("rejects an invalid document before touching storage and sanitizes when declared", async () => {
    const { scoped: attachments } = fakeAttachments([{ id: "a", status: "uploaded" }]);
    const strict = createRichTextCapability(field).withScope({ tx: true }, attachments);
    await expect(
      strict.save({
        ownerId: "acme/doc-1",
        document: doc(p(t("x", [{ type: "evil" }])), img("a")),
      } as never),
    ).rejects.toBeInstanceOf(RichTextCapabilityError);
    expect(attachments.list).not.toHaveBeenCalled();
    const lenient = createRichTextCapability(sanitizing).withScope({ tx: true }, attachments);
    const saved = await lenient.save({
      ownerId: "acme/doc-1",
      document: doc({ type: "script" }, p(t("kept"))),
    });
    expect(saved.document).toEqual(doc(p(t("kept"))));
    expect(saved.text).toBe("kept");
    // What no sanitizer can repair is still refused: not a document, wrong version, too large.
    for (const input of [
      "<p>html</p>",
      { schemaVersion: 0, type: "doc", content: [p()] },
      doc(p(t("x".repeat(300_000)))),
    ]) {
      await expect(lenient.save({ ownerId: "acme/doc-1", document: input })).rejects.toMatchObject({
        code: "SHIP_RICH_TEXT_INVALID",
      });
    }
  });

  it("requires a write scope only when embedded objects change", async () => {
    const { scoped: attachments } = fakeAttachments([
      { id: "kept", status: "attached", ownerId: "acme/doc-1" },
      { id: "new", status: "uploaded" },
    ]);
    const readOnly = createRichTextCapability(field).withScope(undefined, attachments);
    const unchanged = await readOnly.save({
      ownerId: "acme/doc-1",
      document: doc(p(t("same")), img("kept")),
    });
    expect(unchanged).toMatchObject({ attached: [], detached: [], attachmentIds: ["kept"] });
    await expect(
      readOnly.save({ ownerId: "acme/doc-1", document: doc(img("kept"), img("new")) }),
    ).rejects.toMatchObject({ code: "SHIP_RICH_TEXT_SCOPE_REQUIRED" });
    await expect(readOnly.clear({ ownerId: "acme/doc-1" })).rejects.toMatchObject({
      code: "SHIP_RICH_TEXT_SCOPE_REQUIRED",
    });
    expect(attachments.attach).not.toHaveBeenCalled();
    expect(attachments.detach).not.toHaveBeenCalled();
  });

  it("clears every embedded object of the owner when the record goes away", async () => {
    const { scoped: attachments, objects } = fakeAttachments([
      { id: "a", status: "attached", ownerId: "acme/doc-1" },
      { id: "b", status: "attached", ownerId: "acme/doc-1" },
      { id: "c", status: "attached", ownerId: "acme/doc-2" },
    ]);
    const scoped = createRichTextCapability(field).withScope({ tx: true }, attachments);
    expect(await scoped.clear({ ownerId: "acme/doc-1" })).toEqual(["a", "b"]);
    expect(objects.get("a")?.status).toBe("purging");
    expect(objects.get("c")?.status).toBe("attached");
    expect(
      await createRichTextCapability(textOnly)
        .withScope({ tx: true }, undefined)
        .clear({ ownerId: "x" }),
    ).toEqual([]);
  });

  it("saves text-only fields without any attachment capability", async () => {
    const scoped = createRichTextCapability(textOnly).withScope(undefined, undefined);
    const saved = await scoped.save({
      ownerId: "acme/tpl-1",
      document: doc(p(t("Dear "), t("you"))),
    });
    expect(saved).toEqual({
      document: doc(p(t("Dear "), t("you"))),
      text: "Dear you",
      attachmentIds: [],
      attached: [],
      detached: [],
    });
    await expect(
      scoped.save({ ownerId: "acme/tpl-1", document: doc(img("a")) }),
    ).rejects.toMatchObject({
      code: "SHIP_RICH_TEXT_INVALID",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "SHIP_RICH_TEXT_NODE_UNKNOWN" }),
      ]),
    });
  });

  it("migrates through the declared steps and refuses what it cannot migrate", () => {
    const scoped = createRichTextCapability(textOnly).withScope(undefined, undefined);
    const legacy = {
      schemaVersion: 0,
      type: "doc" as const,
      content: [{ type: "heading", attrs: { level: 1 }, content: [t("Old")] }],
    };
    const migrated = scoped.migrate(legacy);
    expect(migrated).toEqual(doc({ type: "heading", attrs: { level: 2 }, content: [t("Old")] }));
    expect(scoped.validate(migrated)).toMatchObject({ ok: true });
    expect(scoped.migrate(migrated)).toBe(migrated);
    expect(() => scoped.migrate({ schemaVersion: 2, type: "doc", content: [] })).toThrow(
      expect.objectContaining({ code: "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED" }),
    );
    const noMigrations = createRichTextCapability(field).withScope(undefined, undefined);
    expect(() => noMigrations.migrate(legacy)).toThrow(
      expect.objectContaining({ code: "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED" }),
    );
    expect(() => noMigrations.migrate({} as never)).toThrow(
      expect.objectContaining({ code: "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED" }),
    );
  });
});
