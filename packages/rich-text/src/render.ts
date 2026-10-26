import type {
  RichTextDocument,
  RichTextHtmlContext,
  RichTextMark,
  RichTextNode,
} from "@sixthsummit/ship-core";
import {
  type CompiledMark,
  type CompiledRichTextSchema,
  escapeAttribute,
  escapeHtml,
  isAllowedLink,
} from "./schema.js";

/** What the renderer needs for one embedded object; resolved by the capability at render time, never stored. */
export interface RichTextAttachmentRendering {
  /** A short-lived signed URL (or the stable public URL) for the original object. */
  readonly url: string;
  readonly contentType?: string;
}

export interface RenderRichTextHtmlOptions {
  /** Resolved embedded objects by id; an id without an entry renders as unavailable. */
  readonly attachments?: ReadonlyMap<string, RichTextAttachmentRendering | undefined>;
}

/**
 * Renders a validated document to HTML. Every text and attribute value is
 * escaped; link hrefs are re-checked against the allowed schemes; unknown
 * nodes and marks render nothing. This is a hand-written walker over the
 * JSON tree with no DOM, so it runs in Node and at the edge alike.
 */
export function renderRichTextHtml(
  schema: CompiledRichTextSchema,
  document: RichTextDocument,
  options: RenderRichTextHtmlOptions = {},
): string {
  const context: RichTextHtmlContext = Object.freeze({
    content: "",
    escape: escapeHtml,
    attribute: escapeAttribute,
  });
  return renderBlocks(schema, document.content, options, context);
}

function renderBlocks(
  schema: CompiledRichTextSchema,
  nodes: readonly RichTextNode[],
  options: RenderRichTextHtmlOptions,
  context: RichTextHtmlContext,
): string {
  return nodes.map((node) => renderNode(schema, node, options, context)).join("");
}

function renderNode(
  schema: CompiledRichTextSchema,
  node: RichTextNode,
  options: RenderRichTextHtmlOptions,
  context: RichTextHtmlContext,
): string {
  const spec = schema.nodes.get(node.type);
  if (!spec || node.type === "doc") return "";
  if (node.type === "attachment") return renderAttachment(node, options, context);
  const content = spec.content.some((item) => item.name === "inline" || item.name === "text")
    ? renderInline(schema, node.content ?? [], options, context)
    : renderBlocks(schema, node.content ?? [], options, context);
  const html = spec.renderHtml(node, { ...context, content });
  return node.type === "text" ? html : wrapMarks(schema, node.marks ?? [], html, context);
}

/** Merges adjacent text runs with identical marks, then wraps each run in its marks. */
function renderInline(
  schema: CompiledRichTextSchema,
  nodes: readonly RichTextNode[],
  options: RenderRichTextHtmlOptions,
  context: RichTextHtmlContext,
): string {
  const parts: string[] = [];
  let run: { readonly marks: readonly RichTextMark[]; text: string } | undefined;
  const flush = () => {
    if (run) parts.push(wrapMarks(schema, run.marks, escapeHtml(run.text), context));
    run = undefined;
  };
  for (const node of nodes) {
    if (node.type === "text") {
      const marks = node.marks ?? [];
      if (run && sameMarks(run.marks, marks)) {
        run.text += node.text ?? "";
      } else {
        flush();
        run = { marks, text: node.text ?? "" };
      }
      continue;
    }
    flush();
    parts.push(renderNode(schema, node, options, context));
  }
  flush();
  return parts.join("");
}

function sameMarks(left: readonly RichTextMark[], right: readonly RichTextMark[]): boolean {
  return (
    left.length === right.length &&
    left.every((mark, index) => JSON.stringify(mark) === JSON.stringify(right[index]))
  );
}

function wrapMarks(
  schema: CompiledRichTextSchema,
  marks: readonly RichTextMark[],
  inner: string,
  context: RichTextHtmlContext,
): string {
  const ordered = marks
    .map((mark) => ({ mark, spec: schema.marks.get(mark.type) }))
    .filter((item): item is { mark: RichTextMark; spec: CompiledMark } => item.spec !== undefined)
    .sort((left, right) => right.spec.rank - left.spec.rank);
  // Highest rank wraps first so the lowest rank (link) ends up outermost.
  return ordered.reduce((html, { mark, spec }) => {
    if (spec.name === "link" && !isAllowedLink(mark.attrs?.href)) return html;
    return spec.renderHtml(mark, html, context);
  }, inner);
}

function renderAttachment(
  node: RichTextNode,
  options: RenderRichTextHtmlOptions,
  context: RichTextHtmlContext,
): string {
  const objectId = typeof node.attrs?.objectId === "string" ? node.attrs.objectId : "";
  const resolved = options.attachments?.get(objectId);
  const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  if (!resolved) {
    return `<figure class="ship-attachment ship-attachment--unavailable" data-object-id="${context.attribute(objectId)}"></figure>`;
  }
  if (resolved.contentType?.startsWith("image/")) {
    return `<figure class="ship-attachment"><img src="${context.attribute(resolved.url)}" alt="${context.attribute(alt)}"></figure>`;
  }
  return `<figure class="ship-attachment"><a href="${context.attribute(resolved.url)}" rel="noopener noreferrer">${context.escape(alt || "Attachment")}</a></figure>`;
}

/**
 * The plain-text projection for search and previews: block boundaries become
 * newlines, hard breaks stay, embedded objects contribute their alt text and
 * extension nodes contribute what their `renderText` returns.
 */
export function renderRichTextText(
  schema: CompiledRichTextSchema,
  document: RichTextDocument,
): string {
  return document.content
    .map((node) => textOf(schema, node))
    .filter((text) => text.length > 0)
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function textOf(schema: CompiledRichTextSchema, node: RichTextNode): string {
  if (node.type === "text") return node.text ?? "";
  const spec = schema.nodes.get(node.type);
  if (!spec) return "";
  const children = node.content ?? [];
  const inline = spec.content.some((item) => item.name === "inline" || item.name === "text");
  const content = inline
    ? children.map((child) => textOf(schema, child)).join("")
    : children
        .map((child) => textOf(schema, child))
        .filter((text) => text.length > 0)
        .join("\n");
  return spec.renderText(node, { content });
}

/** Object ids of every embedded attachment in document order, without duplicates. */
export function collectRichTextAttachments(document: RichTextDocument): readonly string[] {
  const ids: string[] = [];
  const visit = (node: RichTextNode) => {
    if (node.type === "attachment" && typeof node.attrs?.objectId === "string") {
      if (!ids.includes(node.attrs.objectId)) ids.push(node.attrs.objectId);
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of document.content) visit(node);
  return Object.freeze(ids);
}
