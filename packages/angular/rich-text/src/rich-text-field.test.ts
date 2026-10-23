import { describe, expect, it } from 'vitest';
import { emptyRichTextDocument, isRichTextDocument } from './rich-text-document';
import { RichTextPolicyError, richTextFieldFromManifest } from './rich-text-field';

const manifest = {
  richText: {
    'documents.body': {
      schemaVersion: 1,
      attachment: 'documents.image',
      maxBytes: 262144,
      maxDepth: 32,
      extensions: [
        {
          name: 'merge-field',
          nodes: {
            mergeField: {
              group: 'inline' as const,
              atom: true,
              attrs: { key: { type: 'string' as const, required: true } },
            },
          },
          marks: {},
        },
      ],
    },
    'templates.body': {
      schemaVersion: 1,
      maxBytes: 1024,
      maxDepth: 8,
      extensions: [],
    },
    'legacy.body': { schemaVersion: 2, maxBytes: 1024, maxDepth: 8, extensions: [] },
  },
};

describe('richTextFieldFromManifest', () => {
  it('reads the field policy, attachment and extension specs from the manifest', () => {
    expect(richTextFieldFromManifest(manifest, 'documents.body')).toEqual({
      id: 'documents.body',
      schemaVersion: 1,
      attachment: 'documents.image',
      maxBytes: 262144,
      maxDepth: 32,
      extensions: [
        {
          name: 'merge-field',
          nodes: {
            mergeField: {
              group: 'inline',
              atom: true,
              attrs: { key: { type: 'string', required: true } },
            },
          },
          marks: {},
        },
      ],
    });
    const textOnly = richTextFieldFromManifest(manifest, 'templates.body');
    expect(textOnly.attachment).toBeUndefined();
    expect('attachment' in textOnly).toBe(false);
  });

  it('refuses undeclared fields and schema versions this editor does not build', () => {
    expect(() => richTextFieldFromManifest(manifest, 'missing.body')).toThrow(
      expect.objectContaining({
        kind: 'rich-text-policy',
        reason: 'undeclared',
      }) as RichTextPolicyError
    );
    expect(() => richTextFieldFromManifest({}, 'documents.body')).toThrow(RichTextPolicyError);
    expect(() => richTextFieldFromManifest(manifest, 'legacy.body')).toThrow(
      expect.objectContaining({ reason: 'schema-version' }) as RichTextPolicyError
    );
  });

  it('recognizes documents and builds the empty one', () => {
    expect(emptyRichTextDocument()).toEqual({
      schemaVersion: 1,
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    expect(isRichTextDocument(emptyRichTextDocument(1))).toBe(true);
    expect(isRichTextDocument({ type: 'doc', content: [] })).toBe(false);
    expect(isRichTextDocument('<p>')).toBe(false);
  });
});
