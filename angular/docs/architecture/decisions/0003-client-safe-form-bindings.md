# ADR 0003: Generated client-safe form bindings

- **Status:** Accepted jointly; primitive projection verified with packed ShipAPI artifacts (2026-09-08)
- **Date:** 2026-09-03
- **Deciders:** ShipAngular and ShipAPI maintainers
- **Related:** ADR 0002 and ShipAPI's operation graph

## Context

The legacy `createSchemaForm()` accepts a structural Zod object, probes it with
sentinel values to guess control defaults, and was documented as consuming
Drizzle-derived ShipAPI schemas. That approach crosses the browser/server
boundary, cannot represent server-only or asynchronous refinements, and loses
the difference between an omitted optional field and empty, zero, false, null,
or an empty collection.

We compared three directions for operation forms:

| Direction                                        |                                                                                               Runtime cost | Fidelity                                                                                                | Skew/error behavior                                                                  | Decision                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Generated field binding from the operation graph |                                6,874-byte ESM entrypoint; 1,971 bytes gzip before application tree shaking | Explicit presence, codecs, stable issues, and control values                                            | Type mismatch fails compilation; graph hash remains the cross-repository skew signal | Default                                           |
| Browser-safe Zod package                         | The installed Zod package is 5.0 MB on disk before bundling; actual app cost varies by imported validators | Good for supported synchronous refinements, but server-only refinements must be projected or omitted    | Runtime/schema version is another compatibility surface                              | Optional future adapter only                      |
| Generic JSON/Standard Schema interpretation      |                                             Requires a runtime interpreter and a supported-subset contract | Portable, but Angular control defaults, codecs, and optional presence still need Ship-specific metadata | Unsupported keywords can fail only at runtime unless generation validates them first | Exchange format only, not the Angular runtime API |

Measurements were taken from the production `ng-packagr` output on this branch.
They are comparison evidence, not application bundle budgets; the package gate
also proves that the `/forms` entrypoint contains no Zod, Drizzle, Hono, or Node
runtime import.

## Decision

The first shared syntax is now implemented by ShipAPI CLI's `renderOperationFormBinding` and
verified by the required retained joint fixture. It emits an import-free TypeScript literal with
`operation`, `fields`, explicit initial presence and identity `encode`/`decode` functions. Its
supported subset is top-level string/number/integer/boolean fields with optionality and primitive
nullability. Initial controls are explicitly supplied by the application; omitted fields start
omitted even when their control value is false, empty or null. Projected string `minLength` is the
first advisory synchronous validator. Other server constraints remain authoritative and are not
claimed as browser validation. Nested objects, collections, enums and custom codec projections
are rejected by this initial generator rather than guessed. The binding travels with the exact
contract graph hash and its own tarball checksum. Advanced bindings described below remain the
extension design, not implemented generator capabilities.

ShipAPI's browser artifact will generate or expose an `OperationFormBinding`
equivalent for form-capable operation bodies. The binding declares:

- the stable operation ID;
- one typed field entry per supported top-level body field;
- whether that field may be omitted;
- an explicit initial presence and control value;
- a control-to-wire codec; and
- synchronous, browser-safe validation that returns stable issue paths, codes,
  and safe messages.

ShipAngular's `/forms` entrypoint turns that binding into typed Angular
`FormControl`s. Serialization reads explicit presence instead of truthiness or
schema probing. Server validation remains authoritative and its stable issues
can be mapped back to controls without parsing messages.

Dates, big integers, decimals, branded IDs, nested values, and collections are
never guessed. The generated binding supplies a codec or treats the value as an
opaque typed control value. Async uniqueness checks and any refinement needing
database, provider, filesystem, secret, or server context are not projected as
client validators.

The legacy root `createSchemaForm()` remains temporarily available for
browser-owned and third-party Zod-like schemas. It is deprecated for ShipAPI
integration and is not the contract-generation target.

## Consequences

- ShipAngular has no schema-runtime dependency in its operation form
  entrypoint.
- Optional and nullable wire semantics are exact and testable.
- Generated code is deterministic backend output rather than application-authored
  duplication.
- The first packed ShipAPI fixture must settle the serialized binding syntax and
  graph-hash relationship before release.
- A future Zod or Standard Schema adapter must live in an optional secondary
  entrypoint and pass the same semantic tests; it cannot weaken the default
  binding contract.

## Implementation note — 2026-10-12

The initial packed fixture and graph-hash relationship described as a release
prerequisite above are retained in `conformance/joint/`. The primitive generator
remains the implemented subset; advanced binding design is not a claim of
complete generator support.
