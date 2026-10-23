/** @packageDocumentation Rich text editor bound to ShipAPI's declared `richText` fields: emits the document model, never HTML. */

export {
  emptyRichTextDocument,
  isRichTextDocument,
  RICH_TEXT_BASE_MARK_ATTRS,
  RICH_TEXT_BASE_NODE_ATTRS,
  RICH_TEXT_SCHEMA_VERSION,
  type RichTextAttrValue,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from './rich-text-document';
export {
  type RichTextAttachmentUploader,
  ShipRichTextEditorComponent,
} from './rich-text-editor.component';
export {
  type CreateRichTextExtensionsOptions,
  createRichTextExtensions,
  normalizeRichTextDocument,
  type RichTextAttachmentPreview,
  type RichTextNodeLabel,
} from './rich-text-extensions';
export {
  type RichTextAttrSpec,
  type RichTextExtensionSpec,
  type RichTextFieldPolicy,
  type RichTextManifest,
  type RichTextMarkSpec,
  type RichTextNodeSpec,
  RichTextPolicyError,
  richTextFieldFromManifest,
} from './rich-text-field';
export { createRichTextAttachmentUploader } from './rich-text-uploader';
