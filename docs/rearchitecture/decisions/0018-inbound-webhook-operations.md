# ADR-0018: Inbound webhook operations

- **Status:** Accepted
- **Date:** 2026-09-18
- **Scope:** Inbound webhook declaration, raw-body verification, provider actors, durable receipt, idempotency, replay, retention, projection, and optional provider adapters
- **Related:** [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0010](./0010-declared-immediate-effects.md) · [ADR-0011](./0011-explicit-bounded-request-bodies.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md)

## Context

Inbound webhooks are the highest-risk ingress the framework serves: an unauthenticated third party posts bytes that trigger money movement, message delivery, or account changes. ADR-0011 made the exact signed bytes available to an operation, and ADR-0014 introduced the `provider` actor kind, the durable outbox, and executor-enforced idempotency, but it deliberately shipped the kind without the verification transport.

The compatibility line verifies with `parseWebhook(c, { provider, secret })` inside a route handler and deduplicates with an `Idempotency-Key`-keyed middleware. That composition has known weaknesses this decision must not carry forward: verification runs after body parsing and after the idempotency replay, the canonical URL for URL-signing schemes comes from the incoming request, the provider protocol table lives in the framework, and nothing records what a scheme actually guarantees. The framework requires exact signed bytes, bounded raw input, durable event identity, concurrent deduplication, and acknowledgement only at durable acceptance.

## Decision

### Declaration

`defineWebhook` in `@sixthsummit/ship-core` compiles one inbound webhook into an HTTP operation with `transport.metadata.requestBody.mode = "raw"`, a declared `maxBytes` and media-type allowlist, `access = providerAccess(providerId)`, and executor-enforced idempotency. The declaration names a `WebhookVerifierToken` (verifier plus rotatable secret source), a body policy, an idempotency policy `{ key?, windowMs, store, inFlight }`, and either an inline `handler` or `receive: { mode: "enqueue", outbox, intent, store, unitOfWork }`. Definition diagnostics carry stable `SHIP_WEBHOOK_*` codes and reject an undeclared idempotency store, a verifier without explicit guarantees, an immediate effect inside a transactional webhook, an enqueue declaration naming an intent its outbox does not declare, and a persisting webhook without retention.

### Verification contract

A `WebhookVerifier` is a pure, fixture-testable object: `{ id, guarantees: { signature, freshness, replay }, sensitiveHeaders?, verify({ headers, rawBody, method, canonicalUrl, secret, now }) }`. It returns `{ ok: true, eventId?, timestamp? }` or `{ ok: false, reason }` with a stable reason; it never throws for untrusted input and never sees ambient state. The contract lives in the kernel and is implemented with edge-safe WebCrypto helpers, so a consumer may implement a provider in its own repository without changing Ship or registering anything.

The framework prefers HMAC schemes with authenticated freshness. A dedicated, rotatable shared-secret header over HTTPS is permitted for providers that offer nothing stronger, and that verifier declares every guarantee `false` so the absence of body authentication and freshness is graph-visible. IP restriction is an optional network-edge control, never a substitute.

### Transport order and canonical URL

`@sixthsummit/ship-hono` executes webhook routes in a fixed order: no credential adapter or actor resolver runs; the body is bounded and read as exact bytes (ADR-0011); every current secret is tried against the verifier; the provider actor is constructed only after verification succeeds and carries no permissions; then the executor enforces access, claims the idempotency key, and runs the handler or durable receipt. The canonical URL handed to URL-signing schemes is the declared `publicBaseUrl` plus the operation path; `Host` and `X-Forwarded-*` are never consulted, so proxies cannot change what is verified.

Failures are stable and never echo the body or a stack: `401 WEBHOOK_VERIFICATION_FAILED`; a completed duplicate replays the stored success response; an in-flight duplicate follows the declared `inFlight` policy, either a bounded wait that replays once the first delivery completes or an immediate retry-inducing status; `503 WEBHOOK_UNAVAILABLE` (or `WEBHOOK_SECRET_UNAVAILABLE`) with `Retry-After` when the store, transaction, or secret source is unavailable, so a delivery is never accepted into process memory; `500 WEBHOOK_HANDLER_FAILED` for a handler defect, whose claim is released so the provider's retry runs fresh.

### Receive-then-process

In enqueue mode the operation runs a write transaction that records the redacted headers and exact body in the framework-owned `ship_webhook_events` table, enqueues one outbox intent carrying an event reference, links the two, and completes the idempotency claim; the `202` acknowledgement is sent only after that commit. The consumer declares the intent with `webhookIntent({ effect, perform })`, so the outbox dispatcher (or the job runner that schedules it) performs the effect later with at-least-once delivery. A crash before commit leaves nothing and the provider retry executes fresh; a crash after commit leaves a completed claim whose replay is the committed result, never a fabricated one. `defineWebhookReplay` re-enqueues a stored event under `ship.webhooks:replay`, and `defineWebhookCleanup` applies `retention: { eventsMs, claimsMs }` without ever deleting an event whose intent is still pending or claimed.

### Projection and observability

The graph, client manifest, and OpenAPI see the provider, verifier, guarantees, mode, body policy, idempotency window, in-flight policy, retention, and outbox intent through transport metadata. The browser manifest excludes webhook operations and its fingerprint is unchanged by them (ADR-0009); OpenAPI documents the provider-facing path with the raw media types under `x-ship-webhook`. A transport-neutral `WebhookObserver` receives receive outcomes and receive-to-dispatch lag; `@sixthsummit/ship-observability-otel` records them with `ship.webhook.id` and `ship.webhook.provider` attributes and never with header or body content.

### Optional adapters

`@sixthsummit/ship-webhooks` ships independent subpath verifiers for Stripe, GitHub, Slack, Twilio, Resend (Svix), HighLevel, and the shared-secret fallback. Each declares its guarantees, is tested against signed samples generated in-test with known secrets, and can be replaced by a consumer-owned verifier of the same contract. HighLevel signs with a public key (Ed25519 under `X-GHL-Signature`, legacy RSA-SHA256 under `X-WH-Signature`), so its "secret" is the published PEM public key and the verifier embeds no key.

## Consequences

- Verification, actor resolution, idempotency, and durable receipt happen in one declared order that the compatibility composition could not guarantee; the parity suite records the divergence it closes.
- Provider protocol details live outside the kernel; adding a provider is a verifier, not a framework change.
- Enqueue mode trades an extra table and an outbox intent for acknowledgements that are always backed by committed state and for replay without re-contacting the provider.
- Bounded waits hold a request open; the declared `maxMs` is the only thing standing between a slow first delivery and a provider timeout, so retry policies are the default recommendation for slow handlers.
- Redacting sensitive headers means a stored event cannot be re-verified from storage; replay trusts the original verification, which is the intended boundary.
- Scheduling cleanup and the outbox dispatcher remains the job runner's responsibility.

## Rejected alternatives

### Verify inside the handler after parsing

Rejected because verification would run after resource work and after any idempotency replay, which is the compatibility ordering this decision replaces.

### Derive the canonical URL from the request

Rejected because reverse proxies rewrite `Host` and forwarding headers; URL-signing schemes then fail or, worse, verify against an attacker-influenced URL.

### A framework provider registry

Rejected because consumers must be able to add or replace a provider without a Ship release, and a registry hides which scheme a webhook actually trusts.

### Process the event inside the receive request

Rejected as the only mode because a slow or failing effect becomes a provider retry storm; inline mode remains available for cheap, idempotent handlers.

### Embed provider public keys in the adapter

Rejected because a stale embedded key silently rejects every delivery; keys are configuration supplied through the same rotatable secret source as HMAC secrets.

## Addendum 2026-09-18: Response modes and replay transport

This addendum extends the accepted decision with response modes and replay
transport. Verification, receipt, and idempotency retain their existing boundaries.

### Context

Voice and messaging providers execute the acknowledgement. Twilio voice
routes may need to answer `200 text/xml` carrying TwiML, and status callbacks
may need to answer a bodiless `200`; a JSON body in either place is a provider error
and a dropped call. `WebhookTransport` hard-coded `response: "json"` with the
JSON content type, and `ship-hono`'s `serializeSuccess` derived `Content-Type`
solely from that transport after merging `respond({ headers })` (where
`content-type` is reserved), so no declaration could reach the wire form the
provider required; the proof papered over it with a response-rewriting
middleware. Separately, `defineWebhookReplay` produced an operation with no
HTTP transport, so `POST /webhooks/:id/retry` had to be hand-mounted around the
executor, re-implementing authentication and failure serialization outside
the adapter.

### Decision

`defineWebhook` accepts `response`, defaulting to `{ mode: "json" }` with the
existing behaviour:

- `{ mode: "text", contentType }` and `{ mode: "binary", contentType }`: the
  handler returns the document (`string` or `Uint8Array`) or
  `respond(status, body, { headers })`; the output schema is framework-owned
  and the declared content type is compiled into the transport. Declaring a
  consumer `output`, omitting `contentType`, or pairing a body with `204`/`205`
  is a `SHIP_WEBHOOK_RESPONSE_INVALID` definition diagnostic.
- `{ mode: "empty" }`: the handler returns nothing; the adapter answers the
  declared success status (default `200`) with no entity body and no content
  type. A handler that returns a body fails output validation
  (`SHIP_OPERATION_OUTPUT_INVALID`) and the provider sees the JSON `500`
  envelope, never the leaked body.
- No other mode exists for a webhook: `stream` ([ADR-0016](./0016-streaming-response-representation.md))
  is an HTTP-operation representation and is a `SHIP_WEBHOOK_RESPONSE_INVALID`
  diagnostic here. A webhook acknowledgement or replay is also never a
  declared read cache ([ADR-0019](./0019-declared-read-cache.md)): every
  delivery is a distinct event settled by verification and the idempotency
  window, so `cache` on `defineWebhook` or `defineWebhookReplay` fails with
  `SHIP_WEBHOOK_CACHE_FORBIDDEN` instead of being silently dropped.
- Enqueue mode keeps the JSON `202` acknowledgement; any other mode there is
  rejected.

The transport metadata carries `response` (`json` | `text` | `binary` |
`empty`) and `contentType` (absent for `empty`), and `webhook.response` repeats
the declaration, so the graph, `x-ship-webhook` and OpenAPI document the
provider-facing representation (`text/xml`, `application/pdf`, or no content).
The browser manifest still excludes webhooks and its fingerprint is unchanged.

`ship-hono` settles the representation from the declared transport before any
operation-supplied header is merged: the mode decides whether a body exists and
which `Content-Type` it carries; `respond({ headers })` adds safe headers around
it and `content-type` stays reserved. This is the same rule ADR-0005 states for
HTTP operations, now applied uniformly; HTTP operations' wire behaviour is
unchanged and covered by a regression test. Every failure, including those of
`text`, `binary` and `empty` webhooks, remains the JSON envelope.

`defineWebhookReplay` accepts an optional `transport`, either `{ path }` or a
JSON `http.post(...)` transport. The compiled operation is a JSON `POST`; when
the path declares `:eventId` the event id is the path parameter, otherwise it is
the JSON body `{ eventId }`. Access is unchanged (`ship.webhooks:replay` or the
declared permission), the adapter's credential adapter and actor resolver
authenticate the caller as for any operation, and the operation appears in the
client manifest and OpenAPI like any permission-gated HTTP operation. Without a
transport the operation stays executor-only as before.

### Consequences

- Providers that execute the acknowledgement are declared, not bridged; the
  proof's response-rewriting middleware is deleted.
- A `binary` acknowledgement replayed for a duplicate delivery requires an
  idempotency store that preserves bytes; the Drizzle store persists results
  as JSON, so declare `binary` only with a byte-preserving store or an
  in-memory store, or prefer `text` where the provider accepts it.
- Replay mounted through the adapter is a first-class, documented HTTP
  operation; consumers that need a different path shape declare it in
  `transport` rather than wrapping the executor.

## Addendum 2026-09-18: replay path parameter name

Replay transport previously required the literal `:eventId` path segment,
preventing applications from using a different parameter name.

The replay transport now accepts any single `:name` segment as the event id
parameter: the params schema and `WebhookReplayTransportInput<TPath>` follow
the declared name (`{ params: { id: string } }` for `/webhooks/:id/retry`), a
path with no parameter keeps the JSON body `{ eventId }` fallback, and a path
with two parameters or a malformed name is `SHIP_WEBHOOK_TRANSPORT_INVALID`.
`transport.eventIdParameter` is an optional cross-check: naming it fails
definition when the path declares another name or none. Detection is the
default because the single parameter is unambiguous; the explicit name exists
for readers of the declaration, not for the framework. Full `http.post(...)`
transports use detection only. The customized golden consumer mounts replay
at `/webhooks/:id/retry` with `eventIdParameter: "id"`.
