# eval-009-idempotency-and-rate-limit — enforce operation request safety

You are working in a generated ShipAngular application with a generated executor and policy
map containing safe, idempotent, and unsafe operations.

Build the application client with `createPolicyClient`. Supply an origin allowlist, a current
credential capability, request IDs, cancellation/timeout propagation, and graph-derived
operation policies. Add tests proving: a safe read obeys `Retry-After`; authentication denial
is not retried; an unsafe mutation is not retried without supported idempotency plus a stable
key; a permitted mutation reuses one key across attempts; credentials are resolved again
after an approved refresh; caller-written sensitive headers are rejected; and abort stops
backoff immediately.

Do not duplicate this ShipAPI behavior in Angular HTTP interceptors or fetch wrappers.

## Success criteria

- One policy client handles request metadata, credentials, refresh, retry, and abort.
- Retry behavior follows the operation policy rather than HTTP method guesses.
- Tests cover the safety invariants above using declared result values.
- Third-party `HttpClient` behavior remains separate.
- `pnpm run ci` passes.
