---
name: migrate-hono-to-operations
description: Use when migrating a pinned ShipAPI v4 Hono hc client, route-tree type, or createResource async thunk to ShipAngular's stable operation-client APIs. Preserves behavior through the temporary Hono adapter, then moves each feature to the packed client-safe contract.
---

# Migrate Hono v4 calls to operations

Move one behavior at a time. The target is a packed client-safe contract plus structural
`OperationClient`; generic third-party REST calls remain on the REST APIs.

## Inventory before editing

Start with a deterministic, non-mutating report:

```bash
pnpm exec ship-angular audit-migration . --format json --output ship-angular-migration.json
```

Review the report; do not treat pattern matching as an operation mapping.

For each call record:

- Hono route property and HTTP method;
- params, query, headers, and body inputs;
- success statuses and body shapes;
- handled error codes and metadata;
- authentication, CSRF, retry, idempotency, and request-ID behavior;
- cancellation, SSR, upload/download/stream/socket requirements.

Do not infer a stable operation ID from a URL. Use the ID emitted by ShipAPI's contract.

## Establish compatibility

If the generated operation client is not available yet, put the route-tree call behind
`HonoV4ClientAdapter` from `@sixthsummit/ship-angular/hono-v4`. The application-owned
mapping is the only file allowed to know Hono response and route shapes. Normalize status,
headers, request ID, declared errors, malformed responses, and cancellation there.

Do not add Hono or the ShipAPI runtime to ShipAngular itself.

## Convert a query resource

```ts
// Before: legacy thunk
readonly account = createResource(async () => {
  const response = await api.accounts[':id'].$get({
    param: { id: this.accountId() },
  });
  if (!response.ok) throw await ApiError.fromResponse(response);
  return response.json();
});

// After: operation resource
readonly account = createOperationResource(
  this.client,
  'accounts.get',
  () => ({ params: { accountId: this.accountId() } }),
);
```

Signal dependencies in the input factory are tracked. Superseded loads are aborted and
stale completions cannot replace the newest value. Handle declared failures from the
resource's failure state or use the presentation-error adapter where an exception-oriented
Angular boundary genuinely needs it.

For a new app-owned wrapper, use the `:operation-resource` schematic after confirming the
stable operation ID in the packed contract.

## Convert a mutation

```ts
const result = await this.client.call(
  'accounts.update',
  { params: { accountId }, body: changes },
  { signal, idempotencyKey }
);

if (!result.ok) {
  switch (result.error.code) {
    case 'ACCOUNT_NOT_FOUND':
      return this.showMissingAccount();
    default:
      return this.showOperationFailure(result);
  }
}
```

Keep status, headers, request ID, and unknown details. Never branch on error message text.
The `:operation-mutation` schematic provides a typed app-owned state-machine wrapper when
that is a better fit than a direct call. A final `pagehide`/hidden-tab call that previously
used raw `fetch(..., { keepalive: true })` passes `{ keepalive: true }` in the call options
instead; the boundary already holds an Angular pending task for every call, so drop any
hand-written `PendingTasks` wrapper around operation calls.

## Transport capabilities

- uploads use `/upload` and the shared credential/header capability;
- downloads distinguish JSON errors from exact binary success bytes;
- streams propagate abort and distinguish completion, abort, network, protocol, and
  declared pre-stream failure;
- sockets reevaluate auth on reconnect and remain inert during SSR.

## Verification per migrated feature

- Add or update colocated Vitest behavior tests.
- Add type-negative coverage for incorrect operation IDs and input locations where useful.
- Run `pnpm type-check`, `pnpm test`, and the application's deterministic browser tests.
- For SSR, prove concurrent requests cannot share cookies, actors, or cancellation state.
- Delete obsolete Hono imports and duplicate request-policy wrappers from the feature.

Keep the compatibility mapping until staging and production verification pass and the
agreed rollback window closes.

## See also

- `connect-shipapi`
- `docs/architecture/HONO_V4_COMPATIBILITY.md`
- `docs/architecture/decisions/0002-operation-client-contract.md`
