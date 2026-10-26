import {
  defineAttachment,
  defineRichText,
  defineRichTextExtension,
  type RichTextDocument,
  type RichTextIssueCode,
  type RichTextNode,
} from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import {
  compileRichTextSchema,
  contentItemAccepts,
  isAllowedLink,
  parseContentExpression,
} from "./schema.js";
import {
  emptyDocument,
  richTextByteLength,
  sanitizeRichTextDocument,
  validateRichTextDocument,
} from "./validate.js";

const image = defineAttachment({
  id: "documents.image",
  cardinality: "many",
  contentTypes: ["image/*"],
  maxBytes: 1_000_000,
  visibility: "private",
});
const callout = defineRichTextExtension({
  name: "callout",
  nodes: {
    callout: {
      spec: {
        group: "block",
        content: "paragraph+",
        attrs: { tone: { type: "string", enum: ["info", "warn"], default: "info" } },
      },
      renderHtml: (_node, { content }) => `<aside>${content}</aside>`,
      renderText: (_node, { content }) => content,
    },
  },
});
const withAttachments = compileRichTextSchema(
  defineRichText({ id: "documents.body", attachment: image, extensions: [callout] }),
);
const textOnly = compileRichTextSchema(defineRichText({ id: "templates.body" }));

function doc(...content: RichTextNode[]): RichTextDocument {
  return { schemaVersion: 1, type: "doc", content };
}
function p(...content: RichTextNode[]): RichTextNode {
  return { type: "paragraph", content };
}
function t(text: string, marks?: RichTextNode["marks"]): RichTextNode {
  return { type: "text", text, ...(marks ? { marks } : {}) };
}
function codes(input: unknown, schema = withAttachments): RichTextIssueCode[] {
  const result = validateRichTextDocument(schema, input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("compileRichTextSchema", () => {
  it("includes the attachment node only for fields that embed an attachment", () => {
    expect(withAttachments.nodes.has("attachment")).toBe(true);
    expect(withAttachments.attachments).toBe(true);
    expect(textOnly.nodes.has("attachment")).toBe(false);
    expect(textOnly.groups.get("block")).toEqual([
      "doc",
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "codeBlock",
    ]);
    expect(withAttachments.groups.get("block")).toContain("callout");
    expect([...withAttachments.marks.keys()]).toEqual(["link", "bold", "italic", "code"]);
  });

  it("parses content expressions", () => {
    expect(parseContentExpression("paragraph block*")).toEqual([
      { name: "paragraph", min: 1, max: 1 },
      { name: "block", min: 0, max: Infinity },
    ]);
    expect(parseContentExpression("listItem+")).toEqual([
      { name: "listItem", min: 1, max: Infinity },
    ]);
    expect(parseContentExpression("heading?")).toEqual([{ name: "heading", min: 0, max: 1 }]);
    expect(parseContentExpression("")).toEqual([]);
    expect(contentItemAccepts(textOnly, { name: "inline", min: 0, max: 1 }, "text")).toBe(true);
    expect(contentItemAccepts(textOnly, { name: "inline", min: 0, max: 1 }, "paragraph")).toBe(
      false,
    );
  });

  it.each([
    ["https://example.test/path?q=1#x", true],
    ["mailto:someone@example.test", true],
    ["http://example.test", false],
    ["javascript:alert(1)", false],
    ["JAVASCRIPT:alert(1)", false],
    ["java\tscript:alert(1)", false],
    ["data:text/html,hi", false],
    ["//example.test", false],
    ["/relative", false],
    ['https://example.test/"', false],
    ["https://example.test/ space", false],
    ["https://example.test/`", false],
    ["", false],
    [`https://example.test/${"a".repeat(2048)}`, false],
    [42, false],
  ])("isAllowedLink(%j) is %s", (href, allowed) => {
    expect(isAllowedLink(href)).toBe(allowed);
  });
});

describe("validateRichTextDocument", () => {
  it("accepts a well-formed document and canonicalizes it", () => {
    const result = validateRichTextDocument(
      withAttachments,
      doc(
        { type: "paragraph", attrs: {}, marks: [], content: [t("hi", [])] },
        { type: "attachment", attrs: { objectId: "obj-1" } },
        { type: "callout", content: [p(t("note"))] },
      ),
    );
    expect(result).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
          { type: "attachment", attrs: { objectId: "obj-1" } },
          {
            type: "callout",
            content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }],
          },
        ],
      },
    });
    expect(Object.isFrozen((result as { document: RichTextDocument }).document.content)).toBe(true);
  });

  it.each<[string, unknown, RichTextIssueCode]>([
    ["a non-object", "<p>hi</p>", "SHIP_RICH_TEXT_DOCUMENT_INVALID"],
    ["an array", [], "SHIP_RICH_TEXT_DOCUMENT_INVALID"],
    [
      "a wrong root type",
      { schemaVersion: 1, type: "paragraph", content: [] },
      "SHIP_RICH_TEXT_DOCUMENT_INVALID",
    ],
    [
      "an older schema version",
      { schemaVersion: 0, type: "doc", content: [p()] },
      "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
    ],
    [
      "a newer schema version",
      { schemaVersion: 2, type: "doc", content: [p()] },
      "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
    ],
    [
      "a missing schema version",
      { type: "doc", content: [p()] },
      "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
    ],
    [
      "an extra document key",
      { schemaVersion: 1, type: "doc", content: [p()], html: "<b>" },
      "SHIP_RICH_TEXT_DOCUMENT_INVALID",
    ],
    ["no blocks", doc(), "SHIP_RICH_TEXT_CONTENT_INVALID"],
    [
      "content that is not an array",
      { schemaVersion: 1, type: "doc", content: {} },
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    ["an unknown node", doc({ type: "iframe" }), "SHIP_RICH_TEXT_NODE_UNKNOWN"],
    ["a nested doc", doc({ type: "doc", content: [p()] }), "SHIP_RICH_TEXT_NODE_UNKNOWN"],
    ["a non-string node type", doc({ type: 1 as never }), "SHIP_RICH_TEXT_NODE_UNKNOWN"],
    [
      "an unexpected node key",
      doc({ type: "paragraph", html: "x" } as never),
      "SHIP_RICH_TEXT_NODE_UNKNOWN",
    ],
    ["an inline node at block level", doc(t("loose")), "SHIP_RICH_TEXT_CONTENT_INVALID"],
    ["a block inside a paragraph", doc(p(p())), "SHIP_RICH_TEXT_CONTENT_INVALID"],
    ["a list without items", doc({ type: "bulletList" }), "SHIP_RICH_TEXT_CONTENT_INVALID"],
    [
      "a list with a stray paragraph",
      doc({ type: "bulletList", content: [p()] }),
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    [
      "a list item not starting with a paragraph",
      doc({
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "blockquote", content: [p()] }] }],
      }),
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    [
      "a leaf with content",
      doc(p({ type: "hardBreak", content: [t("x")] })),
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    [
      "text with content",
      doc(p({ type: "text", text: "x", content: [] })),
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    ["a paragraph with text", doc({ type: "paragraph", text: "x" }), "SHIP_RICH_TEXT_TEXT_INVALID"],
    ["an empty text node", doc(p(t(""))), "SHIP_RICH_TEXT_TEXT_INVALID"],
    ["text with U+0000", doc(p(t("a\u0000b"))), "SHIP_RICH_TEXT_TEXT_INVALID"],
    ["text with a lone surrogate", doc(p(t("a\ud800b"))), "SHIP_RICH_TEXT_TEXT_INVALID"],
    [
      "a non-string text",
      doc(p({ type: "text", text: 1 as never })),
      "SHIP_RICH_TEXT_TEXT_INVALID",
    ],
    [
      "a heading without level",
      doc({ type: "heading", content: [t("x")] }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "a heading level outside 2..3",
      doc({ type: "heading", attrs: { level: 1 }, content: [t("x")] }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "an unknown attribute",
      doc({ type: "paragraph", attrs: { style: "x" } }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "attrs that are not an object",
      doc({ type: "paragraph", attrs: [] as never }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "a non-integer list start",
      doc({
        type: "orderedList",
        attrs: { start: "3" },
        content: [{ type: "listItem", content: [p()] }],
      }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "a list type outside the enum",
      doc({
        type: "orderedList",
        attrs: { type: "x" },
        content: [{ type: "listItem", content: [p()] }],
      }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "a code language with markup",
      doc({ type: "codeBlock", attrs: { language: "<b>" } }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "a code block with marks",
      doc({ type: "codeBlock", content: [t("x", [{ type: "bold" }])] }),
      "SHIP_RICH_TEXT_MARK_FORBIDDEN",
    ],
    [
      "a code block with a non-text child",
      doc({ type: "codeBlock", content: [{ type: "hardBreak" }] }),
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    ["an unknown mark", doc(p(t("x", [{ type: "underline" }]))), "SHIP_RICH_TEXT_MARK_UNKNOWN"],
    [
      "a repeated mark",
      doc(p(t("x", [{ type: "bold" }, { type: "bold" }]))),
      "SHIP_RICH_TEXT_MARK_UNKNOWN",
    ],
    [
      "marks that are not an array",
      doc(p({ type: "text", text: "x", marks: {} as never })),
      "SHIP_RICH_TEXT_MARK_UNKNOWN",
    ],
    [
      "a mark with an extra key",
      doc(p(t("x", [{ type: "bold", html: 1 } as never]))),
      "SHIP_RICH_TEXT_MARK_UNKNOWN",
    ],
    ["a link without href", doc(p(t("x", [{ type: "link" }]))), "SHIP_RICH_TEXT_ATTR_INVALID"],
    [
      "a javascript link",
      doc(p(t("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))),
      "SHIP_RICH_TEXT_LINK_INVALID",
    ],
    [
      "an http link",
      doc(p(t("x", [{ type: "link", attrs: { href: "http://x.test" } }]))),
      "SHIP_RICH_TEXT_LINK_INVALID",
    ],
    [
      "a link with target",
      doc(p(t("x", [{ type: "link", attrs: { href: "https://x.test", target: "_blank" } }]))),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    ["an attachment without objectId", doc({ type: "attachment" }), "SHIP_RICH_TEXT_ATTR_INVALID"],
    [
      "an attachment with a malformed objectId",
      doc({ type: "attachment", attrs: { objectId: "../x" } }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
    [
      "an attachment with content",
      doc({ type: "attachment", attrs: { objectId: "a" }, content: [t("x")] }),
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ],
    [
      "an extension attr outside its enum",
      doc({ type: "callout", attrs: { tone: "loud" }, content: [p()] }),
      "SHIP_RICH_TEXT_ATTR_INVALID",
    ],
  ])("refuses %s", (_label, input, code) => {
    expect(codes(input)).toContain(code);
  });

  it("refuses the attachment node for text-only fields", () => {
    expect(codes(doc({ type: "attachment", attrs: { objectId: "a" } }), textOnly)).toContain(
      "SHIP_RICH_TEXT_NODE_UNKNOWN",
    );
  });

  it("reports every issue with its JSON path", () => {
    const result = validateRichTextDocument(
      withAttachments,
      doc(p(t("x", [{ type: "link", attrs: { href: "ftp://x" } }])), { type: "video" }),
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "SHIP_RICH_TEXT_LINK_INVALID",
          message: "link: href must be an absolute https: or mailto: URL",
          path: ["content", 0, "content", 0, "marks", 0, "attrs"],
        },
        {
          code: "SHIP_RICH_TEXT_NODE_UNKNOWN",
          message: 'node "video" is not allowed',
          path: ["content", 1, "type"],
        },
      ],
    });
  });

  it("bounds size and depth before walking", () => {
    const big = doc(p(t("x".repeat(300_000))));
    expect(codes(big)).toEqual(["SHIP_RICH_TEXT_TOO_LARGE"]);
    expect(richTextByteLength({ a: "é" })).toBe(10);
    let nested: RichTextNode = p(t("deep"));
    for (let level = 0; level < 40; level += 1) {
      nested = { type: "blockquote", content: [nested] };
    }
    expect(codes(doc(nested))).toContain("SHIP_RICH_TEXT_TOO_DEEP");
    const small = compileRichTextSchema(defineRichText({ id: "templates.body", maxBytes: 64 }));
    expect(codes(doc(p(t("x".repeat(60)))), small)).toEqual(["SHIP_RICH_TEXT_TOO_LARGE"]);
    expect(validateRichTextDocument(withAttachments, doc(nested), { maxDepth: 64 }).ok).toBe(true);
  });

  it("refuses the embedded objects the caller marks unavailable", () => {
    const result = validateRichTextDocument(
      withAttachments,
      doc(
        { type: "attachment", attrs: { objectId: "ok" } },
        { type: "attachment", attrs: { objectId: "gone" } },
      ),
      { rejectAttachment: (objectId) => objectId === "gone" },
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE",
          path: ["content", 1, "attrs", "objectId"],
        }),
      ],
    });
  });
});

describe("sanitizeRichTextDocument", () => {
  it("drops what the schema forbids and reports each drop", () => {
    const result = sanitizeRichTextDocument(
      withAttachments,
      doc(
        { type: "script", content: [t("alert(1)")] },
        p(
          t("keep "),
          t("bold", [{ type: "bold" }, { type: "underline" }]),
          t(" evil", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
          { type: "iframe" },
          t("x\u0000y"),
        ),
        { type: "heading", attrs: { level: 1 }, content: [t("too big")] },
        { type: "heading", attrs: { level: 2, style: "color:red" }, content: [t("ok")] },
        { type: "codeBlock", content: [t("code", [{ type: "bold" }])] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "blockquote", content: [p(t("q"))] }] }],
        },
        { type: "bulletList", content: [p(t("stray"))] },
        { type: "attachment", attrs: { objectId: "gone" } },
        { type: "attachment", attrs: { objectId: "ok", alt: 1 as never } },
        t("loose text"),
      ),
      { rejectAttachment: (objectId) => objectId === "gone" },
    );
    expect(result.document).toEqual({
      schemaVersion: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "keep " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " evil" },
            { type: "text", text: "xy" },
          ],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "ok" }] },
        { type: "codeBlock", content: [{ type: "text", text: "code" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph" },
                {
                  type: "blockquote",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }],
                },
              ],
            },
          ],
        },
        { type: "attachment", attrs: { objectId: "ok" } },
      ],
    });
    expect(result.dropped.map((issue) => issue.code)).toEqual([
      "SHIP_RICH_TEXT_NODE_UNKNOWN",
      "SHIP_RICH_TEXT_MARK_UNKNOWN",
      "SHIP_RICH_TEXT_LINK_INVALID",
      "SHIP_RICH_TEXT_NODE_UNKNOWN",
      "SHIP_RICH_TEXT_TEXT_INVALID",
      "SHIP_RICH_TEXT_ATTR_INVALID",
      "SHIP_RICH_TEXT_ATTR_INVALID",
      "SHIP_RICH_TEXT_MARK_FORBIDDEN",
      "SHIP_RICH_TEXT_CONTENT_INVALID",
      "SHIP_RICH_TEXT_CONTENT_INVALID",
      "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE",
      "SHIP_RICH_TEXT_ATTR_INVALID",
      "SHIP_RICH_TEXT_CONTENT_INVALID",
    ]);
    expect(validateRichTextDocument(withAttachments, result.document).ok).toBe(true);
  });

  it("answers the empty document for input that is not a document and for one that empties out", () => {
    expect(sanitizeRichTextDocument(textOnly, "<p>hi</p>")).toEqual({
      document: emptyDocument(1),
      dropped: [expect.objectContaining({ code: "SHIP_RICH_TEXT_DOCUMENT_INVALID" })],
    });
    expect(sanitizeRichTextDocument(textOnly, doc({ type: "script" })).document).toEqual(
      emptyDocument(1),
    );
    expect(sanitizeRichTextDocument(textOnly, { schemaVersion: 1, type: "doc" }).document).toEqual(
      emptyDocument(1),
    );
    expect(
      sanitizeRichTextDocument(textOnly, { schemaVersion: 2, type: "doc", content: [p()] }).dropped,
    ).toEqual([expect.objectContaining({ code: "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED" })]);
  });

  it("leaves a valid document untouched", () => {
    const input = doc(p(t("fine", [{ type: "italic" }])));
    expect(sanitizeRichTextDocument(withAttachments, input)).toEqual({
      document: input,
      dropped: [],
    });
  });

  it("cannot shrink an oversized document and keeps the size issue", () => {
    const result = sanitizeRichTextDocument(withAttachments, doc(p(t("x".repeat(300_000)))));
    expect(result.dropped.map((issue) => issue.code)).toEqual(["SHIP_RICH_TEXT_TOO_LARGE"]);
    expect(result.document).toEqual(emptyDocument(1));
  });
});
