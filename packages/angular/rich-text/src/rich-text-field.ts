import { RICH_TEXT_SCHEMA_VERSION } from './rich-text-document';

export interface RichTextAttrSpec {
  readonly type: 'string' | 'integer' | 'boolean';
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly default?: string | number | boolean | null;
  readonly enum?: readonly (string | number)[];
  readonly maxLength?: number;
}

export interface RichTextNodeSpec {
  readonly group: 'block' | 'inline';
  readonly content?: string;
  readonly atom?: boolean;
  readonly attrs?: Readonly<Record<string, RichTextAttrSpec>>;
  readonly marks?: 'all' | 'none';
}

export interface RichTextMarkSpec {
  readonly attrs?: Readonly<Record<string, RichTextAttrSpec>>;
}

export interface RichTextExtensionSpec {
  readonly name: string;
  readonly nodes: Readonly<Record<string, RichTextNodeSpec>>;
  readonly marks: Readonly<Record<string, RichTextMarkSpec>>;
}

/** The client-side slice of a declared rich text field: what the manifest projects. */
export interface RichTextFieldPolicy {
  readonly id: string;
  readonly schemaVersion: number;
  /** The managed attachment embedded images are uploaded to; absent for text-only fields. */
  readonly attachment?: string;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly extensions: readonly RichTextExtensionSpec[];
}

/** The manifest shape `projectClientContract` emits for rich text; structural so no server import is needed. */
export interface RichTextManifest {
  readonly richText?: Readonly<
    Record<
      string,
      {
        readonly schemaVersion: number;
        readonly attachment?: string;
        readonly maxBytes: number;
        readonly maxDepth: number;
        readonly extensions: readonly RichTextExtensionSpec[];
      }
    >
  >;
}

export class RichTextPolicyError extends Error {
  readonly kind = 'rich-text-policy' as const;
  readonly fieldId: string;
  readonly reason: 'undeclared' | 'schema-version';

  constructor(fieldId: string, reason: RichTextPolicyError['reason'], detail?: string) {
    super(
      reason === 'undeclared'
        ? `The client manifest declares no rich text field ${JSON.stringify(fieldId)}`
        : `Rich text field ${JSON.stringify(fieldId)} uses schema version ${detail}; this editor builds version ${RICH_TEXT_SCHEMA_VERSION}`
    );
    this.name = 'RichTextPolicyError';
    this.fieldId = fieldId;
    this.reason = reason;
  }
}

/**
 * Reads one field's policy from the client manifest, so the editor's schema
 * never drifts from the one the server validates against. A manifest whose
 * schema version this entrypoint does not implement is refused up front
 * rather than producing documents the server would reject.
 */
export function richTextFieldFromManifest(
  manifest: RichTextManifest,
  fieldId: string
): RichTextFieldPolicy {
  const declared = manifest.richText?.[fieldId];
  if (declared === undefined) throw new RichTextPolicyError(fieldId, 'undeclared');
  if (declared.schemaVersion !== RICH_TEXT_SCHEMA_VERSION) {
    throw new RichTextPolicyError(fieldId, 'schema-version', String(declared.schemaVersion));
  }
  return {
    id: fieldId,
    schemaVersion: declared.schemaVersion,
    ...(declared.attachment === undefined ? {} : { attachment: declared.attachment }),
    maxBytes: declared.maxBytes,
    maxDepth: declared.maxDepth,
    extensions: declared.extensions.map(extension => ({
      name: extension.name,
      nodes: { ...extension.nodes },
      marks: { ...extension.marks },
    })),
  };
}
