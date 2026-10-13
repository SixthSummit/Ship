# ADR-0011: Declare bounded request-body modes per operation

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** HTTP request-body parsing, resource limits, contract clients, and OpenAPI
- **Related:** [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0005](./0005-http-wire-and-representation-contract.md) · [ADR-0009](./0009-client-safe-contract-projections.md)

## Context

ADR-0005 fixed JSON request parsing and response representations, but real clients also send signature-sensitive raw webhooks and authenticated file uploads. Treating those as adapter middleware would hide resource limits and media types from the operation graph, generated clients, OpenAPI, migration checks, and agents.

Uploads also cross two separate security boundaries. The framework can bound transport work and reject unsupported framing, while the application must inspect the actual file bytes and apply its domain-specific sanitization policy. A filename extension or browser-provided MIME type is not proof of content.

## Decision

Every HTTP operation has one immutable request-body policy in its transport metadata:

- `json` accepts JSON and structured-suffix JSON, uses the adapter's 1 MiB default unless the operation declares `maxBytes`, and yields the decoded JSON value;
- `raw` requires an operation-specific positive `maxBytes` and non-empty media-type allowlist, and yields byte-exact `Uint8Array` data;
- `multipart` requires positive total/file/field byte limits, explicit non-negative file and field counts, at least one permitted part, and yields `FormData` only after the bounded payload parses successfully.

The Hono adapter authenticates and authorizes protected operations before reading any request body. It rejects a declared `Content-Length` above the limit immediately and otherwise reads the stream only until the total limit is exceeded. Multipart parsing begins only after the total payload has been bounded; individual file and field limits are then enforced before operation validation or handler execution.

Body policies are recursively JSON-safe transport metadata. They are copied and deeply frozen by the kernel, projected into the deterministic application graph and client-manifest fingerprint, and validated again by the runtime client.

Generated clients serialize each mode explicitly:

- JSON is stringified and receives the canonical JSON content type;
- raw bytes pass through unchanged and receive the first declared media type unless the caller supplies another allowed type;
- `FormData` passes through unchanged and the client refuses a caller-supplied `Content-Type`, allowing Fetch to generate the required multipart boundary.

OpenAPI projects the matching request media types and records the complete policy under `x-ship-request-body-policy`. Raw bodies use a binary schema. Multipart uses the operation's explicit form schema.

The framework does not claim that multipart limits sanitize files. Applications remain responsible for byte-level type detection, decoding, malware policy where required, metadata stripping or safe re-encoding, storage naming, and authorization tied to the target resource.

## Consequences

- An operation's body framing and resource budget are visible wherever the operation contract is visible.
- Authenticated uploads reject anonymous callers before spending work on multipart parsing.
- Webhook signature verification can receive the exact bytes sent by the provider.
- ShipAngular and other generated-client consumers do not need route-specific body serialization rules.
- Multipart parsing is bounded but buffered. Large streaming uploads require a separate streaming transport or direct-to-object-storage protocol.
- Total body limits bound payload size, not an exact process-memory ceiling; parser and runtime copies still require load testing at the chosen production limits.
- Domain sanitizers remain easy to find and test because they run in operation code instead of being implied by generic transport middleware.

## Rejected alternatives

### Infer the body mode from the runtime schema

Rejected because Standard Schema describes values, not HTTP framing, media-type allowlists, or resource budgets.

### Keep Multer-style parsing as route middleware

Rejected because the operation graph and clients could not see its limits or ordering, and authorization could accidentally run after parsing.

### Trust multipart MIME types and filename extensions

Rejected because both are caller-controlled metadata. The application must validate and sanitize actual bytes.

### Stream arbitrary uploads through the generic operation body

Rejected because retries, validation, ownership, cancellation, and storage cleanup need a dedicated protocol. The bounded multipart mode targets ordinary application uploads.
