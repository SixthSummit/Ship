# `@sixthsummit/ship-rich-text`

Rich content fields for Ship applications. The declaration (`defineRichText`,
`defineRichTextExtension`), the document model and the versioned base
allowlist are owned by `@sixthsummit/ship-core`; this package owns the engine:
strict validation, sanitization, server-side HTML rendering, the plain-text
projection, the explicit migration hook and the capability that binds a field
to its managed attachment so embedded objects live exactly as long as the
owning record.

Documents are stored as ProseMirror JSON (what a TipTap editor emits) plus a
`schemaVersion`, never as HTML. The server is the trust boundary: every
document goes through the allowlist here, whatever the editor did.

```ts
import { defineAttachment, defineModule, defineOperation, defineRichText } from "@sixthsummit/ship-core";
import { RichTextCapabilityError, richTextDocumentSchema, richTextProvider } from "@sixthsummit/ship-rich-text";

export const documentImage = defineAttachment({
  id: "documents.image",
  cardinality: "many",
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5_000_000,
  visibility: "private",
});

export const documentBody = defineRichText({
  id: "documents.body",
  attachment: documentImage,   // embedded images are objects of this attachment
  extensions: [mergeField],    // named, reviewable widenings of the base schema
  maxBytes: 256 * 1024,
});

const save = defineOperation({
  id: "documents.save",
  // ...
  input: { params, body: objectSchema({ document: richTextDocumentSchema(documentBody) }) },
  transaction: "write",
  dependencies: { tx: unitOfWork, body: documentBody.binding },
  handler: async ({ input, services }) => {
    const ownerId = `${scope.tenantId}/${input.params.documentId}`;
    // Validates, attaches newly referenced uploads, detaches dropped ones, all in this transaction.
    const saved = await services.body.save({ ownerId, document: input.body.document });
    await services.tx.documents.forTenant(scope).upsert({ id, body: saved.document, bodyText: saved.text });
  },
});

export const documentsModule = defineModule({
  id: "documents",
  operations: [save, read, remove],
  providers: [richTextProvider(documentBody)],
  imports: ["ship-storage"],
  exports: [],
  attachments: [documentImage],
  richText: [documentBody],
});
```

`services.body.render(document)` returns HTML with short-lived signed URLs for
embedded objects, resolved at render time and never stored;
`services.body.clear({ ownerId })` detaches every embedded object when the
owning record is deleted, so the storage purge outbox removes the bytes.

See `docs/v4/features/rich-text.md` and ADR-0026.
