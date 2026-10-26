# Rich text fields

Declared rich content fields: a versioned, kernel-owned document allowlist,
server-side HTML rendering through one renderer, a plain-text projection for
search and previews, named extensions a consumer declares to widen the
schema, embedded images that are managed storage objects purged with the
owning record, and an Angular editor that emits the document model, never
HTML. Decision record: [ADR-0026](../../rearchitecture/decisions/0026-declared-rich-text-fields.md).

| Package | Owns |
| --- | --- |
| `@sixthsummit/ship-core` | `defineRichText`, `defineRichTextExtension`, the document model and base allowlist names, `RICH_TEXT_SCHEMA_VERSION`, the `RichTextCapability` / `ScopedRichTextCapability` contracts, compile diagnostics, graph projection |
| `@sixthsummit/ship-rich-text` | `richTextProvider` (validate, sanitize, render, text, save, clear, migrate), `richTextDocumentSchema` / `richTextIssuesSchema` for operation inputs and error details, the pure engine (`validateRichTextDocument`, `sanitizeRichTextDocument`, `renderRichTextHtml`, `renderRichTextText`, `migrateRichTextDocument`) |
| `@sixthsummit/ship-contract` | projects `contract.richText` (schema version, attachment id, limits, extension specs) and `richText` ids on operations |
| `@sixthsummit/ship-angular/rich-text` | `ShipRichTextEditorComponent`, `richTextFieldFromManifest`, `createRichTextExtensions`, `createRichTextAttachmentUploader` |

## The document model

A field is stored as the ProseMirror JSON document a TipTap editor emits from
`getJSON()`, plus the schema version it was validated against:

```json
{
  "schemaVersion": 1,
  "type": "doc",
  "content": [
    { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Engagement" }] },
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Dear " },
        { "type": "mergeField", "attrs": { "key": "client.name" } },
        { "type": "text", "text": "see the terms", "marks": [{ "type": "link", "attrs": { "href": "https://law.example/terms" } }] }
      ]
    },
    { "type": "attachment", "attrs": { "objectId": "7b1c…", "alt": "Site plan" } }
  ]
}
```

Never HTML. The schema is the allowlist: a node, mark or attribute outside it
cannot exist in a stored document, and the server validates every incoming
document against it regardless of what the editor did.

### Base schema, version 1

| Nodes | Content | Attributes |
| --- | --- | --- |
| `paragraph` | `inline*` | |
| `heading` | `inline*` | `level`: 2 or 3 |
| `bulletList`, `orderedList` | `listItem+` | ordered: `start` (integer, default 1), `type` (`1 a A i I`, default null) |
| `listItem` | `paragraph block*` | |
| `blockquote` | `block+` | |
| `codeBlock` | `text*`, no marks | `language` (identifier, default null) |
| `hardBreak` | leaf, inline | |
| `attachment` | block atom; present only when the field declares an attachment | `objectId` (managed object id), `alt` |
| `text` | | |

| Marks | Attributes |
| --- | --- |
| `bold`, `italic`, `code` | |
| `link` | `href` (absolute `https:` or `mailto:` URL, at most 2048 characters), `title` |

Links render as `<a href rel="noopener noreferrer">` by default; the field's
`links: { rel, target }` changes that. Headings start at `h2` so a document
never competes with the page title; tables, images by URL, underline,
strikethrough, text colour and alignment are deliberately absent.

Every stored document carries `schemaVersion`. The kernel exports
`RICH_TEXT_SCHEMA_VERSION`; a bump is a release step that ships a migration
(below), never a silent change in what an existing document renders to.

## 1. Declare the field

```ts
// src/documents/field.ts
import { defineAttachment, defineRichText, defineRichTextExtension } from "@sixthsummit/ship-core";

export const documentImage = defineAttachment({
  id: "documents.image",
  cardinality: "many",
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5_000_000,
  visibility: "private",
  maxCount: 50,
});

export const mergeField = defineRichTextExtension({
  name: "merge-field",
  nodes: {
    mergeField: {
      spec: { group: "inline", atom: true, attrs: { key: { type: "string", required: true, maxLength: 64 } } },
      validate: (attrs) => (/^[a-z][\w.]*$/u.test(String(attrs.key)) ? undefined : "key must be an identifier"),
      renderHtml: (node, { attribute }) => `<span data-key="${attribute(node.attrs?.key)}">{{${attribute(node.attrs?.key)}}}</span>`,
      renderText: (node) => `{{${String(node.attrs?.key ?? "")}}}`,
    },
  },
});

export const documentBody = defineRichText({
  id: "documents.body",          // <moduleId>.<field>
  attachment: documentImage,     // embedded images are objects of this attachment
  extensions: [mergeField],      // named, reviewable widenings of the base schema
  maxBytes: 256 * 1024,          // canonical JSON size; default 256 KiB
  maxDepth: 32,                  // default
  links: { rel: "noopener noreferrer" },
  onInvalid: "reject",           // or "sanitize": drop what is not allowed and report it
});
```

- An **extension** adds named nodes and marks next to the base ones; it can
  never redefine a base name (`SHIP_RICH_TEXT_EXTENSION_NODE_RESERVED`).
  Each node carries its structural `spec` (group, content expression, atom,
  attributes with type / required / nullable / default / enum / maxLength,
  marks `all` or `none`), which is what the contract projects so the editor
  builds the same schema, and its server-only `renderHtml` / `renderText`
  (plus an optional `validate`). Everything an extension emits from
  `node.attrs` must go through `context.escape` / `context.attribute`.
- `attachment` is optional. A text-only field (a message template) has no
  `attachment` node at all; an `attachment` node in such a document is an
  unknown node.
- Declare the field on its module and list its attachment on the same
  module: `defineModule({ id: "documents", …, attachments: [documentImage],
  richText: [documentBody], providers: [richTextProvider(documentBody)] })`.

Definition-time diagnostics (`InvalidRichTextDefinitionError`): an id without
a module prefix, a non-attachment `attachment`, duplicate or malformed
extensions, non-positive `maxBytes`, `maxDepth` outside `2..1024`, a `links`
value that is not `{ rel?, target?: "_blank" | "_self" }`, an unknown
`onInvalid`, and migrations that do not step one version at a time.

Compile diagnostics (`defineApp`):

| Code | Meaning |
| --- | --- |
| `SHIP_RICH_TEXT_ID_DUPLICATE` / `SHIP_RICH_TEXT_MODULE_ID_MISMATCH` | Two owners, or an id not prefixed by its module. |
| `SHIP_RICH_TEXT_ATTACHMENT_UNDECLARED` | The field embeds an attachment its own module does not declare. |
| `SHIP_RICH_TEXT_PROVIDER_MISSING` | No module provides the field's binding; add `richTextProvider(field)`. |
| `SHIP_RICH_TEXT_UNDECLARED` / `SHIP_RICH_TEXT_IMPORT_REQUIRED` | An operation binds a field no module declares, or from a module it does not import. |
| `SHIP_RICH_TEXT_PROVIDER_LIFETIME_INVALID` | The capability provider is not a singleton. |
| `SHIP_PROVIDER_MISSING` / `SHIP_MODULE_IMPORT_REQUIRED` on `dependencies.<name>.attachment` | The field's attachment capability (the storage module) is not reachable from the binding operation. |

## 2. Use the field from operations

An operation binds `field.binding`; the executor hands the handler a
`ScopedRichTextCapability` bound to the running transaction and to the
field's attachment capability in the same scope.

```ts
import { objectSchema, stringSchema } from "@sixthsummit/ship-core";
import { RichTextCapabilityError, richTextDocumentSchema, richTextIssuesSchema } from "@sixthsummit/ship-rich-text";

const documentInvalid = operationError({ code: "DOCUMENT_INVALID", status: 422, message: "…", details: richTextIssuesSchema() });

const save = defineOperation({
  id: "documents.save",
  transport: http.put("/tenants/:tenantId/documents/:documentId"),
  // The body is validated against the field's full allowlist at the input boundary.
  input: { params, body: objectSchema({ title: stringSchema({ minLength: 1 }), document: richTextDocumentSchema(documentBody) }) },
  output: { 200: savedSchema },
  successStatus: 200,
  errors: [tenantAccessDenied, documentInvalid],
  access: permission("documents:write"),
  transaction: "write",
  dependencies: { tx: documentsUnitOfWork, body: documentBody.binding },
  handler: async ({ input, services, context }) => {
    const scope = await authorizeTenant(input.params.tenantId, context);
    const ownerId = `${scope.tenantId}/document/${input.params.documentId}`;
    try {
      const saved = await services.body.save({ ownerId, document: input.body.document });
      await services.tx.documents.forTenant(scope).upsert({ id: input.params.documentId, title: input.body.title, body: saved.document, bodyText: saved.text });
      return { attached: saved.attached, detached: saved.detached };
    } catch (error) {
      if (error instanceof RichTextCapabilityError && error.code === "SHIP_RICH_TEXT_INVALID") {
        throw operationFailure(documentInvalid, { details: { issues: error.issues } });
      }
      throw error;
    }
  },
});
```

The scoped capability:

| Method | Transaction | Meaning |
| --- | --- | --- |
| `validate(input)` | any | Strict validation; `{ ok: true, document }` (canonical, frozen) or `{ ok: false, issues }` with a JSON path per issue. Never changes the input. |
| `sanitize(input)` | any | Drops everything the schema forbids and reports each drop. Always a valid document. |
| `text(document)` | any | The plain-text projection: block boundaries become newlines, embedded objects contribute their alt text, extension nodes what `renderText` returns. Store it next to the document for search and previews. |
| `attachments(document)` | any | Object ids of every embedded attachment. |
| `render(document, { expiresInMs? })` | any | HTML. Text and attributes escaped, link hrefs re-checked, embedded objects rendered from short-lived signed URLs resolved **now** (never stored). An unavailable object renders `<figure class="ship-attachment ship-attachment--unavailable">`. |
| `save({ ownerId, document })` | `write` when embeds change | Validates (or sanitizes per `onInvalid`), checks every newly referenced object is an unattached upload of the field's attachment, attaches it, detaches the objects the previous document referenced and this one no longer does (recording their purge intents), and returns `{ document, text, attachmentIds, attached, detached }`. |
| `clear({ ownerId })` | `write` | Detaches every embedded object of the owner; call it when the owning record is deleted. |
| `migrate(document)` | any | Applies the field's declared migrations up to the current schema version. |

`save` and `clear` outside a write transaction throw
`SHIP_RICH_TEXT_SCOPE_REQUIRED` when they would change embedded objects; a
document that references an object that is unknown, purged or attached to
another owner is refused with `SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE` (or the
node is dropped under `onInvalid: "sanitize"`). What no sanitizer can repair
(not a document, wrong schema version, over `maxBytes`) is always refused.

Fold the authentic tenant into `ownerId` exactly as for attachments: the
capability never authorizes.

### Issue codes

`SHIP_RICH_TEXT_DOCUMENT_INVALID`, `SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED`,
`SHIP_RICH_TEXT_TOO_LARGE`, `SHIP_RICH_TEXT_TOO_DEEP`, `SHIP_RICH_TEXT_NODE_UNKNOWN`,
`SHIP_RICH_TEXT_MARK_UNKNOWN`, `SHIP_RICH_TEXT_MARK_FORBIDDEN`,
`SHIP_RICH_TEXT_CONTENT_INVALID`, `SHIP_RICH_TEXT_ATTR_INVALID`,
`SHIP_RICH_TEXT_TEXT_INVALID` (empty text, U+0000 or a lone surrogate, which
PostgreSQL `jsonb` and JSON refuse), `SHIP_RICH_TEXT_LINK_INVALID`,
`SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE`.

## 3. Store it

The application owns the table: a `jsonb` column for the document and a
`text` column for the projection. Generate the migration with `drizzle-kit
generate` and apply it as a gated release step. Nothing in the framework adds
a table for rich text; embedded images are rows of `ship_storage_objects`
owned by the field's `ownerId`.

## 4. Render it

`services.body.render(row.body)` returns the HTML for a response. Rendering
is a hand-written walker over the JSON tree with no DOM and no native
dependency, so it runs in Node and at the edge. Adjacent text runs with the
same marks merge; marks nest deterministically with `link` outermost. The
XSS corpus in `packages/rich-text/src/render.test.ts` places forty payloads in
every position a document can carry bytes (text, link href and title, code
language, attachment alt and object id, list attributes, extension
attributes, node and mark types) and asserts the output never contains an
executable form of any of them.

## 5. Migrate on a schema bump

```ts
export const documentBody = defineRichText({
  id: "documents.body",
  migrations: [{ from: 1, to: 2, migrate: (document) => ({ ...document, content: rewrite(document.content) }) }],
});
```

`validate`, `render` and `save` refuse a document whose `schemaVersion` is
not the current one (`SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED`). After a
bump, a release step reads every row, calls `services.body.migrate(document)`
(or the pure `migrateRichTextDocument`) and writes the result back. Nothing
migrates at render time.

## 6. Contract and the Angular editor

The client manifest carries what an editor needs to agree with the server and
nothing that renders:

```json
"richText": {
  "documents.body": {
    "schemaVersion": 1,
    "attachment": "documents.image",
    "maxBytes": 262144,
    "maxDepth": 32,
    "extensions": [
      { "name": "merge-field", "nodes": { "mergeField": { "group": "inline", "atom": true, "attrs": { "key": { "type": "string", "required": true, "maxLength": 64 } } } }, "marks": {} }
    ]
  }
}
```

Angular: `@sixthsummit/ship-angular/rich-text` (peer dependencies
`@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`).

```ts
import { createRichTextAttachmentUploader, richTextFieldFromManifest, ShipRichTextEditorComponent } from "@sixthsummit/ship-angular/rich-text";
import { attachmentPolicyFromManifest } from "@sixthsummit/ship-angular/storage";

const field = richTextFieldFromManifest(manifest, "documents.body");
const uploadAttachment = createRichTextAttachmentUploader(
  client,
  { attachment: field.attachment!, policy: attachmentPolicyFromManifest(manifest, field.attachment!) },
  { allowedProviderOrigins: ["https://storage.googleapis.com"] },
);
```

```html
<ship-rich-text-editor
  [field]="field"
  [uploadAttachment]="uploadAttachment"
  [resolveAttachment]="resolvePreview"
  formControlName="document"
/>
```

- The component is a `ControlValueAccessor`: its value is the document
  model with `schemaVersion` set from the manifest. It never emits HTML.
- Its schema is built from the manifest policy: the base version 1 set plus
  every declared extension node and mark (rendered in the editor as a generic
  element carrying its attributes as `data-*`; `nodeLabels` names atoms).
  `richTextFieldFromManifest` refuses a manifest whose schema version this
  entrypoint does not build.
- Paste runs through the same schema (ProseMirror parses the clipboard with
  it, so `<script>`, `<table>`, `<u>`, `onerror=` and `javascript:` links
  never enter the document); a defensive pre-pass strips script, style and
  event-handler markup first. The server validates again regardless.
- Dropped or pasted images go through `uploadAttachment` (one managed
  attachment upload each: validation against the declared policy, signed
  intent, PUT with progress, completion) and an `attachment` node with the
  settled object id is inserted. The object is attached to the record when
  the document is saved; an upload the user abandons is swept like any other.
- `resolveAttachment(objectId)` supplies preview URLs for embedded objects
  (through the application's own read operation); the stored document holds
  ids only.
- `tiptap` exposes the underlying editor for toolbars; `insertAttachment`
  inserts an already uploaded object.
