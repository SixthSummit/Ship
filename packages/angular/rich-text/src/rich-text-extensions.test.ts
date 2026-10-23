import { Editor } from '@tiptap/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRichTextExtensions, normalizeRichTextDocument } from './rich-text-extensions';
import type { RichTextFieldPolicy } from './rich-text-field';
import { installProseMirrorDomShims } from './test-dom-shims';

const policy: RichTextFieldPolicy = {
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
        callout: {
          group: 'block',
          content: 'paragraph+',
          attrs: { tone: { type: 'string', default: 'info' } },
        },
      },
      marks: { highlight: { attrs: { color: { type: 'string', default: 'yellow' } } } },
    },
  ],
};

const textOnly: RichTextFieldPolicy = {
  id: 'templates.body',
  schemaVersion: 1,
  maxBytes: 1024,
  maxDepth: 8,
  extensions: [],
};

describe('createRichTextExtensions', () => {
  let editor: Editor | undefined;
  beforeAll(() => installProseMirrorDomShims());
  afterEach(() => {
    editor?.destroy();
    editor = undefined;
  });

  function open(field: RichTextFieldPolicy, content: string) {
    editor = new Editor({
      element: document.body.appendChild(document.createElement('div')),
      extensions: createRichTextExtensions(field, {
        nodeLabels: { mergeField: attrs => `{{${String(attrs['key'])}}}` },
      }),
      content,
    });
    return editor;
  }

  it('builds exactly the base schema plus the declared extensions', () => {
    const { schema } = open(policy, '<p></p>');
    expect(Object.keys(schema.nodes).sort()).toEqual([
      'attachment',
      'blockquote',
      'bulletList',
      'callout',
      'codeBlock',
      'doc',
      'hardBreak',
      'heading',
      'listItem',
      'mergeField',
      'orderedList',
      'paragraph',
      'text',
    ]);
    expect(Object.keys(schema.marks).sort()).toEqual([
      'bold',
      'code',
      'highlight',
      'italic',
      'link',
    ]);
    expect(schema.nodes['heading']?.spec['attrs']).toBeDefined();
    const bare = new Editor({
      element: document.createElement('div'),
      extensions: createRichTextExtensions(textOnly),
    });
    expect(Object.keys(bare.schema.nodes)).not.toContain('attachment');
    expect(Object.keys(bare.schema.nodes)).not.toContain('mergeField');
    bare.destroy();
  });

  it('drops pasted markup outside the allowlist because the schema is the parser', () => {
    const instance = open(
      policy,
      '<script>alert(1)</script><h1>Big</h1><h2>Ok <u>under</u> <s>gone</s> <b>bold</b></h2>' +
        '<table><tr><td>cell</td></tr></table><p style="color:red" onclick="x()">para <img src=x onerror=alert(1)></p>' +
        '<p><a href="javascript:alert(1)">js</a> <a href="http://insecure.test">http</a> <a href="https://ok.test/a">ok</a></p>' +
        '<hr><figure data-object-id="obj-1" data-alt="pic"><img src="https://cdn.test/x"></figure>' +
        '<span data-ship-node="mergeField" data-key="client.name"></span>'
    );
    const document = normalizeRichTextDocument(policy, instance.getJSON());
    expect(document).toEqual({
      schemaVersion: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Big' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            { type: 'text', text: 'Ok under gone ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'cell' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'para' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'js http ' },
            {
              type: 'text',
              text: 'ok',
              marks: [{ type: 'link', attrs: { href: 'https://ok.test/a' } }],
            },
          ],
        },
        { type: 'attachment', attrs: { objectId: 'obj-1', alt: 'pic' } },
        { type: 'paragraph', content: [{ type: 'mergeField', attrs: { key: 'client.name' } }] },
      ],
    });
    expect(JSON.stringify(document)).not.toMatch(
      /script|onclick|onerror|javascript|insecure|style/u
    );
  });

  it('keeps only the attributes the server stores and round-trips a stored document', () => {
    const stored = {
      schemaVersion: 1,
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'see ',
              marks: [{ type: 'highlight', attrs: { color: 'green' } }],
            },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://ok.test', title: 'T' } }],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }],
            },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x' }] },
        {
          type: 'callout',
          attrs: { tone: 'warn' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }],
        },
      ],
    };
    const instance = open(policy, '<p></p>');
    instance.commands.setContent(stored);
    const raw = instance.getJSON();
    const link = raw.content?.[0]?.content?.[1]?.marks?.[0];
    expect(link?.attrs).toMatchObject({ href: 'https://ok.test', rel: 'noopener noreferrer' });
    expect(normalizeRichTextDocument(policy, raw)).toEqual(stored);
  });

  it('never emits an empty document', () => {
    expect(normalizeRichTextDocument(textOnly, { type: 'doc' })).toEqual({
      schemaVersion: 1,
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });
});
