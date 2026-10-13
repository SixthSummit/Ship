# Phase 05: Transport capabilities

- **Status:** Complete — Angular transports and packed browser conformance accepted; generated ShipAPI metadata remains under C1
- **Checkpoint:** C5 — browser protocols proven
- **Depends on:** C3 operation resources; C4 credential policy for authenticated capabilities
- **Primary owners:** ShipAngular transport owner, ShipAPI capability owner

## Objective

Replace handwritten, disconnected upload/download/stream/socket behavior with explicit graph-derived capabilities that share request policy while preserving the semantics of each browser transport.

## Subphase 5A — Uploads

- [ ] Contract declares field names, counts, accepted media types, size limits, and response schema.
- [x] XHR remains available for progress but consumes prepared credential/header policy.
- [x] Browser validation is explicitly advisory; server validation remains authoritative.
- [x] Overlapping starts use generation identity; reset/destroy abort active work.
- [x] Success and standard JSON failure decoders are explicit and type-safe.
- [x] Signed upload models sign, provider transfer, and completion separately.
- [x] Signing accepts cancellation; late sign responses cannot revive canceled work.
- [x] ShipAPI credentials are excluded from provider origins unless explicitly declared.

## Subphase 5B — Downloads

- [x] Preserve exact bytes, status, MIME type, disposition, filename, and response metadata.
- [x] Parse a standard JSON error before returning a binary body.
- [x] Support contract-declared Blob, ArrayBuffer, and ReadableStream modes.
- [x] Cancel/destroy releases readers and partial data.
- [x] Handle missing CORS-exposed headers with actionable diagnostics.

## Subphase 5C — SSE and chunked streams

- [ ] Derive event decoder/schema and reconnect permission from the contract.
- [x] Parse UTF-8, CRLF, multiline data, comments, and frames split across arbitrary chunks.
- [x] Implement sticky event IDs correctly.
- [x] Distinguish normal completion, abort, network failure, protocol failure, and declared pre-stream failure.
- [x] Pass cancellation through fetch and body reader; cancel reader on destroy/supersession.
- [x] Bound retained events and define consumer backpressure/buffering behavior.
- [x] Reconnect only when declared and safe; preserve approved event ID behavior.

## Subphase 5D — WebSockets

- [ ] Derive URL, subprotocol, message codecs, close codes, and reconnect policy from capability metadata.
- [x] Re-resolve authentication on every connection/reconnect.
- [x] Never place bearer credentials in query parameters.
- [x] Define sends while connecting/closed as queue, reject, or explicit result—never silent drop.
- [x] Surface invalid incoming messages as protocol failures.
- [x] Bound message queues/history.
- [x] Cancel reconnect timers and close sockets on destroy.
- [x] Remain inert during SSR without touching browser globals.

## Shared policy constraints

The common layer prepares origin, credentials, CSRF, request ID, trace/locale context, idempotency where applicable, and cancellation. Transport adapters own actual XHR/fetch-reader/WebSocket execution. Do not force these capabilities through the unary JSON `call` result if doing so loses progress, bytes, incremental events, or close state.

## Required tests and gates

- G0–G5 for each completed capability
- parser/state-machine unit tests with deterministic chunks, timers, and races
- real Playwright tests for CORS, XHR progress, binary bytes, streams, and socket negotiation
- exact request/attempt/header capture through the local fixture server
- abort/reset/destroy/supersession cleanup assertions
- auth refresh/reconnect and origin-redaction assertions
- per-capability secondary-entrypoint bundle budgets

## Checkpoints within the phase

- **C5A:** upload and signed-upload complete
- **C5B:** download complete
- **C5C:** SSE/chunk stream complete
- **C5D:** WebSocket complete; phase exit review

Capability-heavy client sites enter migration only after their required sub-checkpoints pass.

## Exit criteria

- [x] All four capability suites pass against packed artifacts in a real browser.
- [x] Credentials and metadata use the common policy consistently.
- [x] No stale callback, reader, timer, or socket can mutate destroyed/superseded state.
- [x] Protocol errors are visible and distinguishable.
- [x] Buffers are bounded and defaults documented.
- [ ] ShipAPI and ShipAngular use the same generated schemas/protocol metadata.
- [x] Generic non-ShipAPI helpers, if retained, are explicitly separate.

## Local evidence

`pnpm test:browser-conformance` compiles only packed public entrypoints and runs a
cross-origin Chromium fixture. It proves real XHR progress and abort, multipart policy
headers, binary bytes and disposition metadata, JSON download errors, split CRLF SSE frames
and reader abort, WebSocket subprotocol negotiation, fresh reconnect tickets, and server-side
observation of all three abortable HTTP transports. Captured requests also prove cookie mode
does not leak bearer credentials and safe transports receive neither CSRF nor idempotency
headers. Unit suites retain the exhaustive destroyed/superseded-state and protocol-failure
matrix. C5 remains in verification until capability schemas and policies come from ShipAPI's
generated artifact rather than the local typed fixture.

## Suggested commits

- `feat(upload): add operation capability`
- `feat(download): preserve response bytes`
- `feat(stream): decode contract events`
- `feat(socket): enforce protocol metadata`

Each subphase receives its own Changeset and checkpoint evidence.
