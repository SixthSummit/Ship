---
"@sixthsummit/ship-core": minor
"@sixthsummit/ship-contract": minor
---

Declare rich text fields (ADR-0026). `defineRichText({ id, attachment?, extensions?, maxBytes?, maxDepth?, links?, onInvalid?, migrations? })` declares a field over the versioned kernel-owned base allowlist (`RICH_TEXT_SCHEMA_VERSION`), `defineRichTextExtension` declares named nodes and marks with a client-safe structural spec and server-only renderers, modules list `richText`, operations bind `field.binding` and the executor hands handlers a `ScopedRichTextCapability` scoped to the running transaction together with the field's attachment capability. Compile diagnostics cover duplicate or misnamed ids, an undeclared attachment, a missing or non-singleton provider, bindings to undeclared or unimported fields and an unreachable attachment capability; the application graph gains `richText` nodes. `@sixthsummit/ship-contract` projects `richText` (schema version, attachment id, limits and extension specs, never a renderer) and the field ids an operation binds.
