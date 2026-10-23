/**
 * `@sixthsummit/ship-rich-text`: the engine behind the kernel's `defineRichText`
 * declaration. The document model and the allowlist are kernel-owned and
 * versioned; this package validates, sanitizes, renders and migrates
 * documents and binds a field to its managed attachment so embedded objects
 * live exactly as long as the owning record.
 *
 * Everything is a hand-written walker over the ProseMirror JSON tree: no
 * DOM, no native dependency, Node and edge alike.
 */
export type {
  AnyRichText,
  RichText,
  RichTextAttrSpec,
  RichTextAttrSpecs,
  RichTextAttrs,
  RichTextCapability,
  RichTextDefinition,
  RichTextDocument,
  RichTextExtension,
  RichTextExtensionDefinition,
  RichTextHtmlContext,
  RichTextIssue,
  RichTextIssueCode,
  RichTextMark,
  RichTextMarkExtension,
  RichTextMarkSpec,
  RichTextMigration,
  RichTextNode,
  RichTextNodeExtension,
  RichTextNodeSpec,
  RichTextSanitization,
  RichTextSaved,
  RichTextTextContext,
  RichTextValidation,
  ScopedRichTextCapability,
} from "@sixthsummit/ship-core";
export {
  DEFAULT_RICH_TEXT_MAX_BYTES,
  DEFAULT_RICH_TEXT_MAX_DEPTH,
  defineRichText,
  defineRichTextExtension,
  RICH_TEXT_BASE_MARK_NAMES,
  RICH_TEXT_BASE_NODE_NAMES,
  RICH_TEXT_SCHEMA_VERSION,
} from "@sixthsummit/ship-core";
export {
  createRichTextCapability,
  type RichTextCapabilityOptions,
  richTextProvider,
} from "./capability.js";
export {
  RICH_TEXT_DOCUMENT_JSON_SCHEMA,
  RICH_TEXT_ISSUE_JSON_SCHEMA,
  richTextDocumentSchema,
  richTextIssuesSchema,
} from "./document-schema.js";
export { RichTextCapabilityError, type RichTextCapabilityErrorCode } from "./errors.js";
export { type MigrateRichTextDocumentOptions, migrateRichTextDocument } from "./migrate.js";
export {
  collectRichTextAttachments,
  type RenderRichTextHtmlOptions,
  type RichTextAttachmentRendering,
  renderRichTextHtml,
  renderRichTextText,
} from "./render.js";
export {
  type CompiledMark,
  type CompiledNode,
  type CompiledRichTextSchema,
  type CompileRichTextSchemaOptions,
  type ContentItem,
  compileRichTextSchema,
  escapeAttribute,
  escapeHtml,
  isAllowedLink,
  RICH_TEXT_LINK_SCHEMES,
  RICH_TEXT_MAX_LINK_LENGTH,
} from "./schema.js";
export {
  emptyDocument,
  type RichTextValidationOptions,
  richTextByteLength,
  sanitizeRichTextDocument,
  validateRichTextDocument,
} from "./validate.js";
