import { type Extensions, Mark, mergeAttributes, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  RICH_TEXT_BASE_MARK_ATTRS,
  RICH_TEXT_BASE_NODE_ATTRS,
  type RichTextAttrValue,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from './rich-text-document';
import type { RichTextAttrSpec, RichTextFieldPolicy } from './rich-text-field';

/** The schemes the server accepts for links; the editor refuses the rest at paste and autolink time. */
const ALLOWED_LINK = /^(?:https:|mailto:)/u;

/** Produces the label an atomic declared node shows in the editor. */
export type RichTextNodeLabel = (attrs: Readonly<Record<string, RichTextAttrValue>>) => string;

export interface RichTextAttachmentPreview {
  readonly url: string;
  readonly contentType?: string;
}

export interface CreateRichTextExtensionsOptions {
  /** Resolves a preview URL for an embedded object so the editor can show it; absent renders a placeholder. */
  readonly resolveAttachment?: (
    objectId: string
  ) => Promise<RichTextAttachmentPreview | undefined> | RichTextAttachmentPreview | undefined;
  /** Labels for declared atomic nodes, keyed by node name; defaults to `name:firstAttr`. */
  readonly nodeLabels?: Readonly<Record<string, RichTextNodeLabel>>;
}

/**
 * Builds the TipTap extension list for one field from the manifest policy:
 * the kernel's base schema (version 1) and the declared extensions. Because
 * the ProseMirror schema is the allowlist, pasted or dropped content outside
 * it never enters the document; the server validates again regardless.
 */
export function createRichTextExtensions(
  policy: RichTextFieldPolicy,
  options: CreateRichTextExtensionsOptions = {}
): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      strike: false,
      underline: false,
      horizontalRule: false,
      // A stored document round-trips unchanged; no trailing paragraph is appended.
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: ['https', 'mailto'],
        isAllowedUri: url => ALLOWED_LINK.test(url),
        HTMLAttributes: { rel: 'noopener noreferrer', target: null },
      },
      codeBlock: { HTMLAttributes: {} },
    }),
  ];
  if (policy.attachment !== undefined) {
    extensions.push(createAttachmentNode(options.resolveAttachment));
  }
  for (const extension of policy.extensions) {
    for (const [name, spec] of Object.entries(extension.nodes)) {
      extensions.push(
        createDeclaredNode(name, spec, options.nodeLabels?.[name] ?? defaultLabel(name))
      );
    }
    for (const [name, spec] of Object.entries(extension.marks)) {
      extensions.push(createDeclaredMark(name, spec));
    }
  }
  return extensions;
}

function defaultLabel(name: string): RichTextNodeLabel {
  return attrs => {
    const first = Object.values(attrs).find(value => value !== null && value !== undefined);
    return first === undefined ? name : `${name}:${String(first)}`;
  };
}

function attributeDefinitions(attrs: Readonly<Record<string, RichTextAttrSpec>> | undefined) {
  return Object.fromEntries(
    Object.entries(attrs ?? {}).map(([name, spec]) => [
      name,
      {
        default: spec.default ?? (spec.required ? null : null),
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute(`data-${toKebab(name)}`);
          if (raw === null) return spec.default ?? null;
          if (spec.type === 'integer') return Number.parseInt(raw, 10);
          if (spec.type === 'boolean') return raw === 'true';
          return raw;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[name] === null || attributes[name] === undefined
            ? {}
            : { [`data-${toKebab(name)}`]: String(attributes[name]) },
      },
    ])
  );
}

function toKebab(name: string): string {
  return name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`);
}

/** A declared node renders as a generic element carrying its attributes as `data-*`; the server renders the real HTML. */
function createDeclaredNode(
  name: string,
  spec: RichTextFieldPolicy['extensions'][number]['nodes'][string],
  label: RichTextNodeLabel
) {
  const inline = spec.group === 'inline';
  const tag = inline ? 'span' : 'div';
  return Node.create({
    name,
    group: spec.group,
    inline,
    atom: spec.atom ?? false,
    ...(spec.content ? { content: spec.content } : {}),
    ...(spec.marks === 'none' ? { marks: '' } : {}),
    selectable: true,
    addAttributes() {
      return attributeDefinitions(spec.attrs);
    },
    parseHTML() {
      return [{ tag: `${tag}[data-ship-node="${name}"]` }];
    },
    renderHTML({ node, HTMLAttributes }) {
      const attributes = mergeAttributes(HTMLAttributes, {
        'data-ship-node': name,
        class: `ship-rich-text-node ship-rich-text-node--${name}`,
      });
      return spec.content
        ? [tag, attributes, 0]
        : [tag, attributes, label(node.attrs as Record<string, RichTextAttrValue>)];
    },
  });
}

function createDeclaredMark(
  name: string,
  spec: RichTextFieldPolicy['extensions'][number]['marks'][string]
) {
  return Mark.create({
    name,
    addAttributes() {
      return attributeDefinitions(spec.attrs);
    },
    parseHTML() {
      return [{ tag: `span[data-ship-mark="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        'span',
        mergeAttributes(HTMLAttributes, {
          'data-ship-mark': name,
          class: `ship-rich-text-mark ship-rich-text-mark--${name}`,
        }),
        0,
      ];
    },
  });
}

/**
 * The embedded-object node: a block atom carrying the managed object id and
 * an alt text. The editor shows a preview resolved through the application's
 * own read operation; nothing but the id is ever stored.
 */
function createAttachmentNode(resolve: CreateRichTextExtensionsOptions['resolveAttachment']) {
  return Node.create({
    name: 'attachment',
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return {
        objectId: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute('data-object-id'),
          renderHTML: (attributes: Record<string, unknown>) => ({
            'data-object-id': String(attributes['objectId'] ?? ''),
          }),
        },
        alt: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            element.getAttribute('data-alt') ?? element.querySelector('img')?.getAttribute('alt'),
          renderHTML: (attributes: Record<string, unknown>) =>
            attributes['alt'] === null || attributes['alt'] === undefined
              ? {}
              : { 'data-alt': String(attributes['alt']) },
        },
      };
    },
    parseHTML() {
      return [{ tag: 'figure[data-object-id]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['figure', mergeAttributes(HTMLAttributes, { class: 'ship-attachment' })];
    },
    addNodeView() {
      return ({ node }) => {
        const figure = document.createElement('figure');
        figure.className = 'ship-attachment';
        figure.setAttribute('data-object-id', String(node.attrs['objectId'] ?? ''));
        const image = document.createElement('img');
        image.alt = typeof node.attrs['alt'] === 'string' ? node.attrs['alt'] : '';
        image.draggable = false;
        figure.appendChild(image);
        const objectId = String(node.attrs['objectId'] ?? '');
        Promise.resolve(resolve?.(objectId))
          .then(preview => {
            if (preview?.url) {
              image.src = preview.url;
              figure.classList.remove('ship-attachment--unavailable');
            } else {
              figure.classList.add('ship-attachment--unavailable');
            }
          })
          .catch(() => figure.classList.add('ship-attachment--unavailable'));
        return { dom: figure };
      };
    },
  });
}

/**
 * Turns the editor's JSON into the document the server stores: adds the
 * schema version and keeps only the attributes the server's schema declares
 * (TipTap's link mark, for example, also carries `target`, `rel` and `class`,
 * which the base schema does not store).
 */
export function normalizeRichTextDocument(
  policy: RichTextFieldPolicy,
  json: { readonly type?: string; readonly content?: readonly unknown[] }
): RichTextDocument {
  const nodeAttrs = new Map<string, readonly string[]>(Object.entries(RICH_TEXT_BASE_NODE_ATTRS));
  const markAttrs = new Map<string, readonly string[]>(Object.entries(RICH_TEXT_BASE_MARK_ATTRS));
  for (const extension of policy.extensions) {
    for (const [name, spec] of Object.entries(extension.nodes)) {
      nodeAttrs.set(name, Object.keys(spec.attrs ?? {}));
    }
    for (const [name, spec] of Object.entries(extension.marks)) {
      markAttrs.set(name, Object.keys(spec.attrs ?? {}));
    }
  }
  const content = (json.content ?? []).map(node => normalizeNode(node, nodeAttrs, markAttrs));
  return {
    schemaVersion: policy.schemaVersion,
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
}

function normalizeNode(
  raw: unknown,
  nodeAttrs: ReadonlyMap<string, readonly string[]>,
  markAttrs: ReadonlyMap<string, readonly string[]>
): RichTextNode {
  const node = raw as RichTextNode;
  const attrs = pickAttrs(node.attrs, nodeAttrs.get(node.type) ?? []);
  const content = node.content?.map(child => normalizeNode(child, nodeAttrs, markAttrs));
  const marks = node.marks
    ?.map(mark => normalizeMark(mark, markAttrs))
    .filter((mark): mark is RichTextMark => mark !== undefined);
  return {
    type: node.type,
    ...(attrs ? { attrs } : {}),
    ...(content && content.length > 0 ? { content } : {}),
    ...(marks && marks.length > 0 ? { marks } : {}),
    ...(typeof node.text === 'string' ? { text: node.text } : {}),
  };
}

function normalizeMark(
  mark: RichTextMark,
  markAttrs: ReadonlyMap<string, readonly string[]>
): RichTextMark | undefined {
  const attrs = pickAttrs(mark.attrs, markAttrs.get(mark.type) ?? []);
  if (mark.type === 'link' && !ALLOWED_LINK.test(String(attrs?.['href'] ?? ''))) return undefined;
  return { type: mark.type, ...(attrs ? { attrs } : {}) };
}

function pickAttrs(
  attrs: Readonly<Record<string, RichTextAttrValue>> | undefined,
  allowed: readonly string[]
): Readonly<Record<string, RichTextAttrValue>> | undefined {
  if (!attrs) return undefined;
  const picked = Object.fromEntries(
    Object.entries(attrs).filter(
      ([name, value]) => allowed.includes(name) && value !== undefined && value !== null
    )
  );
  return Object.keys(picked).length > 0 ? picked : undefined;
}
