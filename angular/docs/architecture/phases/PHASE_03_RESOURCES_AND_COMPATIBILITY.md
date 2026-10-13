# Phase 03: Resources and client compatibility

- **Status:** Complete — Angular resource and compatibility implementation accepted; client rollout is tracked by C8
- **Checkpoint:** C3 — vertical slice proven
- **Depends on:** C2 unary operation kernel
- **Primary owners:** ShipAngular resource owner, migration tooling owner

## Objective

Expose explicit Angular-native resource/mutation APIs over stable operations and provide deliberately limited Hono v4 and pre-Hono URL adapters for incremental client migration.

## Resource deliverables

- [x] Add `createOperationResource(client, operationId, inputFactory, options)`.
- [x] Track signals read by the input factory without constructor-time I/O.
- [x] Pass the loader `AbortSignal` through the operation call.
- [x] Suppress stale generations and define previous-success behavior.
- [x] Expose typed data, declared failure, exceptional failure, response metadata, status, and reload.
- [x] Define ETag/304 behavior without parsing an empty body.
- [x] Add `createOperationMutation` with explicit execution state.
- [x] Require explicit optimistic apply/rollback/reconcile behavior.
- [x] Keep generic third-party REST independent at the root entrypoint.
- [x] Preserve, but do not silently reinterpret or extend, the legacy `createResource` thunk overload.

## Compatibility adapter deliverables

- [x] Add `HonoV4ClientAdapter` in a named compatibility entrypoint.
- [x] Add `LegacyRestClientAdapter` for the legacy copied URL client migration path.
- [x] Keep application route-tree types inside a generated/manual mapping.
- [x] Keep temporary URL construction and serialization inside an application-owned mapping.
- [x] Normalize supported legacy JSON responses to `OperationResult`.
- [x] Forward call options/signals where the legacy call permits.
- [x] Emit actionable diagnostics for missing mapping, unsupported codec/capability, or unavailable cancellation.
- [x] Publish a capability/limitation table and deprecation conditions.
- [x] Run the target operation-resource conformance runner against both clients.

## First vertical slice

Implement one fixture read and one idempotent/unsafe mutation end to end:

```text
operation declaration
  -> generated packed contract/client
  -> Angular typed provider/policy
  -> resource or mutation
  -> fixture component
  -> browser and SSR verification
```

The same component-facing expectations should pass through either compatibility adapter where
the legacy transport can support them.

## Required tests and gates

- G0–G5 for the vertical slice
- signal dependency and explicit reload tests
- cancel/supersede/destroy race tests
- declared vs exceptional error-state tests
- mutation attempt-count and optimistic rollback tests
- ETag/304 metadata/data preservation
- Hono/legacy-REST compatibility parity and explicit unsupported-case tests
- generic REST clean consumer without ShipAPI

## Checkpoint review

Demonstrate rapid input changes that complete out of order, component destruction during I/O, declared validation failure, protocol failure, optimistic rollback, and the same supported read through both target and Hono clients.

## Exit criteria

- [x] No new resource API probes an arbitrary function to determine its mode.
- [x] No stale or canceled call can publish current state.
- [x] Resource failures are exhaustive and presentation-friendly.
- [x] Mutation behavior cannot enable unsafe retry accidentally.
- [x] Compatibility is isolated from target public types/runtime.
- [ ] One real canary-site branch compiles far enough to validate adapter ergonomics without deploying.
- [x] Migration schematic/codemod requirements are recorded from actual usage.

## Suggested commits

- `feat(resource): add operation resources`
- `feat(resource): add operation mutations`
- `feat(compat): add Hono v4 adapter`
- `feat(compat): add legacy REST adapter`
- `docs(migration): document resource changes`

Do not combine the compatibility implementation with removal of old root exports.
