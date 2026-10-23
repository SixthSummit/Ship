import type { ApplicationDiagnostic } from "./application.js";
import type { AnyAttachment, ScopedAttachmentCapability } from "./attachment.js";
import { isAttachment } from "./attachment.js";
import type { DependencyToken } from "./dependency.js";
import { isDependencyToken } from "./dependency.js";
import type { AnyModule } from "./module.js";
import type { AnyOperation } from "./operation.js";

const RICH_TEXT_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const EXTENSION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;
/** ProseMirror node and mark names are camelCase identifiers (`mergeField`). */
const NODE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/u;
const ATTR_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/u;
const CONTENT_EXPRESSION_PATTERN = /^(?:[a-z][A-Za-z0-9]*[*+?]?(?: [a-z][A-Za-z0-9]*[*+?]?)*)?$/u;
const BINDING_SUFFIX = ".rich-text";

/**
 * The version of the kernel-owned base schema. Every stored document carries
 * the version it was validated against; a bump is a deliberate release step
 * that ships a migration (`RichTextMigration`), never a silent change in
 * what an existing document renders to.
 */
export const RICH_TEXT_SCHEMA_VERSION = 1;
/** Upper bound on the canonical JSON size of one document, in bytes. */
export const DEFAULT_RICH_TEXT_MAX_BYTES = 256 * 1024;
/** Upper bound on node nesting; a deeper document is refused before it is walked. */
export const DEFAULT_RICH_TEXT_MAX_DEPTH = 32;
/** Link `rel` the renderer emits unless the field declares another. */
export const DEFAULT_RICH_TEXT_LINK_REL = "noopener noreferrer";

/**
 * The base allowlist (schema version 1). Nodes and marks outside it cannot
 * exist in a stored document; consumer extensions add named nodes and marks
 * next to them and can never redefine one.
 */
export const RICH_TEXT_BASE_NODE_NAMES = Object.freeze([
  "doc",
  "paragraph",
  "text",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "hardBreak",
  "attachment",
] as const);
export const RICH_TEXT_BASE_MARK_NAMES = Object.freeze(["bold", "italic", "code", "link"] as const);
export type RichTextBaseNodeName = (typeof RICH_TEXT_BASE_NODE_NAMES)[number];
export type RichTextBaseMarkName = (typeof RICH_TEXT_BASE_MARK_NAMES)[number];

// ---------------------------------------------------------------------------
// Document model (ProseMirror JSON plus a schema version)
// ---------------------------------------------------------------------------

export type RichTextAttrValue = string | number | boolean | null;
export type RichTextAttrs = Readonly<Record<string, RichTextAttrValue>>;

export interface RichTextMark {
  readonly type: string;
  readonly attrs?: RichTextAttrs;
}

export interface RichTextNode {
  readonly type: string;
  readonly attrs?: RichTextAttrs;
  readonly content?: readonly RichTextNode[];
  readonly marks?: readonly RichTextMark[];
  /** Present on `text` nodes only. */
  readonly text?: string;
}

/**
 * The stored shape of a rich text field: the ProseMirror document (what a
 * TipTap editor emits from `getJSON()`) with the schema version it was
 * validated against. Never raw HTML.
 */
export interface RichTextDocument {
  readonly schemaVersion: number;
  readonly type: "doc";
  readonly content: readonly RichTextNode[];
}

// ---------------------------------------------------------------------------
// Structural specs: client-safe, projected into the contract
// ---------------------------------------------------------------------------

export type RichTextAttrType = "string" | "integer" | "boolean";

/** One node or mark attribute. The structural part is enough for the editor to build the same schema. */
export interface RichTextAttrSpec {
  readonly type: RichTextAttrType;
  /** Absent attributes are refused when required; otherwise `default` (or `null` when nullable) applies. */
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly default?: RichTextAttrValue;
  readonly enum?: readonly (string | number)[];
  /** For strings: maximum length in UTF-16 units. */
  readonly maxLength?: number;
}

export type RichTextAttrSpecs = Readonly<Record<string, RichTextAttrSpec>>;

export interface RichTextNodeSpec {
  readonly group: "block" | "inline";
  /**
   * ProseMirror-style content expression over node names and the `block`,
   * `inline` groups with `*`, `+` or `?` quantifiers (`"inline*"`,
   * `"block+"`, `"paragraph block*"`). Absent or empty for a leaf.
   */
  readonly content?: string;
  /** An atom carries no editable content; the editor treats it as one unit. */
  readonly atom?: boolean;
  readonly attrs?: RichTextAttrSpecs;
  /** `none` forbids marks on every descendant (as a code block does); the default allows all. */
  readonly marks?: "all" | "none";
}

export interface RichTextMarkSpec {
  readonly attrs?: RichTextAttrSpecs;
}

// ---------------------------------------------------------------------------
// Extensions: named, reviewable widenings of the base schema
// ---------------------------------------------------------------------------

export interface RichTextHtmlContext {
  /** The already rendered, already escaped HTML of the node's children. */
  readonly content: string;
  readonly escape: (text: string) => string;
  readonly attribute: (value: string | number | boolean | null | undefined) => string;
}

export interface RichTextTextContext {
  /** The plain-text projection of the node's children. */
  readonly content: string;
}

export interface RichTextNodeExtension {
  readonly spec: RichTextNodeSpec;
  /** Returns HTML for the node; everything taken from `node.attrs` must go through `context.escape` / `context.attribute`. */
  readonly renderHtml: (node: RichTextNode, context: RichTextHtmlContext) => string;
  readonly renderText: (node: RichTextNode, context: RichTextTextContext) => string;
  /** Extra attribute validation; returns a message to refuse the node. */
  readonly validate?: (attrs: RichTextAttrs) => string | undefined;
}

export interface RichTextMarkExtension {
  readonly spec: RichTextMarkSpec;
  /** Wraps the already escaped inner HTML. */
  readonly renderHtml: (mark: RichTextMark, inner: string, context: RichTextHtmlContext) => string;
  readonly validate?: (attrs: RichTextAttrs) => string | undefined;
}

export interface RichTextExtensionDefinition {
  /** A lowercase kebab-case name the contract projects (`merge-field`). */
  readonly name: string;
  readonly nodes?: Readonly<Record<string, RichTextNodeExtension>>;
  readonly marks?: Readonly<Record<string, RichTextMarkExtension>>;
}

export interface RichTextExtension extends RichTextExtensionDefinition {
  readonly kind: "ship.rich-text-extension";
  readonly nodes: Readonly<Record<string, RichTextNodeExtension>>;
  readonly marks: Readonly<Record<string, RichTextMarkExtension>>;
}

export type RichTextDefinitionDiagnosticCode =
  | "SHIP_RICH_TEXT_DEFINITION_INVALID"
  | "SHIP_RICH_TEXT_ID_INVALID"
  | "SHIP_RICH_TEXT_ATTACHMENT_INVALID"
  | "SHIP_RICH_TEXT_EXTENSION_INVALID"
  | "SHIP_RICH_TEXT_EXTENSION_DUPLICATE"
  | "SHIP_RICH_TEXT_EXTENSION_NAME_INVALID"
  | "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID"
  | "SHIP_RICH_TEXT_EXTENSION_NODE_RESERVED"
  | "SHIP_RICH_TEXT_EXTENSION_MARK_INVALID"
  | "SHIP_RICH_TEXT_EXTENSION_MARK_RESERVED"
  | "SHIP_RICH_TEXT_MAX_BYTES_INVALID"
  | "SHIP_RICH_TEXT_MAX_DEPTH_INVALID"
  | "SHIP_RICH_TEXT_LINKS_INVALID"
  | "SHIP_RICH_TEXT_ON_INVALID_INVALID"
  | "SHIP_RICH_TEXT_MIGRATION_INVALID";

export class InvalidRichTextDefinitionError extends Error {
  readonly code: RichTextDefinitionDiagnosticCode;
  readonly fieldId?: string;
  readonly field?: string;

  constructor(
    code: RichTextDefinitionDiagnosticCode,
    message: string,
    options: { readonly fieldId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidRichTextDefinitionError";
    this.code = code;
    this.fieldId = options.fieldId;
    this.field = options.field;
  }
}

/**
 * Declares a named widening of the base schema: extra nodes and marks with
 * their structural spec (projected to the editor) and their server-side
 * renderers. An extension can never redefine a base node or mark.
 */
export function defineRichTextExtension(
  definition: RichTextExtensionDefinition,
): RichTextExtension {
  assertExtensionDefinition(definition);
  const nodes = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.nodes ?? {}).map(([name, node]) => [
        name,
        Object.freeze({ ...node, spec: freezeNodeSpec(node.spec) }),
      ]),
    ),
  );
  const marks = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.marks ?? {}).map(([name, mark]) => [
        name,
        Object.freeze({ ...mark, spec: freezeMarkSpec(mark.spec) }),
      ]),
    ),
  );
  return Object.freeze({
    kind: "ship.rich-text-extension" as const,
    name: definition.name,
    nodes,
    marks,
  });
}

export function isRichTextExtension(value: unknown): value is RichTextExtension {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.rich-text-extension" &&
    typeof Reflect.get(value, "name") === "string" &&
    EXTENSION_NAME_PATTERN.test(Reflect.get(value, "name")) &&
    typeof Reflect.get(value, "nodes") === "object" &&
    typeof Reflect.get(value, "marks") === "object"
  );
}

// ---------------------------------------------------------------------------
// Field declaration
// ---------------------------------------------------------------------------

export interface RichTextLinkOptions {
  /** `rel` every rendered link carries; defaults to {@link DEFAULT_RICH_TEXT_LINK_REL}. */
  readonly rel?: string;
  /** `target` every rendered link carries; absent by default. */
  readonly target?: "_blank" | "_self";
}

/**
 * Moves a document from one schema version to the next. Migrations are
 * declared on the field and applied only through the explicit `migrate`
 * capability call, so a release that bumps the version rewrites stored rows
 * on purpose.
 */
export interface RichTextMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (document: RichTextDocument) => RichTextDocument;
}

/** What `save` does with a document the server refuses: answer with the issues, or drop what is not allowed. */
export type RichTextInvalidPolicy = "reject" | "sanitize";

export interface RichTextDefinition<
  TId extends string = string,
  TAttachment extends AnyAttachment | undefined = AnyAttachment | undefined,
> {
  /** Namespaced by the owning module, `<moduleId>.<field>`, like an attachment id. */
  readonly id: TId;
  /**
   * The managed attachment embedded objects belong to. Declared by the same
   * module; `save` attaches and detaches referenced objects in the owning
   * transaction so purge follows the record. Absent for text-only fields,
   * whose schema then carries no `attachment` node at all.
   */
  readonly attachment?: TAttachment;
  readonly extensions?: readonly RichTextExtension[];
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly links?: RichTextLinkOptions;
  readonly onInvalid?: RichTextInvalidPolicy;
  readonly migrations?: readonly RichTextMigration[];
}

export interface RichText<
  TId extends string = string,
  TAttachment extends AnyAttachment | undefined = AnyAttachment | undefined,
> extends RichTextDefinition<TId, TAttachment> {
  readonly kind: "ship.rich-text";
  readonly schemaVersion: number;
  readonly extensions: readonly RichTextExtension[];
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly links: Required<Pick<RichTextLinkOptions, "rel">> & Pick<RichTextLinkOptions, "target">;
  readonly onInvalid: RichTextInvalidPolicy;
  readonly migrations: readonly RichTextMigration[];
  /** The dependency an operation binds to validate, save, render and clear documents of this field. */
  readonly binding: RichTextDependencyToken;
}

export interface AnyRichText {
  readonly kind: "ship.rich-text";
  readonly id: string;
  readonly schemaVersion: number;
  readonly attachment?: AnyAttachment;
  readonly extensions: readonly RichTextExtension[];
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly links: Required<Pick<RichTextLinkOptions, "rel">> & Pick<RichTextLinkOptions, "target">;
  readonly onInvalid: RichTextInvalidPolicy;
  readonly migrations: readonly RichTextMigration[];
  readonly binding: DependencyToken & { readonly scope: "rich-text"; readonly fieldId: string };
}

export interface RichTextDependencyToken
  extends DependencyToken<RichTextCapability, ScopedRichTextCapability> {
  readonly scope: "rich-text";
  readonly fieldId: string;
}

/**
 * Declares a rich text field: the versioned base allowlist plus the named
 * extensions that widen it, the managed attachment embedded objects belong
 * to, and the document size limits. The declaration carries no rendering
 * engine; `@sixthsummit/ship-rich-text` provides the capability bound to
 * `binding`.
 */
export function defineRichText<
  const TId extends string,
  const TAttachment extends AnyAttachment | undefined = undefined,
>(definition: RichTextDefinition<TId, TAttachment>): RichText<TId, TAttachment> {
  assertRichTextDefinition(definition);
  const field = {
    kind: "ship.rich-text" as const,
    id: definition.id,
    schemaVersion: RICH_TEXT_SCHEMA_VERSION,
    ...(definition.attachment ? { attachment: definition.attachment } : {}),
    extensions: Object.freeze([...(definition.extensions ?? [])]),
    maxBytes: definition.maxBytes ?? DEFAULT_RICH_TEXT_MAX_BYTES,
    maxDepth: definition.maxDepth ?? DEFAULT_RICH_TEXT_MAX_DEPTH,
    links: Object.freeze({
      rel: definition.links?.rel ?? DEFAULT_RICH_TEXT_LINK_REL,
      ...(definition.links?.target ? { target: definition.links.target } : {}),
    }),
    onInvalid: definition.onInvalid ?? "reject",
    migrations: Object.freeze(
      [...(definition.migrations ?? [])].sort((left, right) => left.from - right.from),
    ),
  } as {
    -readonly [TKey in keyof RichText<TId, TAttachment>]: RichText<TId, TAttachment>[TKey];
  };
  field.binding = Object.freeze({
    kind: "ship.dependency" as const,
    id: `${definition.id}${BINDING_SUFFIX}`,
    scope: "rich-text" as const,
    fieldId: definition.id,
  }) as RichTextDependencyToken;
  const frozen = Object.freeze(field);
  bindingFields.set(field.binding, frozen as unknown as AnyRichText);
  return frozen;
}

const bindingFields = new WeakMap<object, AnyRichText>();

/** Resolves the field a binding token was created for; undefined for foreign tokens. */
export function richTextForBinding(token: DependencyToken): AnyRichText | undefined {
  return bindingFields.get(token);
}

export function isRichText(value: unknown): value is AnyRichText {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.rich-text" &&
    typeof Reflect.get(value, "id") === "string" &&
    RICH_TEXT_ID_PATTERN.test(Reflect.get(value, "id")) &&
    isRichTextDependencyToken(Reflect.get(value, "binding"))
  );
}

export function isRichTextDependencyToken(value: unknown): value is RichTextDependencyToken {
  return (
    isDependencyToken(value) &&
    value.scope === "rich-text" &&
    typeof Reflect.get(value, "fieldId") === "string" &&
    value.id === `${Reflect.get(value, "fieldId")}${BINDING_SUFFIX}`
  );
}

// ---------------------------------------------------------------------------
// Capability contracts (the engine lives in @sixthsummit/ship-rich-text)
// ---------------------------------------------------------------------------

export type RichTextIssueCode =
  | "SHIP_RICH_TEXT_DOCUMENT_INVALID"
  | "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED"
  | "SHIP_RICH_TEXT_TOO_LARGE"
  | "SHIP_RICH_TEXT_TOO_DEEP"
  | "SHIP_RICH_TEXT_NODE_UNKNOWN"
  | "SHIP_RICH_TEXT_MARK_UNKNOWN"
  | "SHIP_RICH_TEXT_MARK_FORBIDDEN"
  | "SHIP_RICH_TEXT_CONTENT_INVALID"
  | "SHIP_RICH_TEXT_ATTR_INVALID"
  | "SHIP_RICH_TEXT_TEXT_INVALID"
  | "SHIP_RICH_TEXT_LINK_INVALID"
  | "SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE";

export interface RichTextIssue {
  readonly code: RichTextIssueCode;
  readonly message: string;
  /** JSON path into the submitted document (`["content", 0, "marks", 1, "attrs", "href"]`). */
  readonly path: readonly (string | number)[];
}

export type RichTextValidation =
  | { readonly ok: true; readonly document: RichTextDocument }
  | { readonly ok: false; readonly issues: readonly RichTextIssue[] };

export interface RichTextSanitization {
  readonly document: RichTextDocument;
  /** What was dropped to reach a valid document; empty when the input already was one. */
  readonly dropped: readonly RichTextIssue[];
}

export interface RichTextSaved {
  /** The document to store: validated (or sanitized) and at the current schema version. */
  readonly document: RichTextDocument;
  /** The plain-text projection to store next to it for search and previews. */
  readonly text: string;
  /** Every embedded object the document references, now attached to the owner. */
  readonly attachmentIds: readonly string[];
  readonly attached: readonly string[];
  /** Objects the previous document referenced and this one no longer does; their purge intents are recorded. */
  readonly detached: readonly string[];
}

export interface RichTextRenderOptions {
  /** Lifetime of the signed URLs embedded attachments render with. */
  readonly expiresInMs?: number;
}

/**
 * The handler-facing view of one field, bound by the executor to the
 * running transaction and to the field's attachment capability in the same
 * scope. The server is the trust boundary: every document goes through the
 * allowlist here regardless of what the editor did.
 */
export interface ScopedRichTextCapability {
  readonly fieldId: string;
  readonly schemaVersion: number;
  /** Strict validation against the schema; never changes the input. */
  validate(input: unknown): RichTextValidation;
  /** Drops everything the schema does not allow and reports what was dropped. */
  sanitize(input: unknown): RichTextSanitization;
  /** The plain-text projection of a valid document. */
  text(document: RichTextDocument): string;
  /** Object ids of every embedded attachment, in document order, without duplicates. */
  attachments(document: RichTextDocument): readonly string[];
  /** Renders a valid, current-version document to HTML; embedded objects get short-lived signed URLs resolved now. */
  render(document: RichTextDocument, options?: RichTextRenderOptions): Promise<string>;
  /**
   * Validates (or sanitizes, per the field's `onInvalid`) and reconciles the
   * owner's embedded objects: newly referenced uploads are attached, objects
   * no longer referenced are detached with a purge intent, all in the running
   * write transaction. Returns what to store.
   */
  save(input: { readonly ownerId: string; readonly document: unknown }): Promise<RichTextSaved>;
  /** Detaches every embedded object of the owner; call it when the owning record is deleted. */
  clear(input: { readonly ownerId: string }): Promise<readonly string[]>;
  /** Applies the declared migrations up to the current schema version. */
  migrate(document: RichTextDocument): RichTextDocument;
}

/** The provider value bound to `richText.binding`; the executor scopes it per run. */
export interface RichTextCapability {
  readonly kind: "ship.rich-text-capability";
  readonly fieldId: string;
  /** The attachment the engine expects a scoped capability for; absent for text-only fields. */
  readonly attachmentId?: string;
  withScope(
    scope: object | undefined,
    attachments: ScopedAttachmentCapability | undefined,
  ): ScopedRichTextCapability;
}

export function isRichTextCapability(value: unknown): value is RichTextCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.rich-text-capability" &&
    typeof Reflect.get(value, "fieldId") === "string" &&
    typeof Reflect.get(value, "withScope") === "function"
  );
}

// ---------------------------------------------------------------------------
// Definition checks
// ---------------------------------------------------------------------------

function assertRichTextDefinition(definition: unknown): asserts definition is RichTextDefinition {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_RICH_TEXT_DEFINITION_INVALID", "rich text definition must be an object");
  }
  const id = Reflect.get(definition, "id");
  const fieldId = typeof id === "string" ? id : undefined;
  if (!fieldId || !RICH_TEXT_ID_PATTERN.test(fieldId)) {
    fail(
      "SHIP_RICH_TEXT_ID_INVALID",
      "rich text id must contain at least two lowercase dot-separated segments (<moduleId>.<field>)",
      fieldId,
      "id",
    );
  }
  const attachment = Reflect.get(definition, "attachment");
  if (attachment !== undefined && !isAttachment(attachment)) {
    fail(
      "SHIP_RICH_TEXT_ATTACHMENT_INVALID",
      "attachment must be a defineAttachment() result",
      fieldId,
      "attachment",
    );
  }
  const extensions = Reflect.get(definition, "extensions");
  if (extensions !== undefined) {
    if (!Array.isArray(extensions) || !extensions.every(isRichTextExtension)) {
      fail(
        "SHIP_RICH_TEXT_EXTENSION_INVALID",
        "extensions must contain only defineRichTextExtension() results",
        fieldId,
        "extensions",
      );
    }
    const names = new Set<string>();
    const nodeNames = new Set<string>();
    const markNames = new Set<string>();
    for (const extension of extensions as RichTextExtension[]) {
      if (names.has(extension.name)) {
        fail(
          "SHIP_RICH_TEXT_EXTENSION_DUPLICATE",
          `duplicate rich text extension ${JSON.stringify(extension.name)}`,
          fieldId,
          "extensions",
        );
      }
      names.add(extension.name);
      for (const name of Object.keys(extension.nodes)) {
        if (nodeNames.has(name)) {
          fail(
            "SHIP_RICH_TEXT_EXTENSION_DUPLICATE",
            `node ${JSON.stringify(name)} is declared by two extensions`,
            fieldId,
            "extensions",
          );
        }
        nodeNames.add(name);
      }
      for (const name of Object.keys(extension.marks)) {
        if (markNames.has(name)) {
          fail(
            "SHIP_RICH_TEXT_EXTENSION_DUPLICATE",
            `mark ${JSON.stringify(name)} is declared by two extensions`,
            fieldId,
            "extensions",
          );
        }
        markNames.add(name);
      }
    }
  }
  const maxBytes = Reflect.get(definition, "maxBytes");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0)) {
    fail(
      "SHIP_RICH_TEXT_MAX_BYTES_INVALID",
      "maxBytes must be a positive safe integer",
      fieldId,
      "maxBytes",
    );
  }
  const maxDepth = Reflect.get(definition, "maxDepth");
  if (
    maxDepth !== undefined &&
    (!Number.isSafeInteger(maxDepth) || (maxDepth as number) < 2 || (maxDepth as number) > 1024)
  ) {
    fail(
      "SHIP_RICH_TEXT_MAX_DEPTH_INVALID",
      "maxDepth must be an integer between 2 and 1024",
      fieldId,
      "maxDepth",
    );
  }
  const links = Reflect.get(definition, "links");
  if (links !== undefined) {
    const rel = Reflect.get(links, "rel");
    const target = Reflect.get(links, "target");
    if (
      typeof links !== "object" ||
      links === null ||
      (rel !== undefined && (typeof rel !== "string" || !/^[a-z]+(?: [a-z]+)*$/u.test(rel))) ||
      (target !== undefined && target !== "_blank" && target !== "_self")
    ) {
      fail(
        "SHIP_RICH_TEXT_LINKS_INVALID",
        "links must be { rel?: space-separated link types, target?: _blank | _self }",
        fieldId,
        "links",
      );
    }
  }
  const onInvalid = Reflect.get(definition, "onInvalid");
  if (onInvalid !== undefined && onInvalid !== "reject" && onInvalid !== "sanitize") {
    fail(
      "SHIP_RICH_TEXT_ON_INVALID_INVALID",
      "onInvalid must be reject or sanitize",
      fieldId,
      "onInvalid",
    );
  }
  const migrations = Reflect.get(definition, "migrations");
  if (migrations === undefined) return;
  if (!Array.isArray(migrations)) {
    fail(
      "SHIP_RICH_TEXT_MIGRATION_INVALID",
      "migrations must be a list of { from, to, migrate }",
      fieldId,
      "migrations",
    );
  }
  const froms = new Set<number>();
  for (const migration of migrations) {
    const from = Reflect.get(migration, "from");
    const to = Reflect.get(migration, "to");
    if (
      typeof migration !== "object" ||
      migration === null ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      (to as number) !== (from as number) + 1 ||
      (to as number) > RICH_TEXT_SCHEMA_VERSION ||
      typeof Reflect.get(migration, "migrate") !== "function" ||
      froms.has(from as number)
    ) {
      fail(
        "SHIP_RICH_TEXT_MIGRATION_INVALID",
        `migrations must step one version at a time up to ${RICH_TEXT_SCHEMA_VERSION}, each from-version once`,
        fieldId,
        "migrations",
      );
    }
    froms.add(from as number);
  }
}

function assertExtensionDefinition(
  definition: unknown,
): asserts definition is RichTextExtensionDefinition {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_RICH_TEXT_EXTENSION_INVALID", "rich text extension definition must be an object");
  }
  const name = Reflect.get(definition, "name");
  if (typeof name !== "string" || !EXTENSION_NAME_PATTERN.test(name)) {
    fail(
      "SHIP_RICH_TEXT_EXTENSION_NAME_INVALID",
      "extension name must be a lowercase kebab-case identifier",
      undefined,
      "name",
    );
  }
  const nodes = Reflect.get(definition, "nodes") ?? {};
  const marks = Reflect.get(definition, "marks") ?? {};
  if (
    typeof nodes !== "object" ||
    nodes === null ||
    Array.isArray(nodes) ||
    typeof marks !== "object" ||
    marks === null ||
    Array.isArray(marks)
  ) {
    fail(
      "SHIP_RICH_TEXT_EXTENSION_INVALID",
      "extension nodes and marks must be maps of names to specs",
      undefined,
      name,
    );
  }
  if (Object.keys(nodes).length === 0 && Object.keys(marks).length === 0) {
    fail(
      "SHIP_RICH_TEXT_EXTENSION_INVALID",
      `extension ${JSON.stringify(name)} declares no node or mark`,
      undefined,
      name,
    );
  }
  for (const [nodeName, node] of Object.entries(nodes)) {
    if ((RICH_TEXT_BASE_NODE_NAMES as readonly string[]).includes(nodeName)) {
      fail(
        "SHIP_RICH_TEXT_EXTENSION_NODE_RESERVED",
        `node ${JSON.stringify(nodeName)} belongs to the base schema and cannot be redefined`,
        undefined,
        `nodes.${nodeName}`,
      );
    }
    const spec = Reflect.get(node ?? {}, "spec");
    if (
      !NODE_NAME_PATTERN.test(nodeName) ||
      typeof node !== "object" ||
      node === null ||
      typeof Reflect.get(node, "renderHtml") !== "function" ||
      typeof Reflect.get(node, "renderText") !== "function" ||
      !isNodeSpec(spec)
    ) {
      fail(
        "SHIP_RICH_TEXT_EXTENSION_NODE_INVALID",
        `node ${JSON.stringify(nodeName)} must have a camelCase name, a spec { group, content?, atom?, attrs?, marks? } and renderHtml/renderText functions`,
        undefined,
        `nodes.${nodeName}`,
      );
    }
  }
  for (const [markName, mark] of Object.entries(marks)) {
    if ((RICH_TEXT_BASE_MARK_NAMES as readonly string[]).includes(markName)) {
      fail(
        "SHIP_RICH_TEXT_EXTENSION_MARK_RESERVED",
        `mark ${JSON.stringify(markName)} belongs to the base schema and cannot be redefined`,
        undefined,
        `marks.${markName}`,
      );
    }
    const spec = Reflect.get(mark ?? {}, "spec");
    if (
      !NODE_NAME_PATTERN.test(markName) ||
      typeof mark !== "object" ||
      mark === null ||
      typeof Reflect.get(mark, "renderHtml") !== "function" ||
      !isMarkSpec(spec)
    ) {
      fail(
        "SHIP_RICH_TEXT_EXTENSION_MARK_INVALID",
        `mark ${JSON.stringify(markName)} must have a camelCase name, a spec { attrs? } and a renderHtml function`,
        undefined,
        `marks.${markName}`,
      );
    }
  }
}

function isNodeSpec(value: unknown): value is RichTextNodeSpec {
  if (typeof value !== "object" || value === null) return false;
  const group = Reflect.get(value, "group");
  const content = Reflect.get(value, "content");
  const atom = Reflect.get(value, "atom");
  const marks = Reflect.get(value, "marks");
  return (
    (group === "block" || group === "inline") &&
    (content === undefined ||
      (typeof content === "string" && CONTENT_EXPRESSION_PATTERN.test(content))) &&
    (atom === undefined || typeof atom === "boolean") &&
    (marks === undefined || marks === "all" || marks === "none") &&
    isAttrSpecs(Reflect.get(value, "attrs"))
  );
}

function isMarkSpec(value: unknown): value is RichTextMarkSpec {
  return typeof value === "object" && value !== null && isAttrSpecs(Reflect.get(value, "attrs"));
}

function isAttrSpecs(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([name, spec]) => {
    if (!ATTR_NAME_PATTERN.test(name) || typeof spec !== "object" || spec === null) return false;
    const type = Reflect.get(spec, "type");
    const required = Reflect.get(spec, "required");
    const nullable = Reflect.get(spec, "nullable");
    const fallback = Reflect.get(spec, "default");
    const allowed = Reflect.get(spec, "enum");
    const maxLength = Reflect.get(spec, "maxLength");
    return (
      (type === "string" || type === "integer" || type === "boolean") &&
      (required === undefined || typeof required === "boolean") &&
      (nullable === undefined || typeof nullable === "boolean") &&
      (fallback === undefined ||
        fallback === null ||
        ["string", "number", "boolean"].includes(typeof fallback)) &&
      (allowed === undefined ||
        (Array.isArray(allowed) &&
          allowed.every((item) => typeof item === "string" || typeof item === "number"))) &&
      (maxLength === undefined || (Number.isSafeInteger(maxLength) && (maxLength as number) > 0))
    );
  });
}

function freezeNodeSpec(spec: RichTextNodeSpec): RichTextNodeSpec {
  return Object.freeze({
    group: spec.group,
    ...(spec.content !== undefined ? { content: spec.content } : {}),
    ...(spec.atom !== undefined ? { atom: spec.atom } : {}),
    ...(spec.marks !== undefined ? { marks: spec.marks } : {}),
    ...(spec.attrs !== undefined ? { attrs: freezeAttrSpecs(spec.attrs) } : {}),
  });
}

function freezeMarkSpec(spec: RichTextMarkSpec): RichTextMarkSpec {
  return Object.freeze({
    ...(spec.attrs !== undefined ? { attrs: freezeAttrSpecs(spec.attrs) } : {}),
  });
}

function freezeAttrSpecs(attrs: RichTextAttrSpecs): RichTextAttrSpecs {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(attrs).map(([name, spec]) => [
        name,
        Object.freeze({ ...spec, ...(spec.enum ? { enum: Object.freeze([...spec.enum]) } : {}) }),
      ]),
    ),
  );
}

function fail(
  code: RichTextDefinitionDiagnosticCode,
  message: string,
  fieldId?: string,
  field?: string,
): never {
  throw new InvalidRichTextDefinitionError(code, message, { fieldId, field });
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface RichTextExtensionGraphNode {
  readonly name: string;
  readonly nodes: Readonly<Record<string, RichTextNodeSpec>>;
  readonly marks: Readonly<Record<string, RichTextMarkSpec>>;
}

export interface RichTextGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly schemaVersion: number;
  /** The managed attachment embedded objects belong to, when declared. */
  readonly attachmentId?: string;
  /** Declared widenings with their structural specs; renderers are never projected. */
  readonly extensions: readonly RichTextExtensionGraphNode[];
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly onInvalid: RichTextInvalidPolicy;
  /** The provider id that binds the capability, when one is mounted. */
  readonly providerId?: string;
  /** Operations that bind this field. */
  readonly operations: readonly string[];
}

export function collectRichTextOwners(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: ApplicationDiagnostic[],
): ReadonlyMap<string, { readonly module: AnyModule; readonly field: AnyRichText }> {
  const owners = new Map<string, { module: AnyModule; field: AnyRichText }>();
  for (const module of [...modules].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const field of [...(module.richText ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const previous = owners.get(field.id);
      if (previous) {
        diagnostics.push({
          code: "SHIP_RICH_TEXT_ID_DUPLICATE",
          severity: "error",
          message: `rich text id ${JSON.stringify(field.id)} is declared by both ${JSON.stringify(previous.module.id)} and ${JSON.stringify(module.id)}`,
          hint: "Declare each rich text field in exactly one module and import that module where it is used.",
          appId,
          moduleId: module.id,
          providerId: field.binding.id,
          path: "richText",
        });
        continue;
      }
      owners.set(field.id, { module, field });
      if (!field.id.startsWith(`${module.id}.`)) {
        diagnostics.push({
          code: "SHIP_RICH_TEXT_MODULE_ID_MISMATCH",
          severity: "error",
          message: `rich text field ${JSON.stringify(field.id)} is not namespaced by module ${JSON.stringify(module.id)}`,
          hint: `Rename the field so its id starts with ${JSON.stringify(`${module.id}.`)}.`,
          appId,
          moduleId: module.id,
          providerId: field.binding.id,
          path: "richText",
        });
      }
      if (field.attachment && !module.attachments.includes(field.attachment)) {
        diagnostics.push({
          code: "SHIP_RICH_TEXT_ATTACHMENT_UNDECLARED",
          severity: "error",
          message: `rich text field ${JSON.stringify(field.id)} embeds attachment ${JSON.stringify(field.attachment.id)} that module ${JSON.stringify(module.id)} does not declare`,
          hint: "List the attachment in the same module's attachments so embedded objects and the field share one owner.",
          appId,
          moduleId: module.id,
          providerId: field.binding.id,
          path: "richText",
        });
      }
    }
  }
  const bound = new Set<string>();
  for (const module of modules) {
    for (const provider of module.providers) {
      if (isRichTextDependencyToken(provider.token)) bound.add(provider.token.fieldId);
    }
  }
  for (const [id, owner] of [...owners].sort(([left], [right]) => left.localeCompare(right))) {
    if (bound.has(id)) continue;
    diagnostics.push({
      code: "SHIP_RICH_TEXT_PROVIDER_MISSING",
      severity: "error",
      message: `rich text field ${JSON.stringify(id)} is declared but no module binds its capability; nothing can validate or render it`,
      hint: "Add richTextProvider(field) from @sixthsummit/ship-rich-text to the owning module's providers.",
      appId,
      moduleId: owner.module.id,
      providerId: owner.field.binding.id,
      path: "richText",
    });
  }
  return owners;
}

export function checkOperationRichText(
  appId: string,
  module: AnyModule,
  operation: AnyOperation,
  owners: ReadonlyMap<string, { readonly module: AnyModule; readonly field: AnyRichText }>,
  diagnostics: ApplicationDiagnostic[],
): void {
  const context = { appId, moduleId: module.id, operationId: operation.id };
  const bound = Object.entries(operation.dependencies)
    .flatMap(([name, token]) =>
      isRichTextDependencyToken(token) ? [{ name, fieldId: token.fieldId, token }] : [],
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const binding of bound) {
    const owner = owners.get(binding.fieldId);
    if (!owner || owner.field.binding !== binding.token) {
      diagnostics.push({
        code: "SHIP_RICH_TEXT_UNDECLARED",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} binds rich text field ${JSON.stringify(binding.fieldId)} that no module declares`,
        hint: "Add the defineRichText() instance to the owning module's richText list.",
        ...context,
        providerId: binding.token.id,
        path: `dependencies.${binding.name}`,
      });
      continue;
    }
    if (owner.module.id !== module.id && !module.imports.includes(owner.module.id)) {
      diagnostics.push({
        code: "SHIP_RICH_TEXT_IMPORT_REQUIRED",
        severity: "error",
        message: `operation ${JSON.stringify(operation.id)} binds rich text field ${JSON.stringify(binding.fieldId)} from module ${JSON.stringify(owner.module.id)} without importing it`,
        hint: `Add ${JSON.stringify(owner.module.id)} to ${JSON.stringify(module.id)} imports.`,
        ...context,
        providerId: binding.token.id,
        path: `dependencies.${binding.name}`,
      });
    }
  }
}

export function projectRichText(modules: readonly AnyModule[]): readonly RichTextGraphNode[] {
  const users = new Map<string, string[]>();
  const providers = new Map<string, string>();
  for (const module of modules) {
    for (const operation of module.operations) {
      for (const token of Object.values(operation.dependencies)) {
        if (!isRichTextDependencyToken(token)) continue;
        const list = users.get(token.fieldId) ?? [];
        list.push(operation.id);
        users.set(token.fieldId, list);
      }
    }
    for (const provider of module.providers) {
      if (isRichTextDependencyToken(provider.token)) {
        providers.set(provider.token.fieldId, provider.token.id);
      }
    }
  }
  const nodes: RichTextGraphNode[] = [];
  for (const module of modules) {
    for (const field of module.richText ?? []) {
      const providerId = providers.get(field.id);
      nodes.push(
        Object.freeze({
          id: field.id,
          moduleId: module.id,
          schemaVersion: field.schemaVersion,
          ...(field.attachment ? { attachmentId: field.attachment.id } : {}),
          extensions: projectRichTextExtensions(field.extensions),
          maxBytes: field.maxBytes,
          maxDepth: field.maxDepth,
          onInvalid: field.onInvalid,
          ...(providerId ? { providerId } : {}),
          operations: Object.freeze([...new Set(users.get(field.id) ?? [])].sort()),
        }),
      );
    }
  }
  return Object.freeze(nodes.sort((left, right) => left.id.localeCompare(right.id)));
}

/** The structural specs only: renderers and validators never leave the server. */
export function projectRichTextExtensions(
  extensions: readonly RichTextExtension[],
): readonly RichTextExtensionGraphNode[] {
  return Object.freeze(
    [...extensions]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((extension) =>
        Object.freeze({
          name: extension.name,
          nodes: Object.freeze(
            Object.fromEntries(
              Object.entries(extension.nodes)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, node]) => [name, node.spec]),
            ),
          ),
          marks: Object.freeze(
            Object.fromEntries(
              Object.entries(extension.marks)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, mark]) => [name, mark.spec]),
            ),
          ),
        }),
      ),
  );
}

/** Operation ids keyed by the rich text fields they bind; used by the graph projection of operations. */
export function richTextBindingsOf(operation: AnyOperation): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        Object.values(operation.dependencies).flatMap((token) =>
          isRichTextDependencyToken(token) ? [token.fieldId] : [],
        ),
      ),
    ].sort(),
  );
}
