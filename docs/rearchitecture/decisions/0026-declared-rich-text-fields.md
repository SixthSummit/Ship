# ADR-0026: Declare rich text fields as a versioned, kernel-owned document allowlist with embedded managed attachments

- **Status:** Accepted
- **Date:** 2026-10-23
- **Scope:** Rich text field declaration and extensions, the stored document model, the base allowlist and its version, server-side rendering and the plain-text projection, embedded attachment reconciliation and purge, the migration hook, contract projection, the Angular editor
- **Related:** [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0011](./0011-explicit-bounded-request-bodies.md) · [ADR-0021](./0021-schema-safety-gates.md) · [ADR-0022](./0022-declared-managed-storage.md)
- **Numbering note:** 0025 is reserved by the concurrent credential authentication branch. Renumber on merge if a gap remains.

## Context

Consumers that need formatted content store raw HTML strings and sanitize
them, or forget to, at every place the string is displayed. One consumer's
document text (`PUT /v1/documents/:id/text`) and another's message templates
are both this shape today. Each display edge is a separate opportunity to
render user-controlled markup unescaped, nothing can answer "what nodes may a
document contain" because the answer lives in whichever sanitizer ran last,
and images pasted into such a field are URLs with no owner, so nothing purges
them when the record goes.

Rails' Action Text is the reference: `has_rich_text :body` gives a sanitized
column, attachments embedded through Active Storage, a rendering helper that
never emits raw user HTML and an editor that round-trips. The TypeScript
ecosystem has editor engines (ProseMirror, TipTap on top of it) but no
batteries-included layer: nothing owns the allowlist, the storage shape, the
rendering, or the lifecycle of what is embedded.

The kernel now has managed storage (ADR-0022): a declared attachment whose
objects are attached and detached inside the owning transaction and purged
through a durable outbox. Embedded images should be those objects.

## Decision

### The stored model is the ProseMirror document, never HTML

A field is stored as ProseMirror JSON (the format a TipTap editor emits from
`getJSON()`) plus `schemaVersion`. HTML is derived on the server at read
time through one renderer. The ProseMirror schema is the allowlist: a node,
mark or attribute outside it cannot exist in a stored document, and the
editor's paste parser drops anything the schema does not match before it
enters the document.

### The base allowlist is kernel-owned and versioned

`RICH_TEXT_SCHEMA_VERSION` is a kernel constant (1). Version 1 is:
`paragraph`, `heading` (levels 2 and 3), `bulletList`, `orderedList`
(`start`, `type`), `listItem` (`paragraph block*`), `blockquote`,
`codeBlock` (`language`, no marks), `hardBreak`, `attachment` (block atom,
`objectId` and `alt`, present only when the field declares an attachment)
and `text`; marks `bold`, `italic`, `code` and `link` (`href` limited to
absolute `https:` and `mailto:` URLs under 2048 characters, `title`). Tables,
images by URL, underline, strikethrough, colour, alignment and `h1` are
deliberately absent; `h1` so a document never competes with the page title,
the rest because each is either a styling concern the application's CSS
owns or a structure whose sanitization surface is out of proportion to the
two consumers' needs.

Every stored document carries the version it was validated against. A bump
of the constant is a release step: the field declares
`migrations: [{ from, to, migrate }]`, `validate`, `render` and `save` refuse
a document at any other version, and an explicit `migrate` call rewrites
stored rows. Rendering never migrates on its own, so a schema change can
never silently alter what an existing document renders to.

### Consumers widen the schema only by named, declared extension

`defineRichTextExtension({ name, nodes, marks })` adds nodes and marks next
to the base ones, each with a structural spec (group, content expression,
atom, typed attributes, mark policy) and server-only `renderHtml` /
`renderText` / `validate`. An extension cannot redefine a base name. The
field lists its extensions, so what a document may contain is visible in the
declaration and in the application graph; the renderers never leave the
server, the structural specs reach the contract so the editor builds the same
schema. The first consumer extension is an inline `mergeField` atom for
templates.

### The engine is a hand-written walker, not a DOM

`@sixthsummit/ship-rich-text` validates, sanitizes, renders and migrates by
walking the JSON tree directly: no `prosemirror-model` on the server, no jsdom
shim, no native dependency, Node and edge alike. Strict validation reports
every violation with a JSON path and never changes the input; sanitization
drops what is forbidden and reports each drop; both answer a canonical,
frozen document (no empty `attrs`, `marks` or `content`, nothing but declared
keys). Size (`maxBytes`, canonical JSON bytes, default 256 KiB) and depth
(`maxDepth`, default 32) are bounded before the walk. Text with U+0000 or a
lone surrogate is refused because PostgreSQL `jsonb` and JSON refuse them.

The renderer escapes every text and attribute value, re-checks link hrefs
against the allowed schemes, renders nothing for unknown nodes and marks,
merges adjacent text runs with equal marks and nests marks deterministically
(`link` outermost). Link `rel` (default `noopener noreferrer`) and `target`
are field options. The plain-text projection turns block boundaries into
newlines, keeps hard breaks, uses an attachment's alt text and an extension's
`renderText`; the application stores it next to the document for search and
previews.

### Embedded attachments are managed objects reconciled by `save`

A field declares the attachment its embedded objects belong to; the owning
module declares both. The capability bound to `field.binding` is scoped by
the executor together with that attachment's capability in the same
transaction scope. `save({ ownerId, document })` validates, checks that every
newly referenced object is an unattached upload of the field's attachment
(unknown, purged or attached-elsewhere objects are refused with a
path-addressed issue, or dropped under `onInvalid: "sanitize"`), attaches
them, detaches the objects the previous document referenced and this one no
longer does, and returns the document, its text projection and what changed.
`clear({ ownerId })` detaches everything when the record is deleted. Both run
inside the consumer's write transaction, so the ledger change and the purge
intents commit with the row and an embedded image lives exactly as long as
the owning record. The attachment node stores the object id only; `render`
resolves a short-lived signed URL at render time and never stores one.

### Contracts and the editor agree by construction

`@sixthsummit/ship-contract` projects `richText` (schema version,
attachment id, limits, extension specs) and the field ids an operation binds.
`@sixthsummit/ship-angular/rich-text` builds its TipTap schema from that
policy: the base version 1 set plus every declared extension node and mark,
rendered in the editor as a generic element carrying its attributes as
`data-*`. `richTextFieldFromManifest` refuses a manifest whose schema version
the entrypoint does not build. The component is a `ControlValueAccessor`
whose value is the document model with `schemaVersion` from the manifest;
TipTap-only attributes (a link's `target`, `rel`, `class`) are stripped
before emission. Dropped or pasted images go through the storage upload
client as one managed upload each and insert an `attachment` node with the
settled object id. The server validates every document again regardless.

### Editor library

TipTap (MIT, headless, on ProseMirror) wrapped in a thin in-house component.
`ngx-tiptap` was rejected: its current release requires Angular 22 while the
package supports 20, and it adds `@floating-ui/dom` and bubble-menu
dependencies the field does not need. The peer set is `@tiptap/core`,
`@tiptap/pm` and `@tiptap/starter-kit` configured to the base set
(`strike`, `underline`, `horizontalRule` and `trailingNode` disabled,
`heading` levels 2–3, `link` restricted to `https:` and `mailto:`) rather than
fourteen individual extension packages: measured with esbuild against the
same ProseMirror, the configured StarterKit bundle is 389.1 KB raw /
123.0 KB gzip / 105.4 KB brotli and the individual-package bundle 383.6 KB /
121.7 KB / 104.5 KB, a 1.3 KB gzip difference for eleven fewer peer
dependencies. The entrypoint's own code is 22.2 KB raw / 6.3 KB gzip / 5.5 KB
brotli in the packed FESM bundle (`angular/.bundle-baseline.json`); the
TipTap and ProseMirror bytes are the consumer's, paid only by applications
that import `/rich-text`.

## Consequences

- Consumers stop storing HTML. A field is `jsonb` plus a `text` projection
  the application owns and migrates as a gated release step (ADR-0021).
- There is one renderer, one allowlist, one place to review a widening. A
  display edge that needs HTML calls `render`; one that needs text reads the
  projection.
- Purge follows the owning record for embedded images, through the same
  outbox as every other attachment (ADR-0022). Images by URL are not
  representable.
- A schema bump is visible: a constant, a migration on each field, a
  rewrite of stored rows. Old documents are refused rather than rendered
  differently.
- The Angular editor cannot emit a document the server would accept for a
  reason the server does not know: both read the same manifest entry.
- Decisions to confirm: the exact base set (heading levels 2–3, no `h1`,
  no tables), link `rel` / `target` defaults, the 256 KiB default size, and
  the StarterKit peer set with the numbers above.

## Alternatives considered

- **Sanitized HTML column with a shared sanitizer.** Keeps every edge a
  display-time decision, makes the allowlist a regex, and gives embedded
  images no owner. Rejected.
- **Markdown.** No typed attachment node, no extension model, and a renderer
  whose HTML output still needs an allowlist. Rejected.
- **`prosemirror-model` `DOMSerializer` on the server.** Needs a DOM or a
  shim in Node and at the edge and does not escape through one reviewed path.
  The JSON walker is smaller and the schema it enforces is the same one the
  editor was built from. Rejected for the server; the editor uses ProseMirror
  as intended.
- **Operation-level `richText: [field]` declaration next to the binding, as
  attachments do.** Rejected as ceremony: the binding alone identifies the
  field, the graph derives the operations from it, and the compile
  diagnostics catch a binding to an undeclared or unimported field.
- **Storing resolved image URLs in the document.** A URL is a credential
  with a lifetime; the id is the reference. Rejected.

## Evidence

- Kernel suite: declaration and extension validation, module and operation
  diagnostics, graph projection without renderers, executor scoping with and
  without an attachment.
- `@sixthsummit/ship-rich-text` suite: schema compilation, strict validation
  of forty-plus refused shapes, sanitization with the full dropped report,
  canonicalization, size and depth bounds, the XSS corpus (forty payloads in
  thirteen placements, rendered raw and after sanitization), the text
  projection, migrations, and the capability's attach / detach / refuse /
  clear semantics against a fake scoped attachment capability.
- `@sixthsummit/ship-contract`: the `richText` projection carries no
  renderer and absent fields keep the fingerprint.
- `@sixthsummit/ship-angular/rich-text`: manifest policy, schema parity with
  the server (exact node and mark sets), paste sanitization through the
  schema, attribute stripping and round-trip, form binding, disabled state,
  drop and paste upload, upload failure.
- Customized golden consumer: `portfolio.document-body` with the
  `portfolio.document-image` attachment and the `merge-field` extension;
  unit tests over the in-memory backends for projection, refusal at the
  input boundary and in the capability, render-time signed URLs, dropping an
  image on save and deletion of the document; a real-PostgreSQL test proving
  the row, the attached object, the refused save that changes nothing, the
  deletion that commits the row removal and the purge intent together, the
  dispatch that deletes the bytes, and the refusal to reuse the purged object.
