/**
 * The stored shape of a rich text field, structurally identical to
 * `RichTextDocument` in `@sixthsummit/ship-core` so no server import is
 * needed: ProseMirror JSON (what TipTap's `getJSON()` emits) plus the schema
 * version the editor built its schema for.
 */
export type RichTextAttrValue = string | number | boolean | null;

export interface RichTextMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, RichTextAttrValue>>;
}

export interface RichTextNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, RichTextAttrValue>>;
  readonly content?: readonly RichTextNode[];
  readonly marks?: readonly RichTextMark[];
  readonly text?: string;
}

export interface RichTextDocument {
  readonly schemaVersion: number;
  readonly type: 'doc';
  readonly content: readonly RichTextNode[];
}

/** The schema version this entrypoint builds editors for; the manifest must agree. */
export const RICH_TEXT_SCHEMA_VERSION = 1;

/** The attributes the server's base schema (version 1) stores per node and mark. */
export const RICH_TEXT_BASE_NODE_ATTRS: Readonly<Record<string, readonly string[]>> = {
  heading: ['level'],
  orderedList: ['start', 'type'],
  codeBlock: ['language'],
  attachment: ['objectId', 'alt'],
};
export const RICH_TEXT_BASE_MARK_ATTRS: Readonly<Record<string, readonly string[]>> = {
  link: ['href', 'title'],
};

export function emptyRichTextDocument(
  schemaVersion: number = RICH_TEXT_SCHEMA_VERSION
): RichTextDocument {
  return { schemaVersion, type: 'doc', content: [{ type: 'paragraph' }] };
}

export function isRichTextDocument(value: unknown): value is RichTextDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion) &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
