# ADR 0002: Operation-client contract for ShipAPI integration

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** ShipAngular and ShipAPI maintainers
- **Supersedes:** the “Resolution (2026-05-08): Hono `hc()`” section of `docs/architecture/CONTRACT.md`
- **Related backend decision:** ShipAPI ADR 0001, operation-centric application kernel

## Context

ShipAngular currently treats Hono `hc<typeof app>` as the primary typed contract with ShipAPI. Applications import a type derived from a composed server route tree, create an `hc()` client, place it behind `provideShipApiClient<T>()`, and pass individual client calls to `createResource()` or `createStream()` as async thunks.

That decision was reasonable for the v4 route-first backend: it avoided a handwritten DTO client, preserved Hono inference, and shipped quickly. It also deliberately retained a generic REST URL path for third-party APIs.

ShipAPI is now adopting an operation-centric application kernel. An operation graph, rather than a composed Hono route tree, owns stable operation IDs, input/output schemas, declared errors, access policy, transaction mode, dependencies, and transport capabilities. Hono becomes one server transport adapter. The graph produces direct execution, client artifacts, OpenAPI, inventory, and diagnostics.

Continuing to use `typeof app` would make the frontend depend on an adapter the backend no longer considers its application contract. The current thunk seam also cannot reliably supply cancellation, operation metadata, shared serialization, or one request-policy implementation. Callers manually narrow Hono responses and throw `ApiError`, which turns expected API errors into exceptions and often loses status/header/request context.

The new backend direction is material new information of exactly the kind the existing contract record requires for supersession. We preserve that record as history and make the change through this ADR.

The ShipAngular owner authorized implementation on 2026-09-03 using the ShipAPI
redesign handoff as the cross-repository invariant set. Concrete generated artifact
syntax for unary JSON and primitive forms is now verified through the retained real ShipAPI
joint fixture (2026-09-08). Generated non-JSON/auth/advanced-codec syntax remains provisional;
that does not reopen the structural boundary decided here.

## Decision

### 1. The primary seam is a structural operation client

ShipAngular integrates with ShipAPI through an injected interface equivalent to:

```ts
interface OperationClient<TContract> {
  call<TId extends OperationId<TContract>>(
    operation: TId,
    input: InputOf<TContract, TId>,
    options?: OperationCallOptions
  ): Promise<OperationResultOf<TContract, TId>>;
}

interface OperationCallOptions {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  timeoutMs?: number;
}
```

Generated named methods are optional ergonomics and delegate to `call`. They are not the kernel interface.

### 2. ShipAPI owns the client-safe contract projection

Each ShipAPI application produces a deterministic browser-safe artifact from its validated operation graph. It contains or references:

- stable operation IDs independent of route nesting;
- separated path, query, header, and body input types;
- status-indexed success bodies and declared error codes;
- transport/capability metadata;
- explicit client-safe schemas/codecs for non-JSON-native values;
- a contract version or deterministic graph hash; and
- no server handler, Hono app, database, auth-provider, observability, or Node runtime dependency.

The application developer does not hand-edit the artifact. Automatic deterministic generation is acceptable and preferred over duplicated handwritten client shapes.

ShipAPI may supply the default HTTP implementation and serialization because those must match the operation transport declaration. ShipAngular consumes the structural client and does not independently reconstruct URLs or query encoding.

The `/ship-api` adapter uses ShipAPI's published `OperationClient<TContract>` as a type-only
factory boundary. Its JavaScript remains import-free, while applications using that
entrypoint must provide the optional `@sixthsummit/ship-contract` type peer. Keeping one
generic call declaration avoids a second, independently expanded input/result signature
as contracts grow. The unary policy executor rejects HTTP stream handles; streaming
responses use the separate stream capability instead of being awaited as JSON results.

### 3. Declared failures are result values

Unary operation calls return a discriminated result with status, data or typed `ShipError`, and response metadata on both branches. Declared application failures are expected values.

Cancellation, inability to reach/read the transport, invalid protocol/envelope data, and programmer errors remain exceptional and distinct. ShipAngular may convert a failed result to `ApiError<TCode>` for presentation/resource ergonomics, but that adapter retains the original status, code, details, request ID, response metadata, and unknown additive fields.

### 4. ShipAngular owns Angular integration

ShipAngular owns:

- typed Angular injection tokens and provider factories;
- browser and per-request SSR call context;
- signal/resource/mutation state and stale-result suppression;
- identity-provider integration and current credential supply;
- presentation-friendly error adaptation;
- browser upload/download/stream/socket state machines; and
- Angular testing helpers.

The SSR provider uses one request-scoped client/context and forwards only explicitly approved cookies, request ID, locale, trace headers, origin, and cancellation. It does not retain user context in a platform singleton or touch browser globals during server rendering.

### 5. ShipAPI calls use one operation-aware policy pipeline

Authentication, credentials mode, CSRF, request ID, idempotency, timeout/cancellation, metadata parsing, rate-limit handling, and retry decisions form one policy pipeline. Transport adapters such as fetch, HttpClient, XHR, stream readers, and WebSocket handshakes consume its prepared context.

Retries are conservative: safe operations only by default; unsafe operations only when the contract allows it and a stable idempotency key exists; no automatic retry for authentication/authorization denial; `Retry-After` obeyed for approved retries; backoff and I/O abortable.

Angular HttpClient interceptors may remain for independent third-party REST calls. They are not a second required implementation of ShipAPI operation policy.

### 6. Reactive APIs are explicit

ShipAngular adds `createOperationResource(client, operationId, inputFactory, options)` and a separate mutation primitive. It does not execute a supplied function merely to infer whether it is a URL or promise. The input factory participates in Angular signal tracking, and the resource passes its `AbortSignal` to the operation call.

Generic REST and arbitrary async resources remain independent, explicitly named surfaces. Third-party REST support is permanent and does not require a ShipAPI package.

### 7. Non-JSON transports are explicit capabilities

Uploads, downloads, SSE/chunk streams, and WebSockets are not forced through a unary JSON result. The contract identifies capability-specific metadata and codecs. ShipAngular provides browser adapters that share the request-policy capability while retaining transport-specific behavior such as XHR progress, ReadableStream cancellation, and WebSocket reconnect/auth refresh.

### 8. Hono v4 moves to a compatibility adapter

`HonoV4ClientAdapter` supports current consumers behind the new frontend seams. Route-tree types stay inside the consumer's legacy mapping; ShipAngular core gains no Hono runtime dependency. The adapter documents limitations and runs the same supported unary resource/result conformance cases as the target client.

Company sites currently use pinned ShipAngular versions, so the compatibility adapter supports deliberate per-site migration rather than automatic upgrades. It remains only until the site inventory is complete, every in-scope site has passed staging and production verification, and the agreed rollback window has closed. Old sites may remain pinned while migration is scheduled; the target interface will not be weakened to mimic `hc()`.

For applications with a copied URL-based client, `LegacyRestClientAdapter` applies
the same isolation rule: the
application maps stable IDs to temporary URL requests that return native `Response` objects,
while ShipAngular normalizes them into the target result contract. It does not preserve the
old message-only `Promise<T>` boundary, infer URLs, or handle binary/long-lived capabilities.

### 9. The contract is proven through packed joint fixtures

Required CI uses packed browser contract/client artifacts and a deterministic local fixture server. It includes type-negative cases, browser/SSR isolation, wire errors, cancellation, policies, codecs, uploads, downloads, streams, sockets, bundle scans, and both compatibility adapters. Source/workspace links and optional skipped smoke suites are not release evidence.

## Consequences

### Positive

- Frontend types survive server route and framework reorganization.
- ShipAPI owns serialization once, where the operation transport is declared.
- Agents select stable operations and typed inputs instead of reconstructing URLs or following fragile prompt recipes.
- Expected UI failures are exhaustive values with complete status/metadata.
- Request policy has one test surface and cannot silently diverge between HttpClient and fetch.
- Browser and SSR behavior remain Angular-owned and directly testable.
- Hono remains available as the first server adapter and as temporary client compatibility without becoming the permanent frontend kernel.
- Generic REST remains useful without ShipAPI.

### Negative

- ShipAPI must build and version deterministic client artifacts and semantic contract diffs.
- Applications need a generated contract package or equivalent build artifact.
- A compatibility layer and dual conformance period add temporary maintenance cost.
- Capability metadata/codecs require careful runtime-size control; types alone are insufficient.
- Some current public APIs will be deprecated or moved to secondary entrypoints before GA.

### Risks and mitigations

| Risk                                    | Mitigation                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Generated artifact drift                | Backend-owned deterministic generation, graph hash, checked-in or packed drift gate, exact manifest in CI. |
| Runtime metadata bloats browser         | Minimal manifest, per-operation/capability tree shaking, secondary entrypoints, per-entrypoint budgets.    |
| Contract and deployed server mismatch   | Version/hash diagnostic and deployment compatibility policy; joint skew fixtures.                          |
| Compatibility adapter becomes permanent | Explicit namespace, limitations, deprecation telemetry/census, dated removal gate.                         |
| Form schemas pull server code           | Browser-only projection; forbidden-import/tarball scan; optional adapters isolated.                        |
| Retry duplicates mutation               | Operation metadata plus stable idempotency key required; request-attempt trace tests.                      |
| SSR leaks user context                  | Fresh request injector/context and concurrent A/B isolation test.                                          |

## Alternatives considered

### Keep Hono `hc()` as the primary contract

Rejected. It preserves the dependency on route-tree composition, does not represent the transport-independent operation graph, and leaves cancellation/policy/metadata concerns outside the type contract.

### Generate only named methods

Rejected as the kernel. Named methods are useful ergonomics, but a structural `call(id, input, options)` seam is necessary for Angular DI, generic resources, conformance runners, compatibility adapters, and agent tooling.

### Let ShipAngular generate HTTP URLs from types

Rejected. Types are erased, and path/query/body serialization must be produced from the backend transport declaration to avoid two implementations. ShipAngular should not guess codecs or nested-query rules.

### Route all ShipAPI calls through Angular `HttpClient`

Rejected as a universal requirement. HttpClient is valuable for generic REST, but XHR upload progress, streaming fetch bodies, and WebSocket handshakes need transport-specific adapters. The shared layer is policy/capability, not one physical browser API.

### Throw `ApiError` for every non-2xx result

Rejected at the low-level boundary. Declared application failures are part of the operation contract and should remain typed data. Throwing remains available as a presentation convenience.

### Merge ShipAngular and ShipAPI

Rejected and out of scope. The frontend/backend split is deliberate; the browser-safe contract artifact is the boundary that makes the split reliable.

## Migration and acceptance

This ADR is accepted only when both repositories agree on the structural interface, result/metadata minimum, artifact/hash responsibility, auth/capability vocabulary, and first packed fixture. Acceptance changes the old Hono resolution to **Superseded by ADR 0002**; it does not erase the historical rationale.

Implementation follows the sequence in [../SHIPANGULAR_REDESIGN_AUDIT.md](../SHIPANGULAR_REDESIGN_AUDIT.md). Until acceptance, current v4 behavior remains supported and no documentation should falsely claim the new client is shipped. After acceptance, new ShipAPI-facing APIs target the operation seam, while old Hono examples move to compatibility documentation with a published deprecation window.

## Implementation note — 2026-10-12

The interface above records the original decision. Current `OperationCallOptions`
also supports optional `keepalive`; the operation boundary tracks Angular pending
tasks by default. See the public types and package changelog. Streams and realtime
publication have separate accepted contracts in ADRs 0004 and 0005.
