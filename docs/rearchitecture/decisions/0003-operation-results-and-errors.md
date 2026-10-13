# ADR-0003: Use status-indexed success schemas and declared error codes

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** Operation handler, graph, HTTP, and client result contracts
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md)

## Context

The kernel needs an internal result model that stays useful outside HTTP while preserving the status-indexed response information required by HTTP, OpenAPI, generated clients, and ShipAngular.

Always returning a response wrapper makes ordinary handlers noisy. Returning only an untagged body cannot represent multiple successful outcomes without guessing. Throwing every declared application failure makes expected outcomes indistinguishable from network, protocol, cancellation, and programmer failures at the client boundary.

## Decision

An operation declares:

- one Standard Schema for every supported successful status;
- an explicit default `successStatus`;
- reusable declared application errors with a stable code, status, safe message, and optional detail schema;
- a handler returning either the default success body or `respond(status, body)` for an alternate declared success.

The direct executor will always project a successful invocation into a discriminated result containing `ok`, `status`, and validated `data`. HTTP is responsible for serializing that result, not for defining it.

Handlers raise a declared error with `operationFailure(error, details)`. Direct/client boundaries normalize it into a typed failure result. HTTP maps that value to the stable error envelope and status metadata. Raising an undeclared error, returning invalid output, network failure, cancellation, malformed adapter responses, and programmer errors remain exceptional.

Schemas implement the structural Standard Schema v1 contract. Zod remains the default and documented implementation, while core type inference does not require a Zod-specific base class.

The first implementation supports JSON-compatible success bodies plus `204`/void. Binary, streaming, and socket capabilities require separate transport declarations and conformance tests; they will not be disguised as JSON.

## Consequences

- A normal single-status operation returns its domain view directly with one explicit status declaration.
- Multi-status success remains type-safe through `respond` without contaminating the response body with control fields.
- Operation contracts expose the exact status/body map ShipAngular and OpenAPI need.
- Direct execution does not lose transport-relevant metadata, while domain handlers remain independent of Hono response objects.
- Every error code is migration-accountable and mechanically discoverable.
- Reusing one immutable error definition across operations prevents status/detail drift without requiring a global mutable registry.

## Rejected alternatives

### Return Hono or Fetch responses

Rejected because it makes the primary operation path transport-dependent and prevents trustworthy direct execution.

### Return only a body and infer status

Rejected for multiple-success operations and because inference would make contract changes implicit.

### Throw all expected failures to clients

Rejected because expected domain/API outcomes should remain inspectable values at the low-level client seam. Server-side handlers may use a typed failure mechanism, but adapters normalize it before returning to clients.

### Use named result variants without statuses

Viable internally, but it would require a second mapping for every HTTP/OpenAPI/client projection. Status-indexed declarations are smaller for the API-shaped applications ShipAPI currently serves.

## Later decisions

Streaming responses are specified by [ADR 0016](0016-streaming-response-representation.md);
declared realtime publication is specified by [ADR 0017](0017-declared-realtime-publication.md).
These extend the original unary contract without making streams ordinary JSON results.
