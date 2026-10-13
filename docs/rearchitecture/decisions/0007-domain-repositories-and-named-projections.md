# ADR-0007: Keep domain repositories explicit

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** Drizzle repository structure, pagination, audit fields, soft deletion, and read projections
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0006](./0006-executable-transaction-scopes.md)

## Context

The current `DrizzleEntityService` tries to provide reads, writes, filtering, search, ordering, relation loading, audit stamping, soft deletion, hooks, tracing, and request-context access for every domain. Its public results are `unknown`, unknown filter columns are silently dropped, relation names are unbounded strings and partly advisory, and its audit behavior assumes one schema naming convention.

Applications may have legacy `createdDate`/`updatedDate`/`deletedDate` columns, domain-specific attribution fields, relation-heavy views, reporting queries, and transactional writes whose invariants cannot be represented honestly as universal CRUD.

## Decision

ShipAPI will not replace `DrizzleEntityService` with another base repository or generic CRUD factory. A domain repository owns its supported methods and writes ordinary typed Drizzle queries against the transaction supplied by its unit of work.

The Drizzle adapter provides only four reusable primitives:

1. `resolveOffsetPagination()` validates and freezes bounded limit/offset windows. `offsetPage()` builds an immutable result from the rows and matching count a repository queried.
2. `defineAuditColumns()` maps the semantic create/update timestamps and optional actors to the table's actual TypeScript column names. Create and update stamps remain separate so a repository chooses exactly which fields a write changes.
3. `defineSoftDeleteColumns()` maps the nullable deletion timestamp plus optional update/actor fields, and supplies explicit active/deleted predicates and delete/restore values.
4. `defineRepositoryProjections()` closes dynamic read shapes over a finite set of named, fully typed query functions. The functions own their joins, selected fields, and cost; an undeclared name fails with a stable diagnostic.

These helpers do not parse HTTP input, choose domain defaults, infer physical schema names, add joins, run arbitrary filters, or open their own database connection. Repository instances are constructed from the active transaction inside the unit of work.

## Consequences

- Repository APIs expose domain language and exact result types instead of `unknown` CRUD results.
- Legacy physical schemas can retain their real column names without adopting framework-owned `baseFields`.
- A projection name identifies a whole reviewed query rather than granting callers an arbitrary relation array.
- Pagination bounds and result envelopes are reusable without forcing them to become the HTTP wire contract.
- Soft-deleted rows are included only at explicit query sites; there is no invisible global filter.
- Page rows and totals remain repository-owned queries. Repositories must reuse the same predicates and transaction; stronger snapshot or cursor semantics are domain decisions.
- Some small repositories will contain a little repeated Drizzle code. That repetition is preferable to hiding domain invariants in a generic service.

## Rejected alternatives

### Repair and type the universal entity service

Rejected because stronger generics do not resolve its mixed ownership of transport filters, relations, lifecycle hooks, persistence, and domain behavior.

### Publish an ORM-neutral arbitrary-filter DSL

Rejected because it turns every table column and operator into accidental public API, obscures query cost, and still cannot express domain-specific queries safely.

### Continue accepting relation-name arrays

Rejected because string arrays can drift from executable joins and let callers request expensive or sensitive shapes that were never modeled as an operation.

### Require one framework audit-column convention

Rejected because the physical database is authoritative and existing clients use several legitimate naming and attribution schemes.
