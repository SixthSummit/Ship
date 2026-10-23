import type {
  RichTextAttrSpec,
  RichTextAttrSpecs,
  RichTextAttrs,
  RichTextAttrValue,
  RichTextDocument,
  RichTextIssue,
  RichTextIssueCode,
  RichTextMark,
  RichTextNode,
  RichTextSanitization,
  RichTextValidation,
} from "@sixthsummit/ship-core";
import {
  type CompiledNode,
  type CompiledRichTextSchema,
  contentItemAccepts,
  parseContentExpression,
  RICH_TEXT_DOC_CONTENT,
} from "./schema.js";

export interface RichTextValidationOptions {
  /** Overrides the field's `maxBytes`. */
  readonly maxBytes?: number;
  /** Overrides the field's `maxDepth`. */
  readonly maxDepth?: number;
  /**
   * Refuses the attachment nodes whose object is not available to the owner
   * (unknown, purged, attached elsewhere); `save` learns that from the
   * attachment capability and validates a second time with it.
   */
  readonly rejectAttachment?: (objectId: string) => boolean;
}

type Path = readonly (string | number)[];

interface Walk {
  readonly schema: CompiledRichTextSchema;
  readonly mode: "strict" | "sanitize";
  readonly issues: RichTextIssue[];
  readonly maxDepth: number;
  readonly rejectAttachment: ((objectId: string) => boolean) | undefined;
}

const DOC_CONTENT = parseContentExpression(RICH_TEXT_DOC_CONTENT);
const encoder = new TextEncoder();

/** Canonical JSON byte length, the size `maxBytes` bounds. */
export function richTextByteLength(input: unknown): number {
  return encoder.encode(JSON.stringify(input) ?? "").byteLength;
}

/**
 * Strict validation: every violation is an issue and the input is never
 * changed. A valid document comes back canonical (no empty `attrs`,
 * `marks` or `content`, nothing but declared keys) and frozen.
 */
export function validateRichTextDocument(
  schema: CompiledRichTextSchema,
  input: unknown,
  options: RichTextValidationOptions = {},
): RichTextValidation {
  const { document, issues } = walkDocument(schema, input, "strict", options);
  if (issues.length > 0 || !document) {
    return Object.freeze({ ok: false as const, issues: Object.freeze(issues) });
  }
  return Object.freeze({ ok: true as const, document });
}

/**
 * Sanitization: drops every node, mark and attribute the schema does not
 * allow and reports each drop. Always answers with a valid document; an
 * input that is not a document at all becomes the empty document.
 */
export function sanitizeRichTextDocument(
  schema: CompiledRichTextSchema,
  input: unknown,
  options: RichTextValidationOptions = {},
): RichTextSanitization {
  const { document, issues } = walkDocument(schema, input, "sanitize", options);
  return Object.freeze({
    document: document ?? emptyDocument(schema.version),
    dropped: Object.freeze(issues),
  });
}

export function emptyDocument(schemaVersion: number): RichTextDocument {
  return Object.freeze({
    schemaVersion,
    type: "doc" as const,
    content: Object.freeze([Object.freeze({ type: "paragraph" })]),
  });
}

function walkDocument(
  schema: CompiledRichTextSchema,
  input: unknown,
  mode: Walk["mode"],
  options: RichTextValidationOptions,
): { readonly document: RichTextDocument | undefined; readonly issues: RichTextIssue[] } {
  const issues: RichTextIssue[] = [];
  const report = (code: RichTextIssueCode, message: string, path: Path) => {
    issues.push(Object.freeze({ code, message, path: Object.freeze([...path]) }));
  };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    report("SHIP_RICH_TEXT_DOCUMENT_INVALID", "expected a rich text document object", []);
    return { document: undefined, issues };
  }
  const maxBytes = options.maxBytes ?? schema.maxBytes;
  if (richTextByteLength(input) > maxBytes) {
    report(
      "SHIP_RICH_TEXT_TOO_LARGE",
      `document exceeds the declared maximum of ${maxBytes} bytes`,
      [],
    );
    return { document: undefined, issues };
  }
  const schemaVersion = Reflect.get(input, "schemaVersion");
  if (schemaVersion !== schema.version) {
    report(
      "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
      Number.isSafeInteger(schemaVersion) && (schemaVersion as number) < schema.version
        ? `document is at schema version ${schemaVersion}; migrate it to ${schema.version} before saving or rendering`
        : `document schemaVersion must be ${schema.version}`,
      ["schemaVersion"],
    );
    return { document: undefined, issues };
  }
  if (Reflect.get(input, "type") !== "doc") {
    report("SHIP_RICH_TEXT_DOCUMENT_INVALID", 'document type must be "doc"', ["type"]);
    return { document: undefined, issues };
  }
  for (const key of Object.keys(input)) {
    if (key !== "schemaVersion" && key !== "type" && key !== "content") {
      report("SHIP_RICH_TEXT_DOCUMENT_INVALID", `unexpected document key ${JSON.stringify(key)}`, [
        key,
      ]);
      if (mode === "strict") return { document: undefined, issues };
    }
  }
  const walk: Walk = {
    schema,
    mode,
    issues,
    maxDepth: options.maxDepth ?? schema.maxDepth,
    rejectAttachment: options.rejectAttachment,
  };
  const doc = schema.nodes.get("doc") as CompiledNode;
  const content = walkChildren(walk, doc, Reflect.get(input, "content"), ["content"], 1, false);
  if (content === undefined) return { document: undefined, issues };
  let blocks = content;
  if (blocks.length === 0) {
    if (mode === "strict") {
      report("SHIP_RICH_TEXT_CONTENT_INVALID", "document must contain at least one block", [
        "content",
      ]);
      return { document: undefined, issues };
    }
    blocks = emptyDocument(schema.version).content;
  }
  return {
    document: Object.freeze({
      schemaVersion: schema.version,
      type: "doc" as const,
      content: Object.freeze(blocks),
    }),
    issues,
  };
}

/** Validates each child, then matches the surviving children against the parent's content expression. */
function walkChildren(
  walk: Walk,
  parent: CompiledNode,
  raw: unknown,
  path: Path,
  depth: number,
  marksForbidden: boolean,
): readonly RichTextNode[] | undefined {
  const report = (code: RichTextIssueCode, message: string, at: Path) =>
    walk.issues.push(Object.freeze({ code, message, path: Object.freeze([...at]) }));
  const items = parent.name === "doc" ? DOC_CONTENT : parent.content;
  if (raw === undefined) {
    if (items.some((item) => item.min > 0)) {
      report("SHIP_RICH_TEXT_CONTENT_INVALID", `${parent.name} requires content`, path);
      return walk.mode === "strict" ? undefined : repair(walk, parent, []);
    }
    return Object.freeze([]);
  }
  if (!Array.isArray(raw)) {
    report("SHIP_RICH_TEXT_CONTENT_INVALID", "content must be an array of nodes", path);
    return walk.mode === "strict" ? undefined : repair(walk, parent, []);
  }
  if (items.length === 0 && raw.length > 0) {
    report("SHIP_RICH_TEXT_CONTENT_INVALID", `${parent.name} cannot contain nodes`, path);
    return walk.mode === "strict" ? undefined : Object.freeze([]);
  }
  const children: { readonly node: RichTextNode; readonly index: number }[] = [];
  for (const [index, child] of raw.entries()) {
    const node = walkNode(walk, child, [...path, index], depth, marksForbidden);
    if (node) children.push({ node, index });
  }
  // Greedy sequential match of the content expression.
  const accepted: RichTextNode[] = [];
  let cursor = 0;
  for (const item of items) {
    let consumed = 0;
    while (
      cursor < children.length &&
      consumed < item.max &&
      contentItemAccepts(walk.schema, item, (children[cursor] as { node: RichTextNode }).node.type)
    ) {
      accepted.push((children[cursor] as { node: RichTextNode }).node);
      cursor += 1;
      consumed += 1;
    }
    if (consumed < item.min) {
      report(
        "SHIP_RICH_TEXT_CONTENT_INVALID",
        `${parent.name} requires ${item.name} content at position ${accepted.length}`,
        path,
      );
      if (walk.mode === "strict") return undefined;
      if (item.name === "paragraph") {
        accepted.push(Object.freeze({ type: "paragraph" }));
      } else {
        return repair(walk, parent, accepted);
      }
    }
  }
  for (const leftover of children.slice(cursor)) {
    report(
      "SHIP_RICH_TEXT_CONTENT_INVALID",
      `${parent.name} cannot contain ${leftover.node.type} at position ${leftover.index}`,
      [...path, leftover.index],
    );
    if (walk.mode === "strict") return undefined;
  }
  return Object.freeze(accepted);
}

/** In sanitize mode an unsatisfiable container is dropped by returning undefined, except the document root which is emptied. */
function repair(
  walk: Walk,
  parent: CompiledNode,
  accepted: readonly RichTextNode[],
): readonly RichTextNode[] | undefined {
  if (parent.name === "doc") return Object.freeze([...accepted]);
  return undefined;
}

function walkNode(
  walk: Walk,
  raw: unknown,
  path: Path,
  depth: number,
  marksForbidden: boolean,
): RichTextNode | undefined {
  const report = (code: RichTextIssueCode, message: string, at: Path = path) =>
    walk.issues.push(Object.freeze({ code, message, path: Object.freeze([...at]) }));
  if (depth > walk.maxDepth) {
    report(
      "SHIP_RICH_TEXT_TOO_DEEP",
      `nodes nest deeper than the declared maximum of ${walk.maxDepth}`,
    );
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    report("SHIP_RICH_TEXT_NODE_UNKNOWN", "expected a node object");
    return undefined;
  }
  const type = Reflect.get(raw, "type");
  if (typeof type !== "string") {
    report("SHIP_RICH_TEXT_NODE_UNKNOWN", "node type must be a string", [...path, "type"]);
    return undefined;
  }
  const spec = walk.schema.nodes.get(type);
  if (!spec || type === "doc") {
    report("SHIP_RICH_TEXT_NODE_UNKNOWN", `node ${JSON.stringify(type)} is not allowed`, [
      ...path,
      "type",
    ]);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!["type", "attrs", "content", "marks", "text"].includes(key)) {
      report("SHIP_RICH_TEXT_NODE_UNKNOWN", `unexpected node key ${JSON.stringify(key)}`, [
        ...path,
        key,
      ]);
      if (walk.mode === "strict") return undefined;
    }
  }
  const attrs = walkAttrs(walk, spec.attrs, Reflect.get(raw, "attrs"), [...path, "attrs"]);
  if (attrs === undefined) return undefined;
  if (spec.validate) {
    const message = spec.validate(attrs);
    if (message) {
      report("SHIP_RICH_TEXT_ATTR_INVALID", `${type}: ${message}`, [...path, "attrs"]);
      return undefined;
    }
  }
  if (type === "attachment" && walk.rejectAttachment?.(String(attrs.objectId))) {
    report(
      "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE",
      `object ${JSON.stringify(attrs.objectId)} is not an available upload of this field's attachment`,
      [...path, "attrs", "objectId"],
    );
    return undefined;
  }
  const marks = walkMarks(walk, Reflect.get(raw, "marks"), [...path, "marks"], marksForbidden);
  if (marks === undefined) return undefined;
  if (type === "text") {
    const text = Reflect.get(raw, "text");
    if (typeof text !== "string" || text.length === 0 || !isStorableText(text)) {
      report(
        "SHIP_RICH_TEXT_TEXT_INVALID",
        "text nodes must carry a non-empty, well-formed string without U+0000",
        [...path, "text"],
      );
      if (walk.mode === "strict" || typeof text !== "string") return undefined;
      const cleaned = cleanText(text);
      if (cleaned.length === 0) return undefined;
      return Object.freeze({ type, text: cleaned, ...(marks.length > 0 ? { marks } : {}) });
    }
    if (Reflect.get(raw, "content") !== undefined) {
      report("SHIP_RICH_TEXT_CONTENT_INVALID", "text nodes cannot contain nodes", [
        ...path,
        "content",
      ]);
      if (walk.mode === "strict") return undefined;
    }
    return Object.freeze({ type, text, ...(marks.length > 0 ? { marks } : {}) });
  }
  if (Reflect.get(raw, "text") !== undefined) {
    report("SHIP_RICH_TEXT_TEXT_INVALID", `${type} nodes cannot carry text`, [...path, "text"]);
    if (walk.mode === "strict") return undefined;
  }
  const content = walkChildren(
    walk,
    spec,
    Reflect.get(raw, "content"),
    [...path, "content"],
    depth + 1,
    marksForbidden || spec.marks === "none",
  );
  if (content === undefined) return undefined;
  return Object.freeze({
    type,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(marks.length > 0 ? { marks } : {}),
  });
}

function walkMarks(
  walk: Walk,
  raw: unknown,
  path: Path,
  forbidden: boolean,
): readonly RichTextMark[] | undefined {
  const report = (code: RichTextIssueCode, message: string, at: Path) =>
    walk.issues.push(Object.freeze({ code, message, path: Object.freeze([...at]) }));
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    report("SHIP_RICH_TEXT_MARK_UNKNOWN", "marks must be an array", path);
    return walk.mode === "strict" ? undefined : Object.freeze([]);
  }
  if (forbidden && raw.length > 0) {
    report("SHIP_RICH_TEXT_MARK_FORBIDDEN", "marks are not allowed inside this node", path);
    return walk.mode === "strict" ? undefined : Object.freeze([]);
  }
  const marks: RichTextMark[] = [];
  const seen = new Set<string>();
  for (const [index, rawMark] of raw.entries()) {
    const markPath = [...path, index];
    const type =
      typeof rawMark === "object" && rawMark !== null ? Reflect.get(rawMark, "type") : undefined;
    const spec = typeof type === "string" ? walk.schema.marks.get(type) : undefined;
    if (!spec) {
      report(
        "SHIP_RICH_TEXT_MARK_UNKNOWN",
        `mark ${JSON.stringify(type)} is not allowed`,
        markPath,
      );
      if (walk.mode === "strict") return undefined;
      continue;
    }
    if (seen.has(spec.name)) {
      report("SHIP_RICH_TEXT_MARK_UNKNOWN", `mark ${JSON.stringify(type)} is repeated`, markPath);
      if (walk.mode === "strict") return undefined;
      continue;
    }
    for (const key of Object.keys(rawMark as object)) {
      if (key !== "type" && key !== "attrs") {
        report("SHIP_RICH_TEXT_MARK_UNKNOWN", `unexpected mark key ${JSON.stringify(key)}`, [
          ...markPath,
          key,
        ]);
        if (walk.mode === "strict") return undefined;
      }
    }
    const attrs = walkAttrs(walk, spec.attrs, Reflect.get(rawMark as object, "attrs"), [
      ...markPath,
      "attrs",
    ]);
    if (attrs === undefined) {
      if (walk.mode === "strict") return undefined;
      continue;
    }
    if (spec.validate) {
      const message = spec.validate(attrs);
      if (message) {
        report(
          spec.name === "link" ? "SHIP_RICH_TEXT_LINK_INVALID" : "SHIP_RICH_TEXT_ATTR_INVALID",
          `${spec.name}: ${message}`,
          [...markPath, "attrs"],
        );
        if (walk.mode === "strict") return undefined;
        continue;
      }
    }
    seen.add(spec.name);
    marks.push(
      Object.freeze({ type: spec.name, ...(Object.keys(attrs).length > 0 ? { attrs } : {}) }),
    );
  }
  return Object.freeze(marks);
}

/**
 * Validates attributes against their specs. Returns the declared attributes
 * that were present (unknown ones dropped and reported), or undefined when
 * the node must be dropped (a required attribute missing or invalid).
 */
function walkAttrs(
  walk: Walk,
  specs: RichTextAttrSpecs,
  raw: unknown,
  path: Path,
): RichTextAttrs | undefined {
  const report = (message: string, at: Path) =>
    walk.issues.push(
      Object.freeze({ code: "SHIP_RICH_TEXT_ATTR_INVALID", message, path: Object.freeze([...at]) }),
    );
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    report("attrs must be an object", path);
    return undefined;
  }
  const attrs: Record<string, RichTextAttrValue> = {};
  let failed = false;
  if (raw) {
    for (const key of Object.keys(raw)) {
      if (!(key in specs)) {
        report(`unknown attribute ${JSON.stringify(key)}`, [...path, key]);
        if (walk.mode === "strict") failed = true;
      }
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    const value = raw ? Reflect.get(raw, name) : undefined;
    if (value === undefined) {
      if (spec.required) {
        report(`missing required attribute ${JSON.stringify(name)}`, [...path, name]);
        failed = true;
      }
      continue;
    }
    if (!attrValueMatches(spec, value)) {
      report(`attribute ${JSON.stringify(name)} is not a valid ${spec.type}`, [...path, name]);
      if (walk.mode === "strict" || spec.required) failed = true;
      continue;
    }
    attrs[name] = value as RichTextAttrValue;
  }
  return failed ? undefined : Object.freeze(attrs);
}

function attrValueMatches(spec: RichTextAttrSpec, value: unknown): boolean {
  if (value === null) return spec.nullable === true || spec.default === null;
  if (spec.type === "string") {
    return (
      typeof value === "string" &&
      isStorableText(value) &&
      (spec.maxLength === undefined || value.length <= spec.maxLength) &&
      (spec.enum === undefined || spec.enum.includes(value))
    );
  }
  if (spec.type === "integer") {
    return (
      Number.isSafeInteger(value) &&
      (spec.enum === undefined || spec.enum.includes(value as number))
    );
  }
  return typeof value === "boolean";
}

/** PostgreSQL jsonb refuses U+0000 and JSON refuses lone surrogates; neither may reach storage. */
function isStorableText(text: string): boolean {
  if (text.includes("\u0000")) return false;
  const wellFormed = (text as { isWellFormed?: () => boolean }).isWellFormed;
  return typeof wellFormed === "function" ? wellFormed.call(text) : true;
}

function cleanText(text: string): string {
  const stripped = text.replaceAll("\u0000", "");
  const toWellFormed = (stripped as { toWellFormed?: () => string }).toWellFormed;
  return typeof toWellFormed === "function" ? toWellFormed.call(stripped) : stripped;
}
