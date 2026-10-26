import {
  defineAttachment,
  defineRichText,
  defineRichTextExtension,
  type RichTextDocument,
  type RichTextNode,
} from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { collectRichTextAttachments, renderRichTextHtml, renderRichTextText } from "./render.js";
import { compileRichTextSchema } from "./schema.js";
import { sanitizeRichTextDocument, validateRichTextDocument } from "./validate.js";

const image = defineAttachment({
  id: "documents.image",
  cardinality: "many",
  contentTypes: ["image/*", "application/pdf"],
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
      renderHtml: (node, { attribute }) =>
        `<span class="merge-field" data-key="${attribute(node.attrs?.key)}">${attribute(node.attrs?.key)}</span>`,
      renderText: (node) => `{{${String(node.attrs?.key ?? "")}}}`,
    },
  },
  marks: {
    highlight: {
      spec: { attrs: { color: { type: "string", enum: ["yellow", "green"], default: "yellow" } } },
      renderHtml: (mark, inner, { attribute }) =>
        `<mark data-color="${attribute(mark.attrs?.color ?? "yellow")}">${inner}</mark>`,
    },
  },
});

const field = defineRichText({ id: "documents.body", attachment: image, extensions: [mergeField] });
const schema = compileRichTextSchema(field);

function doc(...content: RichTextNode[]): RichTextDocument {
  return { schemaVersion: 1, type: "doc", content };
}
function p(...content: RichTextNode[]): RichTextNode {
  return { type: "paragraph", content };
}
function t(text: string, marks?: RichTextNode["marks"]): RichTextNode {
  return { type: "text", text, ...(marks ? { marks } : {}) };
}

describe("renderRichTextHtml", () => {
  it("renders every base node and mark", () => {
    const html = renderRichTextHtml(
      schema,
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("Title")] },
        p(
          t("plain "),
          t("bold", [{ type: "bold" }]),
          t(" "),
          t("italic", [{ type: "italic" }]),
          t(" "),
          t("code", [{ type: "code" }]),
          t(" "),
          t("link", [
            { type: "link", attrs: { href: "https://example.test/a?b=1&c=2", title: "T" } },
          ]),
          { type: "hardBreak" },
          t("after"),
        ),
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [p(t("one"))] }],
        },
        {
          type: "orderedList",
          attrs: { start: 3, type: "a" },
          content: [{ type: "listItem", content: [p(t("three"))] }],
        },
        { type: "blockquote", content: [p(t("quote"))] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [t("const x = 1;")] },
        { type: "codeBlock", content: [t("plain")] },
      ),
    );
    expect(html).toBe(
      "<h2>Title</h2>" +
        '<p>plain <strong>bold</strong> <em>italic</em> <code>code</code> <a href="https://example.test/a?b=1&amp;c=2" rel="noopener noreferrer" title="T">link</a><br>after</p>' +
        "<ul><li><p>one</p></li></ul>" +
        '<ol start="3" type="a"><li><p>three</p></li></ol>' +
        "<blockquote><p>quote</p></blockquote>" +
        '<pre><code class="language-ts">const x = 1;</code></pre>' +
        "<pre><code>plain</code></pre>",
    );
  });

  it("nests marks deterministically with the link outermost and merges equal runs", () => {
    const marks = [
      { type: "code" },
      { type: "bold" },
      { type: "link", attrs: { href: "https://x.test" } },
    ];
    const html = renderRichTextHtml(schema, doc(p(t("a", marks), t("b", marks), t("c"))));
    expect(html).toBe(
      '<p><a href="https://x.test" rel="noopener noreferrer"><strong><code>ab</code></strong></a>c</p>',
    );
  });

  it("applies the field's link rel and target", () => {
    const blank = compileRichTextSchema(
      defineRichText({ id: "documents.body", links: { rel: "nofollow", target: "_blank" } }),
    );
    expect(
      renderRichTextHtml(
        blank,
        doc(p(t("x", [{ type: "link", attrs: { href: "mailto:a@b.c" } }]))),
      ),
    ).toBe('<p><a href="mailto:a@b.c" rel="nofollow" target="_blank">x</a></p>');
  });

  it("renders extension nodes and marks through their own renderers", () => {
    const html = renderRichTextHtml(
      schema,
      doc(
        p(
          t("Dear "),
          { type: "mergeField", attrs: { key: "client.name" } },
          t(" hi", [{ type: "highlight", attrs: { color: "green" } }]),
        ),
      ),
    );
    expect(html).toBe(
      '<p>Dear <span class="merge-field" data-key="client.name">client.name</span><mark data-color="green"> hi</mark></p>',
    );
  });

  it("renders embedded objects from resolved URLs only and marks unresolved ones unavailable", () => {
    const document = doc(
      { type: "attachment", attrs: { objectId: "img-1", alt: 'A "quoted" <alt>' } },
      { type: "attachment", attrs: { objectId: "pdf-1" } },
      { type: "attachment", attrs: { objectId: "gone" } },
    );
    expect(collectRichTextAttachments(document)).toEqual(["img-1", "pdf-1", "gone"]);
    const html = renderRichTextHtml(schema, document, {
      attachments: new Map([
        ["img-1", { url: "https://cdn.test/img?sig=1&x=2", contentType: "image/png" }],
        ["pdf-1", { url: "https://cdn.test/pdf", contentType: "application/pdf" }],
        ["gone", undefined],
      ]),
    });
    expect(html).toBe(
      '<figure class="ship-attachment"><img src="https://cdn.test/img?sig=1&amp;x=2" alt="A &quot;quoted&quot; &lt;alt&gt;"></figure>' +
        '<figure class="ship-attachment"><a href="https://cdn.test/pdf" rel="noopener noreferrer">Attachment</a></figure>' +
        '<figure class="ship-attachment ship-attachment--unavailable" data-object-id="gone"></figure>',
    );
    expect(html).not.toContain("documents.image/");
  });

  it("renders nothing for nodes and marks outside the schema", () => {
    expect(
      renderRichTextHtml(
        schema,
        doc(
          { type: "script", content: [t("alert(1)")] } as RichTextNode,
          p(t("ok", [{ type: "evil" }])),
        ),
      ),
    ).toBe("<p>ok</p>");
  });
});

/**
 * The XSS corpus: every payload goes through each place a document can carry
 * attacker-controlled bytes (text, link href/title, code language, attachment
 * alt/objectId, list attrs, extension attrs and node/mark types) and the
 * rendered HTML must never contain an executable form of it. The strict
 * validator must refuse the payloads that are not plain text at all.
 */
const payloads = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "\u0001javascript:alert(1)",
  " javascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "http://evil.test/",
  "//evil.test/",
  "/relative",
  'https://ok.test/" onmouseover="alert(1)',
  "https://ok.test/' onmouseover='alert(1)",
  "https://ok.test/<script>",
  "https://ok.test/`",
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  "</a><script>alert(1)</script>",
  "</pre></code><script>alert(1)</script>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&#60;script&#62;",
  "<!--<script>alert(1)</script>-->",
  "<![CDATA[<script>alert(1)</script>]]>",
  "<iframe src=javascript:alert(1)>",
  "<a href=javascript:alert(1)>x</a>",
  "<style>@import 'https://evil.test'</style>",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  "{{constructor.constructor('alert(1)')()}}",
  "${alert(1)}",
  "‮javascript:alert(1)",
  "\u0000<script>alert(1)</script>",
  "<SCRIPT SRC=https://evil.test/x.js></SCRIPT>",
  "<body onload=alert(1)>",
  "<details open ontoggle=alert(1)>",
  "<img src='x' onerror='alert(1)' />",
  "'\"><img src=x onerror=alert(1)>",
  "<<script>alert(1)//<</script>",
];

const OWN_TAG =
  /^<\/?(?:p|h2|h3|ul|ol|li|blockquote|pre|code|br|strong|em|a|figure|img|span|mark)((?:\s+[a-z][a-z-]*="[^"<>]*")*)\s*>$/u;

/**
 * Every `<` in the output must open one of the renderer's own tags whose
 * attribute values are double-quoted and free of quotes and angle brackets,
 * whose names never start with `on`, and whose `href` / `src` only ever carry
 * an allowed scheme. What remains after removing those tags must be plain
 * escaped text: no angle brackets at all. That is what makes the corpus
 * inert regardless of where a payload was placed.
 */
function assertInert(html: string, payload: string): void {
  const context = `${JSON.stringify(payload)} rendered ${html}`;
  for (const tag of html.match(/<[^>]*>?/gu) ?? []) {
    const match = OWN_TAG.exec(tag);
    expect(match, `${context}: unexpected tag ${tag}`).not.toBeNull();
    for (const attribute of (match?.[1] ?? "").matchAll(/\s+([a-z][a-z-]*)="([^"]*)"/gu)) {
      const [, name, value] = attribute as unknown as [string, string, string];
      expect(name.startsWith("on"), `${context}: event handler ${name}`).toBe(false);
      if (name === "href" || name === "src") {
        expect(value, `${context}: ${name} scheme`).toMatch(/^(?:https:|mailto:)/u);
      }
    }
  }
  const text = html.replaceAll(/<[^>]*>/gu, "");
  expect(text, `${context}: leaked markup`).not.toMatch(/[<>]/u);
}

describe("XSS corpus", () => {
  it.each(payloads)("renders %j inertly wherever it is placed", (payload) => {
    const resolved = new Map([
      ["img-1", { url: "https://cdn.test/img", contentType: "image/png" }],
    ]);
    const placements: RichTextDocument[] = [
      doc(p(t(payload))),
      doc({ type: "heading", attrs: { level: 2 }, content: [t(payload)] }),
      doc({ type: "codeBlock", attrs: { language: payload }, content: [t(payload)] }),
      doc(p(t("x", [{ type: "link", attrs: { href: payload, title: payload } }]))),
      doc(p(t(payload, [{ type: "link", attrs: { href: "https://ok.test/" } }]))),
      doc({ type: "attachment", attrs: { objectId: payload, alt: payload } }),
      doc({ type: "attachment", attrs: { objectId: "img-1", alt: payload } }),
      doc(p({ type: "mergeField", attrs: { key: payload } })),
      doc(p(t(payload, [{ type: "highlight", attrs: { color: payload } }]))),
      doc({
        type: "orderedList",
        attrs: { start: payload as never, type: payload },
        content: [{ type: "listItem", content: [p(t(payload))] }],
      }),
      doc({ type: payload, content: [t(payload)] } as RichTextNode),
      doc(p(t(payload, [{ type: payload }]))),
      doc(
        p({ type: "text", text: payload, marks: [{ type: "bold", attrs: { onclick: payload } }] }),
      ),
    ];
    for (const document of placements) {
      // The raw tree renders inertly even before validation (defense in depth) ...
      assertInert(renderRichTextHtml(schema, document, { attachments: resolved }), payload);
      // ... and what survives sanitization renders inertly too.
      const sanitized = sanitizeRichTextDocument(schema, document).document;
      assertInert(renderRichTextHtml(schema, sanitized, { attachments: resolved }), payload);
    }
  });

  it("refuses every non-text placement of the corpus under strict validation", () => {
    for (const payload of payloads) {
      const asHref = validateRichTextDocument(
        schema,
        doc(p(t("x", [{ type: "link", attrs: { href: payload } }]))),
      );
      expect(asHref.ok, `href ${JSON.stringify(payload)}`).toBe(false);
      const asType = validateRichTextDocument(
        schema,
        doc({ type: payload, content: [t("x")] } as RichTextNode),
      );
      expect(asType.ok, `type ${JSON.stringify(payload)}`).toBe(false);
      const asMark = validateRichTextDocument(schema, doc(p(t("x", [{ type: payload }]))));
      expect(asMark.ok, `mark ${JSON.stringify(payload)}`).toBe(false);
      const asLanguage = validateRichTextDocument(
        schema,
        doc({ type: "codeBlock", attrs: { language: payload }, content: [t("x")] }),
      );
      expect(asLanguage.ok, `language ${JSON.stringify(payload)}`).toBe(false);
      const asObjectId = validateRichTextDocument(
        schema,
        doc({ type: "attachment", attrs: { objectId: payload } }),
      );
      expect(asObjectId.ok, `objectId ${JSON.stringify(payload)}`).toBe(false);
    }
  });

  it("accepts the corpus as plain text and escapes it", () => {
    for (const payload of payloads) {
      if (payload.includes("\u0000")) continue;
      const result = validateRichTextDocument(schema, doc(p(t(payload))));
      expect(result.ok, payload).toBe(true);
      if (!result.ok) continue;
      const html = renderRichTextHtml(schema, result.document);
      assertInert(html, payload);
      expect(html.startsWith("<p>") && html.endsWith("</p>")).toBe(true);
    }
  });
});

describe("renderRichTextText", () => {
  it("projects blocks to lines, keeps hard breaks and uses alt text and extension text", () => {
    const text = renderRichTextText(
      schema,
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("Title")] },
        p(
          t("Dear "),
          { type: "mergeField", attrs: { key: "name" } },
          t(","),
          { type: "hardBreak" },
          t("line two"),
        ),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(t("one"))] },
            {
              type: "listItem",
              content: [
                p(t("two")),
                { type: "bulletList", content: [{ type: "listItem", content: [p(t("nested"))] }] },
              ],
            },
          ],
        },
        { type: "attachment", attrs: { objectId: "img-1", alt: "A chart" } },
        { type: "attachment", attrs: { objectId: "img-2" } },
        { type: "codeBlock", content: [t("x <y")] },
        p(),
      ),
    );
    expect(text).toBe("Title\nDear {{name}},\nline two\none\ntwo\nnested\nA chart\nx <y");
  });

  it("is empty for the empty document", () => {
    expect(renderRichTextText(schema, doc(p()))).toBe("");
  });
});
