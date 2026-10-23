import {
  type AnyRichText,
  RICH_TEXT_SCHEMA_VERSION,
  type RichTextAttrSpecs,
  type RichTextAttrs,
  type RichTextExtension,
  type RichTextHtmlContext,
  type RichTextLinkOptions,
  type RichTextMark,
  type RichTextNode,
  type RichTextTextContext,
} from "@sixthsummit/ship-core";

/** Schemes a link `href` may use; everything else (javascript:, data:, http:, relative) is refused. */
export const RICH_TEXT_LINK_SCHEMES = Object.freeze(["https:", "mailto:"] as const);
export const RICH_TEXT_MAX_LINK_LENGTH = 2048;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LANGUAGE_PATTERN = /^[A-Za-z0-9+#._-]{0,64}$/u;

export interface ContentItem {
  /** A node name or the `block` / `inline` group. */
  readonly name: string;
  readonly min: 0 | 1;
  readonly max: number;
}

export interface CompiledNode {
  readonly name: string;
  readonly group: "block" | "inline";
  readonly content: readonly ContentItem[];
  readonly atom: boolean;
  readonly attrs: RichTextAttrSpecs;
  readonly marks: "all" | "none";
  readonly renderHtml: (node: RichTextNode, context: RichTextHtmlContext) => string;
  readonly renderText: (node: RichTextNode, context: RichTextTextContext) => string;
  readonly validate?: (attrs: RichTextAttrs) => string | undefined;
}

export interface CompiledMark {
  readonly name: string;
  readonly attrs: RichTextAttrSpecs;
  /** Lower renders outermost. */
  readonly rank: number;
  readonly renderHtml: (mark: RichTextMark, inner: string, context: RichTextHtmlContext) => string;
  readonly validate?: (attrs: RichTextAttrs) => string | undefined;
}

export interface CompiledRichTextSchema {
  readonly version: number;
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  readonly marks: ReadonlyMap<string, CompiledMark>;
  /** Node names by group. */
  readonly groups: ReadonlyMap<string, readonly string[]>;
  readonly links: Required<Pick<RichTextLinkOptions, "rel">> & Pick<RichTextLinkOptions, "target">;
  readonly maxBytes: number;
  readonly maxDepth: number;
  /** Whether the `attachment` node exists (only when the field declares an attachment). */
  readonly attachments: boolean;
}

export interface CompileRichTextSchemaOptions {
  /** Include the `attachment` node. Defaults to the field's declaration. */
  readonly attachments?: boolean;
}

export const RICH_TEXT_DOC_CONTENT = "block+";

type BaseNodeInput = Omit<CompiledNode, "content" | "atom" | "attrs" | "marks"> & {
  readonly content?: string;
  readonly atom?: boolean;
  readonly attrs?: RichTextAttrSpecs;
  readonly marks?: "all" | "none";
};

/** Escapes text for an HTML text node. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escapes a value for a double-quoted HTML attribute; null/undefined become the empty string. */
export function escapeAttribute(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? "" : escapeHtml(String(value));
}

/**
 * True when `href` is an absolute URL on an allowed scheme with no control
 * characters, whitespace or quotes anywhere in it. The parse is the browser's
 * own (`URL`), so `java\tscript:` tricks never survive it.
 */
export function isAllowedLink(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > RICH_TEXT_MAX_LINK_LENGTH) {
    return false;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must be refused
  if (/[\u0000- \u007f"'<>\\`]/u.test(href)) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return (RICH_TEXT_LINK_SCHEMES as readonly string[]).includes(parsed.protocol);
}

export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

function renderChildrenOnly(_node: RichTextNode, context: RichTextHtmlContext): string {
  return context.content;
}

function textChildrenOnly(_node: RichTextNode, context: RichTextTextContext): string {
  return context.content;
}

/**
 * The base allowlist (schema version 1), one entry per node the kernel
 * declares in `RICH_TEXT_BASE_NODE_NAMES`. The `attachment` node is added
 * only when the field embeds a managed attachment; `text` is handled by the
 * walker itself.
 */
function baseNodes(): readonly BaseNodeInput[] {
  return [
    {
      name: "doc",
      group: "block",
      content: RICH_TEXT_DOC_CONTENT,
      renderHtml: renderChildrenOnly,
      renderText: textChildrenOnly,
    },
    {
      name: "paragraph",
      group: "block",
      content: "inline*",
      renderHtml: (_node, { content }) => `<p>${content}</p>`,
      renderText: textChildrenOnly,
    },
    { name: "text", group: "inline", renderHtml: renderChildrenOnly, renderText: textChildrenOnly },
    {
      name: "heading",
      group: "block",
      content: "inline*",
      attrs: { level: { type: "integer", required: true, enum: [2, 3] } },
      renderHtml: (node, { content }) => {
        const level = node.attrs?.level === 3 ? 3 : 2;
        return `<h${level}>${content}</h${level}>`;
      },
      renderText: textChildrenOnly,
    },
    {
      name: "bulletList",
      group: "block",
      content: "listItem+",
      renderHtml: (_node, { content }) => `<ul>${content}</ul>`,
      renderText: textChildrenOnly,
    },
    {
      name: "orderedList",
      group: "block",
      content: "listItem+",
      attrs: {
        start: { type: "integer", default: 1 },
        type: { type: "string", nullable: true, default: null, enum: ["1", "a", "A", "i", "I"] },
      },
      renderHtml: (node, { content, attribute }) => {
        const start = node.attrs?.start;
        const type = node.attrs?.type;
        const attributes = [
          typeof start === "number" && start !== 1 ? ` start="${attribute(start)}"` : "",
          typeof type === "string" ? ` type="${attribute(type)}"` : "",
        ].join("");
        return `<ol${attributes}>${content}</ol>`;
      },
      renderText: textChildrenOnly,
    },
    {
      name: "listItem",
      group: "block",
      content: "paragraph block*",
      renderHtml: (_node, { content }) => `<li>${content}</li>`,
      renderText: textChildrenOnly,
    },
    {
      name: "blockquote",
      group: "block",
      content: "block+",
      renderHtml: (_node, { content }) => `<blockquote>${content}</blockquote>`,
      renderText: textChildrenOnly,
    },
    {
      name: "codeBlock",
      group: "block",
      content: "text*",
      marks: "none",
      attrs: { language: { type: "string", nullable: true, default: null, maxLength: 64 } },
      validate: (attrs) =>
        attrs.language === undefined ||
        attrs.language === null ||
        (typeof attrs.language === "string" && LANGUAGE_PATTERN.test(attrs.language))
          ? undefined
          : "language must be an identifier such as ts or c++",
      renderHtml: (node, { content, attribute }) => {
        const language = node.attrs?.language;
        const className =
          typeof language === "string" && language.length > 0
            ? ` class="language-${attribute(language)}"`
            : "";
        return `<pre><code${className}>${content}</code></pre>`;
      },
      renderText: textChildrenOnly,
    },
    {
      name: "hardBreak",
      group: "inline",
      renderHtml: () => "<br>",
      renderText: () => "\n",
    },
  ];
}

/** The embedded-object node, present only when the field declares an attachment. Rendered by the walker (it needs resolved URLs). */
const attachmentNode: BaseNodeInput = {
  name: "attachment",
  group: "block",
  atom: true,
  attrs: {
    objectId: { type: "string", required: true, maxLength: 128 },
    alt: { type: "string", nullable: true, default: null, maxLength: 512 },
  },
  validate: (attrs) =>
    isObjectId(attrs.objectId) ? undefined : "objectId must be a managed storage object id",
  renderHtml: (node, { attribute }) =>
    `<figure class="ship-attachment ship-attachment--unavailable" data-object-id="${attribute(node.attrs?.objectId)}"></figure>`,
  renderText: (node) => (typeof node.attrs?.alt === "string" ? node.attrs.alt : ""),
};

type BaseMarkInput = Omit<CompiledMark, "attrs" | "rank"> & { readonly attrs?: RichTextAttrSpecs };

function baseMarks(links: CompiledRichTextSchema["links"]): readonly BaseMarkInput[] {
  return [
    {
      name: "link",
      attrs: {
        href: { type: "string", required: true, maxLength: RICH_TEXT_MAX_LINK_LENGTH },
        title: { type: "string", nullable: true, default: null, maxLength: 512 },
      },
      validate: (attrs) =>
        isAllowedLink(attrs.href) ? undefined : "href must be an absolute https: or mailto: URL",
      renderHtml: (mark, inner, { attribute }) => {
        if (!isAllowedLink(mark.attrs?.href)) return inner;
        const title =
          typeof mark.attrs?.title === "string" && mark.attrs.title.length > 0
            ? ` title="${attribute(mark.attrs.title)}"`
            : "";
        const target = links.target ? ` target="${attribute(links.target)}"` : "";
        return `<a href="${attribute(mark.attrs.href)}" rel="${attribute(links.rel)}"${target}${title}>${inner}</a>`;
      },
    },
    { name: "bold", renderHtml: (_mark, inner) => `<strong>${inner}</strong>` },
    { name: "italic", renderHtml: (_mark, inner) => `<em>${inner}</em>` },
    { name: "code", renderHtml: (_mark, inner) => `<code>${inner}</code>` },
  ];
}

export function parseContentExpression(expression: string | undefined): readonly ContentItem[] {
  if (!expression) return [];
  return expression.split(" ").map((token) => {
    const quantifier = token.at(-1);
    if (quantifier === "*") return { name: token.slice(0, -1), min: 0, max: Infinity };
    if (quantifier === "+") return { name: token.slice(0, -1), min: 1, max: Infinity };
    if (quantifier === "?") return { name: token.slice(0, -1), min: 0, max: 1 };
    return { name: token, min: 1, max: 1 };
  });
}

/**
 * Compiles the base allowlist plus the field's extensions into the schema the
 * validator, sanitizer and renderers walk. Extensions are rejected at
 * `defineRichTextExtension` time if they collide with a base name.
 */
export function compileRichTextSchema(
  field: Pick<AnyRichText, "extensions" | "links" | "maxBytes" | "maxDepth"> & {
    readonly attachment?: unknown;
    readonly schemaVersion?: number;
  },
  options: CompileRichTextSchemaOptions = {},
): CompiledRichTextSchema {
  const attachments = options.attachments ?? field.attachment !== undefined;
  const nodes = new Map<string, CompiledNode>();
  const marks = new Map<string, CompiledMark>();
  const groups = new Map<string, string[]>();
  const addNode = (input: BaseNodeInput) => {
    const node: CompiledNode = Object.freeze({
      name: input.name,
      group: input.group,
      content: Object.freeze(parseContentExpression(input.content)),
      atom: input.atom ?? false,
      attrs: input.attrs ?? {},
      marks: input.marks ?? "all",
      renderHtml: input.renderHtml,
      renderText: input.renderText,
      ...(input.validate ? { validate: input.validate } : {}),
    });
    nodes.set(node.name, node);
    const group = groups.get(node.group) ?? [];
    group.push(node.name);
    groups.set(node.group, group);
  };
  for (const node of baseNodes()) addNode(node);
  if (attachments) addNode(attachmentNode);
  let rank = 0;
  const addMark = (input: BaseMarkInput) => {
    marks.set(
      input.name,
      Object.freeze({
        name: input.name,
        attrs: input.attrs ?? {},
        rank: rank++,
        renderHtml: input.renderHtml,
        ...(input.validate ? { validate: input.validate } : {}),
      }),
    );
  };
  for (const mark of baseMarks(field.links)) addMark(mark);
  for (const extension of field.extensions as readonly RichTextExtension[]) {
    for (const [name, node] of Object.entries(extension.nodes)) {
      addNode({
        name,
        group: node.spec.group,
        ...(node.spec.content !== undefined ? { content: node.spec.content } : {}),
        ...(node.spec.atom !== undefined ? { atom: node.spec.atom } : {}),
        ...(node.spec.attrs !== undefined ? { attrs: node.spec.attrs } : {}),
        ...(node.spec.marks !== undefined ? { marks: node.spec.marks } : {}),
        renderHtml: node.renderHtml,
        renderText: node.renderText,
        ...(node.validate ? { validate: node.validate } : {}),
      });
    }
    for (const [name, mark] of Object.entries(extension.marks)) {
      addMark({
        name,
        ...(mark.spec.attrs !== undefined ? { attrs: mark.spec.attrs } : {}),
        renderHtml: mark.renderHtml,
        ...(mark.validate ? { validate: mark.validate } : {}),
      });
    }
  }
  return Object.freeze({
    version: field.schemaVersion ?? RICH_TEXT_SCHEMA_VERSION,
    nodes,
    marks,
    groups: new Map([...groups].map(([group, names]) => [group, Object.freeze([...names])])),
    links: field.links,
    maxBytes: field.maxBytes,
    maxDepth: field.maxDepth,
    attachments,
  });
}

/** True when a child node name satisfies a content item (`block`, `inline` or an exact name). */
export function contentItemAccepts(
  schema: CompiledRichTextSchema,
  item: ContentItem,
  childName: string,
): boolean {
  if (item.name === childName) return true;
  const group = schema.groups.get(item.name);
  return group !== undefined && group.includes(childName);
}
