---
"@sixthsummit/ship-angular": minor
---

Add the `/rich-text` entrypoint: `ShipRichTextEditorComponent`, a `ControlValueAccessor` over TipTap that emits the document model (never HTML) with `schemaVersion` from the manifest, builds its schema from `richTextFieldFromManifest` (the base version 1 set plus every declared extension node and mark) so pasted content outside the allowlist is dropped by the schema itself, uploads dropped or pasted images through `createRichTextAttachmentUploader` on the storage entrypoint and inserts `attachment` nodes referencing the settled object id, and resolves previews by object id. Optional peers: `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`.
