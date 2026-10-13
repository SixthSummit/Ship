# Phase 01: Packed contract conformance

- **Status:** In progress — ShipAngular synthetic conformance complete; real ShipAPI artifact manifest pending
- **Checkpoint:** C1 — boundary proven
- **Depends on:** C0 and ShipAPI operation-graph projection prototype
- **Primary owners:** ShipAPI contract owner, ShipAngular testing owner

## Objective

Prove the cross-repository boundary with the exact browser artifacts applications will install before building the new Angular runtime around it.

## Scope

- ShipAPI fixture operation graph;
- deterministic browser-safe contract package;
- default structural operation HTTP client package;
- wire fixtures and deterministic local fixture server;
- artifact manifest, graph hash, versions, and checksums;
- positive and negative TypeScript consumers;
- browser/server forbidden-import and package-content scans; and
- replacement path for the optional sibling-source smoke suite.

This phase does not design Angular resource state or migrate production sites.

## ShipAPI deliverables

- [ ] Declare fixture operations for 200/201/204, declared errors, validation, auth, rate limiting, ETag, codecs, upload/download, stream, and socket metadata.
- [ ] Generate the contract twice and prove byte/hash determinism.
- [ ] Pack the browser contract and structural client.
- [ ] Pack or distribute the development-only local fixture server separately.
- [ ] Publish safe error/validation/metadata/protocol fixtures.
- [ ] Prove direct execution and Hono adapter expose equivalent operation behavior.
- [ ] Prove packages do not import server handlers, database/auth-provider runtime, or Node-only code.

## ShipAngular deliverables

- [x] Add a clean type consumer that imports only packed public packages.
- [x] Add negative programs for unknown IDs, wrong input locations/types, impossible statuses, and undeclared errors.
- [x] Add a package scan for Hono route trees, Drizzle, database clients, Firebase Admin, Node builtins, and server observability.
- [x] Verify runtime graph hash and artifact metadata are accessible without loading schemas unnecessarily.
- [x] Record the consumed manifest/checksums in test output.
- [x] Make missing external fixture artifacts a hard failure in the joint command.

Implementation evidence:

- `pnpm test:packed-conformance` is a required local/CI gate using independently packed synthetic protocol fixtures;
- `pnpm test:joint-conformance` requires `SHIP_API_CONFORMANCE_MANIFEST` and never falls back;
- `conformance/packed-consumer` holds strict positive and negative public-package programs;
- `scripts/verify-packed-conformance.mjs` verifies checksums, export targets, portable dependency ranges, forbidden imports, runtime cases, and cancellation; and
- the sibling-source `createResource.shipapi-smoke.spec.ts` and its conditional skip have been removed.

This evidence completes the ShipAngular-owned synthetic conformance implementation. It does **not**
claim C1: the real generated ShipAPI application-specific artifacts and wire fixture still have to
arrive in one manifest and pass the external command. ShipAPI revision `059229c` resolves the former
monolith dependency gap through the isolated `@sixthsummit/ship-contract` package, but a source or
sibling build is not durable checkpoint evidence.

## Contract decisions and remaining package work

- [x] Canonical `AppContract` representation is a nested `operations` map whose entries
      contain `transport`, `input`, and a status-discriminated `result` union.
- [x] ShipAngular derives status-indexed success and declared-error helpers from that result
      union and adds ShipAPI's framework failures without importing ShipAPI declarations.
- [x] ShipAPI's JSON `ClientContract` manifest is the minimal runtime metadata seam; the isolated
      `@sixthsummit/ship-contract` package owns the browser-safe structural protocol without pulling
      in the ShipAPI server monolith.
- [ ] explicit codec registration/identity;
- [x] The runtime manifest carries a deterministic SHA-256 fingerprint; the coordinated
      deployed-client compatibility policy is still open.
- [ ] final application contract/client artifact-manifest topology and publish ownership; and
- [x] Validation uses stable `details.issues` entries with string/number paths, safe messages,
      and optional machine codes.

Any decision that affects public cross-repository types amends ADR 0002 or receives a focused ADR.

## Required tests and gates

- G0–G3
- G5 package-boundary subset
- zero optional skips
- offline rerun after artifacts are acquired

The full cases are defined in `JOINT_CONFORMANCE_PLAN.md`.

## Checkpoint review

Review the tarballs, not only source. Demonstrate one valid call, at least four invalid type consumers, one valid declared failure, one malformed proxy response, and the forbidden-import scan in the checkpoint meeting.

## Exit criteria

- [ ] Exact packed artifacts install in a clean consumer.
- [ ] Contract bytes/hash are deterministic.
- [ ] Positive and negative type suites pass.
- [ ] No forbidden runtime dependency appears in tarball or browser bundle.
- [ ] Validation/error/metadata minimum is jointly accepted.
- [x] Required CI cannot fall back to a sibling checkout or skip.
- [ ] Phase 02 can implement against a versioned seam without guessing URLs/serialization.

## Suggested commits

- `test(contract): add fixture type consumers`
- `test(contract): verify packed artifacts`
- `ci(contract): require conformance manifest`

ShipAPI artifact-generation commits land in ShipAPI and reference the same fixture protocol version.
