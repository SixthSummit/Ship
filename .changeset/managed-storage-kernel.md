---
"@sixthsummit/ship-core": minor
"@sixthsummit/ship-contract": minor
---

Declare managed storage (ADR-0022). `defineAttachment({ id, cardinality, contentTypes, maxBytes, visibility, maxCount?, variants?, intentTtlMs? })` declares an attachment field; modules list `attachments`, operations declare `attachments` and bind `attachment.binding`, and the executor hands handlers a `ScopedAttachmentCapability` bound to the running transaction (`attach`, `detach`, `list`, `read`, `url`, `variant`). New compile diagnostics cover unbound or undeclared bindings, undeclared or unimported attachments, duplicate or misnamed ids, a missing storage module and non-singleton providers. The `StorageAdapter` and `AttachmentLedger` contracts live in the kernel; the application graph gains `attachments` nodes. `@sixthsummit/ship-contract` projects `attachments` (cardinality, content types, size, visibility, count and variant names; never the provider) and types them through `ApplicationContractOf` and `ClientTypeContract`.
