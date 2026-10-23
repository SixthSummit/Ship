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

## Addendum 2026-10-22: declared 3xx redirect results (SAPI-653)

This addendum adds a fourth unary representation, `redirect`, to the accepted
decision. The JSON failure envelope, request-id ownership, header ownership
and body limits are unchanged.

### Context

The original decision allowed only 2xx success statuses and the `json`, `text`
and `binary` representations. A compatibility route such as an OAuth callback
answers an empty `302` with a `Location` header after verifying signed state
and exchanging a provider code. Projecting that route as a `200` JSON operation
and rewriting it to a `302` in the adapter would make the generated contract and
OpenAPI dishonest, and the strict query policy rejected the mixed scalar and
bracket query parameters such callbacks receive (SAPI-653, Vault Drive
Phase 4).

### Decision

- `http.<method>(path, { response: "redirect" })` declares a bodiless
  redirect. The operation's output map may contain only `301`, `302`, `303`,
  `307` and `308`; a 3xx output on any other transport, a 2xx output on a
  redirect transport, and a `successStatus` outside the declared redirect
  statuses are definition diagnostics. A redirect transport may not declare a
  content type.
- Every redirect output schema must accept `undefined` and produce
  `undefined`. `defineOperation` checks this synchronously at definition time
  (`SHIP_OPERATION_OUTPUT_INVALID`); the executor re-checks every result, which
  also covers asynchronous schemas.
- The handler returns `respond(status, undefined, { headers: { Location } })`.
  The executor validates the result before any transport sees it: the body
  must be absent and `Location` must be a root-relative path or an absolute
  `http(s)` URL with no credentials, no leading or trailing whitespace and no
  control characters. Protocol-relative (`//`, `/\`) and non-HTTP schemes are
  rejected. CR/LF is rejected by `respond()` header normalization. An invalid
  redirect is an unexpected failure, so HTTP answers the safe `500` envelope
  without a `Location` header.
- The Hono adapter serializes a redirect as the declared status, the
  `Location` header, `X-Request-Id`, any safe operation headers, no entity
  body, no `Content-Type` and no cache headers. Every failure on a redirect
  route, declared or framework-owned, remains the JSON envelope. A failure
  redirect (sending the browser back with `?error=...`) is a handler decision
  expressed as an ordinary redirect result.
- `queryParsing: "first-value"` is an explicit per-operation query policy for
  callbacks that must preserve the compatibility `c.req.query()` semantics:
  each exact key takes its first decoded value and bracket keys stay literal,
  distinct keys. The default remains strict. The policy is recorded in the
  client contract and as `x-ship-query-parsing` in OpenAPI.
- `ship-contract` projects an empty 3xx success with a required `Location`
  header (`format: uri-reference`) and no content. The Fetch client sends
  `redirect: "manual"`, validates the 3xx the same way the server does, and
  exposes `metadata.location`. A browser that answers with an opaque redirect
  yields `SHIP_CLIENT_REDIRECT_OPAQUE`; the client never fabricates a status.
  ShipAngular exposes `location` on `ResponseMetadata` and reports the opaque
  case as `ProtocolError` with reason `opaque-redirect`, so applications
  navigate to the endpoint instead of calling it from script.

### Evidence

Kernel definition and executor suites cover every redirect status, the
Location rejection matrix, body, terse-return and undeclared-status failures,
and handler-chosen failure redirects next to declared JSON failures. The Hono
matrix covers serialization per status, `POST` to `303`, header pass-through
and reserved-header rejection, the mixed scalar/bracket first-value callback
query, JSON failures without `Location`, the 401 envelope on a protected
redirect and the safe 500 for every unsafe `Location`. A parity test proves the
kernel projection answers the same status, `Location`, empty body and absent
content type as the compatibility `c.redirect()` + `c.req.query()` callback
for nine recorded query shapes. The contract suite proves truthful OpenAPI,
manual-redirect client behaviour, opaque-redirect reporting and
protocol-invalid 3xx rejection; ShipAngular's unit, type and packed
conformance fixtures cover the client result and the opaque-redirect protocol
failure.

### Consequences

- A redirect is a declared, validated operation result rather than an adapter
  rewrite, so direct execution, HTTP, OpenAPI and clients agree on it.
- The consumer gate remains the Vault Drive calendar callback (SAPI-138,
  SAPI-443): mapping it behind a default-off selector with exact
  selected-versus-compat `Location`/status/header parity and replay safety is
  consumer work, not part of this addendum.
- Browser flows that need the navigation to complete must send the browser to
  the endpoint; calling a redirect operation through Fetch in a browser is an
  explicit protocol failure, not a hidden success.
