# Phase 02: Operation kernel

- **Status:** Complete — Angular implementation and synthetic conformance accepted; real artifact replay is tracked by C1
- **Checkpoint:** C2 — unary kernel proven
- **Depends on:** C1 packed contract
- **Primary owners:** ShipAngular operations owner, ShipAPI client owner

## Objective

Implement the minimal lossless Angular-facing operation kernel: result/error types, typed DI, request-scoped context, and one operation-aware unary HTTP policy path.

## Delivery slices

### 2A — Result and error model

- [x] Add `OperationResult`, typed success/error helpers, and `ResponseMetadata`.
- [x] Preserve status, code, message, unknown details/additive fields, request ID, retry metadata, ETag, content type/disposition, and idempotency metadata.
- [x] Add distinct `TransportError`, `ProtocolError`, timeout, and abort handling.
- [x] Adapt failed results to a lossless generic `ApiError<TCode>` for presentation.
- [x] Fix generic REST `ApiClient` error loss without coupling it to ShipAPI operation types.

### 2B — Typed provider and call context

- [x] Add application-typed injection token creation.
- [x] Add `provideShipClient` with browser and request-scoped SSR factories.
- [x] Define a sanitized call context instead of exposing arbitrary incoming headers.
- [x] Configure browser/server API origins explicitly.
- [x] Compose caller, timeout, resource, destroy, and SSR-abandon cancellation.
- [x] Refuse browser-global access during SSR.

### 2C — Request-policy pipeline

- [x] Resolve current bearer credentials on every attempt.
- [x] Bind credentials mode and CSRF to auth capability and allowed origins.
- [x] Generate/forward request IDs and approved locale/trace headers.
- [x] Attach stable idempotency keys only when requested/permitted.
- [x] Parse rate-limit/retry metadata.
- [x] Retry safe operations only by default.
- [x] Require declared idempotency support plus a stable key for unsafe retries.
- [x] Make backoff and I/O abortable; reject unreplayable bodies.
- [x] Never backoff-retry authentication or authorization denial.

## Compatibility boundaries

- Current root exports continue to compile in this phase.
- New code lives behind the target operation entrypoint.
- Angular HttpClient interceptors remain available for third-party REST but are not the ShipAPI operation implementation.
- Do not introduce Hono types into the kernel to make Phase 03 easier.

## Required tests and gates

- G0–G3 on every slice
- G4 for provider/SSR/origin/cancellation behavior
- G5 unary clean-consumer and package scan
- at least 80% changed-file and global coverage in all metrics

Required behavior includes valid/unknown errors, non-JSON proxy responses, request metadata, origin restrictions, credential freshness, concurrent SSR A/B isolation, abortable timeout/backoff, exact mutation attempt count, and redaction.

## Checkpoint review

Demonstrate the same unary fixture call in browser and two overlapping SSR requests. Force validation, denial, 429, timeout, abort, and malformed response. Review captured attempts to prove sensitive headers and retries are correct.

## Exit criteria

- [x] No unary operation reconstructs a URL or serialization rule in ShipAngular.
- [x] Declared failures remain values with complete metadata.
- [x] Exceptional categories are distinguishable and redacted.
- [x] Typed injection requires no application cast.
- [x] Concurrent SSR isolation tests pass.
- [x] Unsafe mutation retry tests prove one attempt without contract/key.
- [x] Generic REST works with no ShipAPI package installed.
- [ ] Public API and bundle review approve the operations entrypoint.

## Suggested commits

- `feat(operations): add result primitives`
- `fix(http): preserve structured failures`
- `feat(ssr): add request-scoped client`
- `feat(transport): add request policy`

Each commit includes its behavior tests; use a Changeset for every consumer-visible slice.
