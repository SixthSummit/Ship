# ADR 0013: Primitive form projection and retained joint artifacts

- **Status:** Accepted
- **Date:** 2026-09-08
- **Related:** [ADR-0009](./0009-client-safe-contract-projections.md) · ShipAngular ADR 0003

## Context

Angular has a browser-safe form binding API, but its projection syntax and the real packed
integration seam still lacked backend-produced proof. Synthetic frontend fixtures cannot establish
that a generated ShipAPI contract and client are structurally compatible.

## Decision

The CLI exposes `renderOperationFormBinding(contract, operationId, initialValues, exportName?)`.
It emits an import-free TypeScript literal from the projected operation body, with `operation`,
`fields`, optionality, explicit initial presence and typed identity codecs. Application authors
supply every initial control value. Optional fields start omitted; empty, false, zero and null
are values, never omission sentinels. Only top-level primitive and nullable primitive fields are
supported initially. Nested/collection/custom/enum codecs are rejected. String `minLength` is an
advisory synchronous validator; other constraints and server refinements remain authoritative on
the server and are not represented as completed browser validation.

The fixture producer runs the real graph through the CLI projection, packages its manifest and
declarations, bundles the built structural HTTP client, and packages a separate local Hono server.
Angular installs these tarballs, verifies their declared names/versions/checksums and tests the
real seam in strict TypeScript, Node request injectors and Chromium. Contract types and client
declarations retain the existing protocol type owner; no Angular import or server graph type is
introduced into browser artifacts.

Both CI gates are required. API generates the bundle twice and compares exact hashes. Angular
uses a reviewed retained manifest/archive set so a private registry token or sibling checkout is
not required. The producing base commit, actual bundled source hash and archive checksums are
recorded. The aggregate `artifactSetHash` covers graph identity and every package name, version and checksum; the server-only source hash does not establish client/form currency. An API candidate changing relevant behavior requires regenerating and reviewing the
retained consumer bundle; passing an old pinned fixture is not proof about an untested candidate.

## Consequences

The available unary/form seam now has executable shared proof. The broader C1 plan still contains
explicit backend transport, advanced-codec and server-retry milestones. Actual overlapping SSR documents and generated cookie refresh/replay are now covered. A passing primitive
fixture does not mark those capabilities shipped. Retained archives add about 200 KB and require
a deliberate update, in exchange for reproducibility without hidden cross-repository credentials.
