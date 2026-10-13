# ADR-0005: Project one stable HTTP wire and representation contract

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** HTTP request parsing, success representations, response headers, and failure serialization
- **Related:** [ADR-0003](./0003-operation-results-and-errors.md)

## Context

The operation kernel deliberately has no dependency on Hono or Fetch. Its HTTP projection still needs a precise browser-visible contract for generated clients, ShipAngular, compatibility tests, and non-generated consumers. Leaving representation and failure behavior implicit would recreate the current framework's drift between documentation, middleware, clients, and tests.

The boundary must also prevent ordinary application handlers from leaking internal exceptions, overriding correlation metadata, or returning transport-native response objects that bypass output validation.

## Decision

HTTP-bound operations use one explicit projection:

- request inputs remain separated into `params`, `query`, lower-case `headers`, and `body`;
- repeated query keys become arrays and singular keys remain scalars;
- a non-empty declared body accepts `application/json` and `application/*+json` content types;
- JSON bodies are decoded as strict UTF-8 and limited to 1 MiB by default, with an adapter-level positive integer override;
- empty bodies reach the operation schema as `undefined`;
- malformed UTF-8/JSON returns `400 VALIDATION_ERROR`, unsupported media returns `415 UNSUPPORTED_MEDIA_TYPE`, and an oversized body returns `413 PAYLOAD_TOO_LARGE`;
- every failure is JSON and every response carries a safe `X-Request-Id`.

The stable failure envelope is:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "issues": [
        {
          "path": ["body", "name"],
          "code": "too_small",
          "message": "Name is required"
        }
      ]
    }
  }
}
```

`details.issues` is the stable validation container. Each issue has a string/number `path`, a safe `message`, and may have a machine-readable `code`. Consumers must tolerate unknown additive envelope, error, detail, and issue fields. Removing or renaming these fields, changing their types, or changing a durable error code's meaning is a breaking contract change.

Success representation is declared on the HTTP transport as `json`, `text`, or `binary`, with an explicit or deterministic default content type. `204` never has an entity body. Binary output accepts Fetch-compatible byte and stream values, while the operation's output schema remains authoritative.

Handlers return domain values or `respond(status, body, { headers })`; they do not return Hono or Fetch `Response` objects. Operation headers are normalized and validated. The adapter owns `Content-Type`, `Content-Length`, `X-Request-Id`, and hop-by-hop headers, so handlers cannot override them.

Unexpected handler, validation, or serialization defects return only `500 INTERNAL_SERVER_ERROR`. An optional observer receives the original error and frozen request context for logging or tracing; observer failure cannot change the safe response.

## Consequences

- Direct execution and HTTP preserve the same status, data, declared-error details, and safe application headers.
- ShipAngular and generated clients can distinguish declared failures, protocol failures, text, and downloads without guessing from response bodies.
- Body parsing has deterministic resource and content-type limits before operation validation.
- Application code cannot bypass schema validation or framework-owned response metadata with a raw response escape hatch.
- Streaming protocols such as SSE and WebSockets need separate explicit transports rather than overloading the binary response mode.
- CORS configuration must expose browser-readable metadata such as `X-Request-Id`, `ETag`, and `Content-Disposition`; joint client conformance tests own that later adapter work.

## Rejected alternatives

### Let Hono infer serialization from arbitrary handler values

Rejected because generated clients and OpenAPI could not reliably distinguish JSON, text, and binary output.

### Allow handlers to return `Response`

Rejected because it bypasses status/output validation, error normalization, header ownership, and transport-independent direct execution.

### Put request IDs only in the JSON envelope

Rejected because successful text, binary, and empty responses also need correlation metadata. The response header is representation-independent.

### Accept any body content type and attempt JSON parsing

Rejected because silent media coercion makes client mistakes ambiguous and weakens proxy/cache semantics.

## Later decisions

Streaming responses are specified by [ADR 0016](0016-streaming-response-representation.md);
declared realtime publication is specified by [ADR 0017](0017-declared-realtime-publication.md).
These extend the original unary contract without making streams ordinary JSON results.
