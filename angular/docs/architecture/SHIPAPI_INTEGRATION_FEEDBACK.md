# ShipAPI integration feedback

- **ShipAPI branch inspected:** `rearchitecture/agent-native-framework`
- **Committed revision inspected:** `059229c`
- **Inspection date:** 2026-09-04
- **Status:** ShipAngular's import-free adapter and synthetic conformance implementation are
  complete; a release-grade joint artifact manifest is not yet available

This record is the frontend feedback loop requested by the ShipAPI redesign handoff. The ShipAPI
checkout was treated as read-only. Source and compiled declarations were used to remove guesswork
during development, but they are not accepted as cross-repository conformance evidence. Only the
exact packed artifacts named by ShipAPI's manifest can close C1.

## Confirmed compatible decisions

The implemented ShipAPI seam and ShipAngular now agree on these concrete points:

- application types use a nested `operations` map; each operation carries `transport`,
  `input`, and a status-discriminated `result` union;
- `OperationClient.call(operationId, input, options)` is structural and excludes operations
  whose transport is not HTTP;
- input locations stay distinct and query serialization remains ShipAPI-owned;
- the runtime `ClientContract` has `schemaVersion`, `appId`, a deterministic SHA-256
  `fingerprint`, and operation success/error/transport declarations;
- client results carry a top-level request ID plus `metadata` with all readable headers,
  `Retry-After`, ETag, content type, and content disposition;
- framework errors use stable codes/statuses, and validation uses
  `details.issues[{ path, message, code? }]`; and
- the isolated `@sixthsummit/ship-contract` package is browser/edge-oriented and the application-only
  `ApplicationContractOf<typeof app>` helper remains outside the required frontend shape.

`createShipApiClientExecutor()` adapts that exact structural client into ShipAngular's
operation executor without importing ShipAPI. A strict one-off compatibility program
assigned ShipAPI's compiled `OperationClient<Contract>` and `ClientContract` directly to
the ShipAngular adapter under `exactOptionalPropertyTypes`; the durable packed fixture now
mirrors the same nested types and result metadata.

## Resolved since the prior inspection

ShipAPI revision `059229c` introduces the isolated `@sixthsummit/ship-contract` package. Frontend
consumers can now obtain the structural contract/client protocol without installing the
`@sixthsummit/ship-api` monolith and its Hono, database, provider-admin, observability, queue, or
Redis dependency graph. This resolves the former monolith package-dependency gap.

Package isolation is necessary but is not the C1 completion signal. ShipAPI must still supply the
real application-specific tarballs, checksums, graph hash, wire fixtures, and fixture-server details
in the manifest consumed by `pnpm test:joint-conformance`.

## ShipAngular requirements already reflected locally

- A separate client is cached for each `RequestCredentials` mode because ShipAPI currently
  fixes credentials at client construction while ShipAngular selects them per operation.
- The adapter validates manifest identity, operation presence, success status, result
  discriminants, error shape, and required request IDs.
- ShipAPI `metadata` is normalized into one response metadata object, including
  idempotency headers when the browser can read them.
- Declared and framework errors remain values. Unknown well-formed error/additive fields
  are retained when the structural client supplies them.
- `304` is normalized into the explicit not-modified result needed by Angular resource
  ETag caches.
- Stable `SHIP_CLIENT_*` diagnostics, aborts, and normalized ShipAngular protocol/transport
  exceptions remain exceptional rather than fabricated application failures.

## Required ShipAPI follow-up

| Gap                                    | Current evidence                                                                                                                                                                                                                  | Frontend impact                                                                                                                                   | Recommended default                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application-specific type artifact     | ShipAPI explicitly leaves its generated format/package ownership open. The CLI currently emits JSON/OpenAPI, while the precise application type is available only through backend-co-located `ApplicationContractOf<typeof app>`. | An application still cannot install exact operation types without a server/source dependency or handwritten DTOs.                                 | Generate a deterministic browser-only application package containing `AppContract`, the JSON manifest, graph fingerprint/version, and optional named-method types. Never require a frontend source link. |
| Operation request policy projection    | The manifest exposes access, transaction, and generic transport metadata but not normalized auth requirement, CSRF, safety, replayability, idempotency support, retry statuses/attempts, or auth-refresh permission.              | ShipAngular can run one safe policy pipeline, but applications must currently author the policy map and could drift from the graph.               | Project explicit client policy fields from validated operation declarations. Do not infer mutation retry safety solely from HTTP method or transaction mode.                                             |
| `304` cache revalidation               | The current default client accepts only declared 2xx successes; a `304` enters failure parsing and becomes `SHIP_CLIENT_RESPONSE_INVALID`.                                                                                        | Angular cannot implement contract-driven ETag revalidation through the default client even though its resource cache supports it.                 | Declare cache/revalidation capability and return a typed `304` metadata branch without parsing a body.                                                                                                   |
| Version-skew error preservation        | The current client rejects a well-formed but undeclared code as `SHIP_CLIENT_RESPONSE_INVALID` and discards unknown outer envelope fields.                                                                                        | A newer server error cannot reach the frontend's `declared: false` branch, and diagnostic additive data is lost before ShipAngular can retain it. | Return a well-formed unknown failure value with `declared: false` (or equivalent), preserving error and envelope extensions; reserve protocol errors for malformed envelopes/status-code violations.     |
| Idempotency response metadata          | The generic headers map may contain replay headers, but ShipAPI has no typed replay/result projection or operation idempotency declaration yet.                                                                                   | UI retry/result behavior depends on CORS exposure and handwritten header names.                                                                   | Add declared request idempotency policy and typed replay/result metadata while retaining the full header map.                                                                                            |
| Upload/SSE/socket capabilities         | The current client handles HTTP JSON, text, and binary. Multipart progress, SSE event schemas/reconnect, and socket protocol/messages/close policy are not graph capabilities yet.                                                | ShipAngular state machines exist, but generated bindings cannot yet be proven against the backend graph.                                          | Add explicit capability records and codecs; keep XHR/fetch-reader/WebSocket execution frontend-owned. Never model all three as unary JSON.                                                               |
| Joint fixture server/artifact manifest | No packed application contract/client/server manifest matching `conformance/README.md` is available yet.                                                                                                                          | `pnpm test:joint-conformance` must and does fail closed without external artifacts.                                                               | ShipAPI owns deterministic fixture generation/server and publishes tarball paths, checksums, graph hash, and wire-fixture version in one manifest.                                                       |

## Frontend semantics ShipAPI should preserve

1. Every attempt and socket reconnect must be able to obtain current credentials.
2. Abort must reach fetch/body reading; `AbortError` must not be wrapped as a declared error.
3. Response request ID is required for correlation and takes precedence over the outgoing ID.
4. Browser-readable CORS headers include request ID, retry, ETag, disposition, and
   idempotency result/replay metadata.
5. `null`, omission, empty arrays, and empty strings stay distinct through the generated
   serializer. The current bracket-array dialect is accepted as ShipAPI-owned behavior.
6. Client validators are UX only; safe server issues remain authoritative.
7. No generated package may import Hono route trees, handlers, databases, auth-provider
   admin runtimes, observability runtimes, or Node-only modules.
8. The structural client should accept an optional per-call `keepalive` flag and pass it to
   fetch `RequestInit` unchanged. ShipAngular forwards it for final `pagehide`/hidden-tab
   calls on every attempt; the client must neither set it by default nor drop it.

## Next joint checkpoint

ShipAPI should provide one packed manifest accepted by:

```bash
pnpm test:joint-conformance -- --manifest /path/to/shipapi-artifacts.json
```

The first pass should cover HTTP 200/201/204, declared/framework/unknown failures,
validation issues, metadata, auth modes, abort, timeout/retry, and package isolation. Cache,
upload, stream, and socket capabilities can then extend the same versioned fixture without
changing the structural unary seam.
